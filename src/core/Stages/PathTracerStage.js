import {
	Vector2, Matrix4, TextureLoader, RepeatWrapping, FloatType, NearestFilter
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';

import { TileRenderingManager } from '../Processor/TileRenderingManager.js';
import { CameraMovementOptimizer } from '../Processor/CameraMovementOptimizer.js';
import { RenderTargetManager } from '../Processor/RenderTargetManager.js';
import { PathTracerUtils } from '../Processor/PathTracerUtils.js';
import { LightDataTransfer } from '../Processor/LightDataTransfer';
import FragmentShader from '../Shaders/pathtracer.fs';
import VertexShader from '../Shaders/pathtracer.vs';
import TriangleSDF from '../Processor/TriangleSDF';
import { EnvironmentCDFBuilder } from '../Processor/EnvironmentCDFBuilder';
import blueNoiseImage from '../../../public/noise/simple_bluenoise.png';
import { DEFAULT_STATE, TEXTURE_CONSTANTS } from '../../Constants';

/**
 * PathTracerStage - Core path tracing renderer
 *
 * Refactored from PathTracerPass to use the new pipeline architecture.
 *
 * Execution: ALWAYS - Must run every frame to accumulate samples
 * This is the primary rendering stage that builds up the path traced image.
 *
 * Key changes from PathTracerPass:
 * - Extends PipelineStage instead of Pass
 * - Emits events instead of calling other passes directly
 * - Publishes MRT textures to context for downstream stages
 * - Reads adaptive sampling texture from context
 * - No direct references to asvgfPass, adaptiveSamplingPass, or tileHighlightPass
 *
 * Events emitted:
 * - pathtracer:frameComplete - When a frame finishes rendering
 * - camera:moved - When camera position/orientation changes
 * - tile:changed - When current tile changes (for TileHighlightStage)
 * - asvgf:reset - Request ASVGF to reset temporal data
 * - asvgf:updateParameters - Update ASVGF parameters
 * - asvgf:setTemporal - Enable/disable ASVGF temporal accumulation
 *
 * Textures published to context:
 * - pathtracer:color - Main color output (MRT attachment 0)
 * - pathtracer:normalDepth - Normal/depth buffer (MRT attachment 1)
 *
 * Textures read from context:
 * - adaptiveSampling:output - Adaptive sampling guidance texture
 */
export class PathTracerStage extends PipelineStage {

	constructor( renderer, scene, camera, options = {} ) {

		super( 'PathTracer', {
			...options,
			executionMode: StageExecutionMode.ALWAYS // Must run every frame
		} );

		const width = options.width || 1920;
		const height = options.height || 1080;

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.scene = scene;

		this.tileManager = new TileRenderingManager( width, height, DEFAULT_STATE.tiles );
		this.targetManager = new RenderTargetManager( width, height, renderer );

		this.sdfs = new TriangleSDF();
		this.lightDataTransfer = new LightDataTransfer();
		this.environmentCDFBuilder = new EnvironmentCDFBuilder( renderer, {
			maxCDFSize: 1024,
			minCDFSize: 256,
			adaptiveResolution: true,
			enableValidation: false,
			enableDebug: false,
			hotspotThreshold: 0.01
		} );

		// State management
		this.accumulationEnabled = true;
		this.isComplete = false;
		this.cameras = [];

		// Performance monitoring
		this.performanceMonitor = PathTracerUtils.createPerformanceMonitor();
		this.completionThreshold = 0;

		// Create shader material
		this.setupMaterial();
		this.setupBlueNoise();

		// Now that material is created, we can update completion threshold
		this.updateCompletionThreshold();

		// Initialize camera movement optimizer after material is created
		this.cameraOptimizer = new CameraMovementOptimizer( renderer, this.material, {
			enabled: DEFAULT_STATE.interactionModeEnabled,
			qualitySettings: {
				maxBounceCount: 1,
				numRaysPerPixel: 1,
				useAdaptiveSampling: false,
				useEnvMapIS: false,
				// pixelRatio: 0.25,
				enableAccumulation: false,
				enableEmissiveTriangleSampling: false, // Disable during interaction for performance
			},
			onReset: () => this.reset()
		} );

		// Cache frequently used objects
		this.tempVector2 = new Vector2();
		this.lastCameraMatrix = new Matrix4();
		this.lastProjectionMatrix = new Matrix4();
		this.environmentRotationMatrix = new Matrix4();

		this.fsQuad = new FullScreenQuad( this.material );

		// Denoising management state
		this.lastRenderMode = - 1;
		this.tileCompletionFrame = 0;
		this.renderModeChangeTimeout = null;
		this.renderModeChangeDelay = 50;
		this.pendingRenderMode = null;

		// Environment and CDF state
		this.lastCDFValidation = null;
		this.cdfBuildTime = 0;

		// Adaptive sampling state
		this.adaptiveSamplingFrameToggle = false;

		// Track interaction mode state for accumulation
		this.lastInteractionModeState = false;
		this.interactionModeChangeFrame = 0;

		// Track changes for event emission
		this.cameraChanged = false;
		this.tileChanged = false;

	}

	setupMaterial() {

		this.material = PathTracerUtils.createPathTracingMaterial( {
			vertexShader: VertexShader,
			fragmentShader: FragmentShader,
			uniforms: {
				resolution: { value: new Vector2( this.width, this.height ) },
				exposure: { value: DEFAULT_STATE.exposure },
				enableEnvironmentLight: { value: DEFAULT_STATE.enableEnvironment },
				environment: { value: this.scene.environment },
				backgroundIntensity: { value: DEFAULT_STATE.backgroundIntensity },
				showBackground: { value: DEFAULT_STATE.showBackground },
				environmentIntensity: { value: DEFAULT_STATE.environmentIntensity },
				environmentMatrix: { value: new Matrix4() },
				useEnvMapIS: { value: DEFAULT_STATE.useImportanceSampledEnvironment },
				envCDF: { value: null },
				envCDFSize: { value: new Vector2() },
				envMapTotalLuminance: { value: 1.0 },
				globalIlluminationIntensity: { value: DEFAULT_STATE.globalIlluminationIntensity },

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				enableDOF: { value: DEFAULT_STATE.enableDOF },
				focusDistance: { value: DEFAULT_STATE.focusDistance },
				focalLength: { value: DEFAULT_STATE.focalLength },
				aperture: { value: DEFAULT_STATE.aperture },
				apertureScale: { value: 1.0 },

				directionalLights: { value: null },
				pointLights: { value: null },
				spotLights: { value: null },
				areaLights: { value: null },

				frame: { value: 0 },
				maxFrames: { value: DEFAULT_STATE.maxSamples },
				maxBounceCount: { value: DEFAULT_STATE.bounces },
				numRaysPerPixel: { value: DEFAULT_STATE.samplesPerPixel },
				transmissiveBounces: { value: DEFAULT_STATE.transmissiveBounces },

				samplingTechnique: { value: DEFAULT_STATE.samplingTechnique },
				useAdaptiveSampling: { value: DEFAULT_STATE.adaptiveSampling },
				adaptiveSamplingTexture: { value: null },
				adaptiveSamplingMax: { value: DEFAULT_STATE.adaptiveSamplingMax },
				fireflyThreshold: { value: DEFAULT_STATE.fireflyThreshold },

				enableEmissiveTriangleSampling: { value: DEFAULT_STATE.enableEmissiveTriangleSampling },
				emissiveBoost: { value: DEFAULT_STATE.emissiveBoost },

				renderMode: { value: DEFAULT_STATE.renderMode },
				previousFrameTexture: { value: null },
				accumulatedFrameTexture: { value: null },

				// Accumulation uniforms
				previousAccumulatedTexture: { value: null },
				enableAccumulation: { value: true },
				accumulationAlpha: { value: 0.0 },
				cameraIsMoving: { value: false },
				hasPreviousAccumulated: { value: false },

				blueNoiseTexture: { value: null },
				blueNoiseTextureSize: { value: new Vector2() },

				visMode: { value: DEFAULT_STATE.debugMode },
				debugVisScale: { value: DEFAULT_STATE.debugVisScale },

				spheres: { value: [] },

				// Material textures
				albedoMaps: { value: null },
				emissiveMaps: { value: null },
				normalMaps: { value: null },
				bumpMaps: { value: null },
				roughnessMaps: { value: null },
				metalnessMaps: { value: null },
				displacementMaps: { value: null },

				// Geometry textures
				triangleTexture: { value: null },
				bvhTexture: { value: null },
				materialTexture: { value: null },
				emissiveTriangleTexture: { value: null },

				triangleTexSize: { value: new Vector2() },
				bvhTexSize: { value: new Vector2() },
				materialTexSize: { value: new Vector2() },
				emissiveTriangleTexSize: { value: new Vector2() },
				totalTriangleCount: { value: 0 },
				emissiveTriangleCount: { value: 0 },

				useEnvMipMap: { value: true },
				envSamplingBias: { value: 1.2 },
				maxEnvSamplingBounce: { value: 3 },
			}
		} );

	}

	setupBlueNoise() {

		const loader = new TextureLoader();
		loader.load( blueNoiseImage, ( texture ) => {

			texture.minFilter = NearestFilter;
			texture.magFilter = NearestFilter;
			texture.wrapS = RepeatWrapping;
			texture.wrapT = RepeatWrapping;
			texture.type = FloatType;
			texture.generateMipmaps = false;

			this.material.uniforms.blueNoiseTexture.value = texture;
			this.material.uniforms.blueNoiseTextureSize.value = new Vector2( texture.image.width, texture.image.height );
			this.material.needsUpdate = true;

		} );

	}

	/**
	 * Setup event listeners for pipeline events
	 */
	setupEventListeners() {

		// Listen for pipeline-wide resets
		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

		// Listen for resize events
		this.on( 'pipeline:resize', ( data ) => {

			if ( data && data.width && data.height ) {

				this.setSize( data.width, data.height );

			}

		} );

		// Listen for completion threshold changes from UI
		this.on( 'pathtracer:setCompletionThreshold', ( data ) => {

			if ( data && data.threshold !== undefined ) {

				this.completionThreshold = data.threshold;

			}

		} );

	}

	// ===== PUBLIC API METHODS (Maintain compatibility with main.js) =====

	async build( scene ) {

		this.dispose();

		await this.sdfs.buildBVH( scene );
		this.cameras = this.sdfs.cameras;

		this.material.defines.MAX_SPHERE_COUNT = this.sdfs.spheres.length;

		// Update uniforms with scene data
		this.updateSceneUniforms();
		this.updateLights();

	}

	updateSceneUniforms() {

		// Update sphere uniforms
		this.material.uniforms.spheres.value = this.sdfs.spheres;

		// Update texture uniforms
		this.material.uniforms.albedoMaps.value = this.sdfs.albedoTextures;
		this.material.uniforms.emissiveMaps.value = this.sdfs.emissiveTextures;
		this.material.uniforms.normalMaps.value = this.sdfs.normalTextures;
		this.material.uniforms.bumpMaps.value = this.sdfs.bumpTextures;
		this.material.uniforms.roughnessMaps.value = this.sdfs.roughnessTextures;
		this.material.uniforms.metalnessMaps.value = this.sdfs.metalnessTextures;
		this.material.uniforms.displacementMaps.value = this.sdfs.displacementTextures;

		// Update geometry uniforms
		this.material.uniforms.triangleTexture.value = this.sdfs.triangleTexture;
		this.material.uniforms.bvhTexture.value = this.sdfs.bvhTexture;
		this.material.uniforms.materialTexture.value = this.sdfs.materialTexture;

		// Update texture sizes
		this.material.uniforms.triangleTexSize.value.set( this.sdfs.triangleTexture.image.width, this.sdfs.triangleTexture.image.height );
		this.material.uniforms.bvhTexSize.value.set( this.sdfs.bvhTexture.image.width, this.sdfs.bvhTexture.image.height );
		this.material.uniforms.materialTexSize.value.set( this.sdfs.materialTexture.image.width, this.sdfs.materialTexture.image.height );

		// Update triangle count for emissive triangle sampling
		this.material.uniforms.totalTriangleCount.value = this.sdfs.triangleCount || 0;

		// Update emissive triangle data
		if ( this.sdfs.emissiveTriangleTexture ) {

			this.material.uniforms.emissiveTriangleTexture.value = this.sdfs.emissiveTriangleTexture;
			this.material.uniforms.emissiveTriangleTexSize.value.set(
				this.sdfs.emissiveTriangleTexture.image.width,
				this.sdfs.emissiveTriangleTexture.image.height
			);
			this.material.uniforms.emissiveTriangleCount.value = this.sdfs.emissiveTriangleCount || 0;

			console.log( `[PathTracerStage] Emissive triangle data updated: ${this.sdfs.emissiveTriangleCount} emissives` );

		} else {

			this.material.uniforms.emissiveTriangleCount.value = 0;

		}

	}

	updateLights() {

		this.lightDataTransfer.processSceneLights( this.scene, this.material );

	}

	reset( clearBuffers = true ) {

		// Reset accumulation state
		this.material.uniforms.frame.value = 0;
		this.material.uniforms.hasPreviousAccumulated.value = false;

		// Emit event to reset ASVGF instead of calling directly
		this.emit( 'asvgf:reset' );

		// Reset managers
		this.tileManager.spiralOrder = this.tileManager.generateSpiralOrder( this.tileManager.tiles );

		// Only clear targets if explicitly requested (not when exiting interaction mode)
		if ( clearBuffers ) {

			this.targetManager.clearTargets();

		}

		// Update completion threshold
		this.updateCompletionThreshold();
		this.isComplete = false;
		this.performanceMonitor.reset();

		this.lastRenderMode = - 1;
		this.tileCompletionFrame = 0;

		// Reset interaction mode tracking
		this.lastInteractionModeState = false;
		this.interactionModeChangeFrame = 0;

	}

	setTileCount( newTileCount ) {

		this.tileManager.setTileCount( newTileCount );
		this.updateCompletionThreshold();
		this.reset();

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.material.uniforms.resolution.value.set( width, height );
		this.tileManager.setSize( width, height );
		this.targetManager.setSize( width, height );

	}

	setAccumulationEnabled( enabled ) {

		this.accumulationEnabled = enabled;
		this.material.uniforms.enableAccumulation.value = enabled;
		if ( enabled ) {

			// If enabling, enable the define
			this.material.defines.ENABLE_ACCUMULATION = '';

		} else {

			// If disabling, remove the define
			delete this.material.defines.ENABLE_ACCUMULATION;

		}

		this.material.needsUpdate = true;

	}

	// ===== MANAGER DELEGATION METHODS =====

	getCurrentAccumulation() {

		return this.targetManager.getCurrentAccumulation();

	}

	getCurrentRawSample() {

		return this.targetManager.getCurrentRawSample();

	}

	getMRTTextures() {

		return this.targetManager.getMRTTextures();

	}

	enterInteractionMode() {

		this.cameraOptimizer.enterInteractionMode();

	}

	setInteractionModeEnabled( enabled ) {

		this.cameraOptimizer.setInteractionModeEnabled( enabled );

	}

	// ===== DEPRECATED PASS CONNECTIONS (Maintain backward compatibility but emit warnings) =====

	setASVGFPass( /* asvgfPass */ ) {

		console.warn( '[PathTracerStage] setASVGFPass() is deprecated. Pass connections are no longer needed with pipeline architecture.' );

	}

	setAdaptiveSamplingPass( /* adaptiveSamplingPass */ ) {

		console.warn( '[PathTracerStage] setAdaptiveSamplingPass() is deprecated. Pass connections are no longer needed with pipeline architecture.' );

	}

	setAdaptiveSamplingParameters( params ) {

		// Emit event instead of calling adaptiveSamplingPass directly
		this.emit( 'adaptiveSampling:setParameters', params );

	}

	setTileHighlightPass( /* tileHighlightPass */ ) {

		console.warn( '[PathTracerStage] setTileHighlightPass() is deprecated. Pass connections are no longer needed with pipeline architecture.' );

	}

	// ===== PROPERTY GETTERS (Maintain compatibility) =====

	get tiles() {

		return this.tileManager.tiles;

	}

	get interactionMode() {

		return this.cameraOptimizer.isInInteractionMode();

	}

	// ===== CORE RENDER METHOD =====

	render( context, writeBuffer ) {

		if ( ! this.enabled ) return;

		// Early exit conditions
		if ( this.isComplete ||
			 this.material.uniforms.frame.value >= this.completionThreshold ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

		}

		this.performanceMonitor.start();

		const uniforms = this.material.uniforms;
		const frameValue = uniforms.frame.value;
		const renderMode = uniforms.renderMode.value;

		// Get renderer from context or use stored reference
		const renderer = this.renderer || context.renderer;

		if ( ! renderer ) {

			this.warn( 'No renderer available' );
			return;

		}

		// Handle ASVGF denoising
		this.manageASVGFForRenderMode( renderMode, frameValue );

		// Handle tile rendering with the manager
		const tileInfo = this.tileManager.handleTileRendering(
			renderer,
			renderMode,
			frameValue,
			null // No longer pass tileHighlightPass - emit event instead
		);

		// Publish tile cycle completion state to context for stage execution control
		context.setState( 'tileRenderingComplete', tileInfo.isCompleteCycle );

		// Emit tile:changed event for TileHighlightStage
		if ( tileInfo.tileIndex >= 0 ) {

			const tileBounds = this.tileManager.calculateTileBounds(
				tileInfo.tileIndex,
				this.tileManager.tiles,
				this.width,
				this.height
			);

			this.emit( 'tile:changed', {
				tileIndex: tileInfo.tileIndex,
				tileBounds: tileBounds,
				renderMode: renderMode
			} );

			this.tileChanged = true;

		}

		// Update camera and movement optimization
		this.cameraChanged = this.updateCameraUniforms();
		this.cameraOptimizer.updateInteractionMode( this.cameraChanged );

		// Update accumulation state
		this.updateAccumulationUniforms( frameValue, renderMode );

		// Set previous frame texture
		const previousTextures = this.targetManager.getPreviousTextures();
		uniforms.previousFrameTexture.value = previousTextures.color;

		// Handle adaptive sampling - read from context instead of direct reference
		this.updateAdaptiveSampling( frameValue, context );

		// Render to current target (MRT with color + normal/depth)
		renderer.setRenderTarget( this.targetManager.currentTarget );
		this.fsQuad.render( renderer );

		// Copy only the color output to writeBuffer for the composer's pipeline
		// ASVGF will read the full MRT directly from our internal target
		if ( writeBuffer ) {

			// Temporarily disable scissor for full-screen copy
			const wasScissorEnabled = this.tileManager.scissorEnabled;
			if ( wasScissorEnabled ) {

				this.tileManager.disableScissor( renderer );

			}

			// Copy only color to writeBuffer (composer expects single texture)
			this.targetManager.efficientCopyColorOutput( renderer, writeBuffer, false );

			// Restore scissor state if it was enabled
			if ( wasScissorEnabled && this.tileManager.currentTileBounds ) {

				this.tileManager.enableScissorForTile( renderer, this.tileManager.currentTileBounds );

			}

		} else if ( this.renderToScreen ) {

			// When rendering to screen, copy the color output
			const wasScissorEnabled = this.tileManager.scissorEnabled;
			if ( wasScissorEnabled ) {

				this.tileManager.disableScissor( renderer );

			}

			this.targetManager.efficientCopyColorOutput( renderer, null, true );

			if ( wasScissorEnabled && this.tileManager.currentTileBounds ) {

				this.tileManager.enableScissorForTile( renderer, this.tileManager.currentTileBounds );

			}

		}

		// Publish MRT textures to context for downstream stages
		this.publishTexturesToContext( context );

		// Emit state events
		this.emitStateEvents();

		// Only increment frame counter if not at completion threshold
		if ( uniforms.frame.value < this.completionThreshold ) {

			uniforms.frame.value ++;

		} else if ( uniforms.frame.value > this.completionThreshold ) {

			// Debug log if frame counter somehow exceeded threshold
			console.warn( `PathTracerStage: Frame counter (${uniforms.frame.value}) exceeded completion threshold (${this.completionThreshold})` );

		}

		// Conditional target swap
		if ( tileInfo.shouldSwapTargets ) {

			this.targetManager.swapTargets();

		}

		this.performanceMonitor.end();

	}

	/**
	 * Publish MRT textures to pipeline context
	 * @param {PipelineContext} context - Pipeline context
	 */
	publishTexturesToContext( context ) {

		const textures = this.targetManager.getMRTTextures();

		// Publish MRT textures
		context.setTexture( 'pathtracer:color', textures.color );
		context.setTexture( 'pathtracer:normalDepth', textures.normalDepth );

		// Publish render targets for other stages if needed
		context.setRenderTarget( 'pathtracer:current', this.targetManager.currentTarget );
		context.setRenderTarget( 'pathtracer:previous', this.targetManager.previousTarget );

		// Publish state
		context.setState( 'interactionMode', this.cameraOptimizer.isInInteractionMode() );
		context.setState( 'renderMode', this.material.uniforms.renderMode.value );
		context.setState( 'tiles', this.tileManager.tiles );

	}

	/**
	 * Emit state change events
	 */
	emitStateEvents() {

		// Emit frame complete
		this.emit( 'pathtracer:frameComplete', {
			frame: this.material.uniforms.frame.value,
			isComplete: this.isComplete
		} );

		// Emit camera changed (if applicable)
		if ( this.cameraChanged ) {

			this.emit( 'camera:moved' );
			this.cameraChanged = false;

		}

		// Note: tile:changed is emitted in render() directly

	}

	updateCameraUniforms() {

		// Check if camera actually moved
		if ( ! this.lastCameraMatrix.equals( this.camera.matrixWorld ) ||
            ! this.lastProjectionMatrix.equals( this.camera.projectionMatrixInverse ) ) {

			this.material.uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
			this.material.uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

			// Cache current matrices
			this.lastCameraMatrix.copy( this.camera.matrixWorld );
			this.lastProjectionMatrix.copy( this.camera.projectionMatrixInverse );

			return true; // Camera changed

		}

		return false; // No change

	}

	updateAccumulationUniforms( frameValue, renderMode ) {

		const uniforms = this.material.uniforms;
		const currentInteractionMode = this.cameraOptimizer.isInInteractionMode();

		// Check if interaction mode state changed
		if ( currentInteractionMode !== this.lastInteractionModeState ) {

			this.lastInteractionModeState = currentInteractionMode;
			this.interactionModeChangeFrame = frameValue;

			// When ENTERING interaction mode, disable accumulation to prevent contamination
			if ( currentInteractionMode ) {

				uniforms.hasPreviousAccumulated.value = false;
				uniforms.previousAccumulatedTexture.value = null;

			}
			// When EXITING interaction mode, keep the previous accumulated result visible
			// Don't reset accumulation here - let it continue from the last good frame

		}

		if ( this.accumulationEnabled ) {

			if ( currentInteractionMode ) {

				// During interaction mode: no accumulation to avoid low-quality contamination
				uniforms.accumulationAlpha.value = 1.0;
				uniforms.hasPreviousAccumulated.value = false;
				uniforms.previousAccumulatedTexture.value = null;

			} else {

				// Normal mode: calculate proper accumulation alpha
				const effectiveFrame = frameValue - this.interactionModeChangeFrame;

				uniforms.accumulationAlpha.value = PathTracerUtils.calculateAccumulationAlpha(
					Math.max( effectiveFrame, 0 ),
					renderMode,
					this.tileManager.totalTilesCache,
					false
				);

				// Enable accumulation immediately after exiting interaction mode (frame 0)
				// This allows the first high-quality frame to blend with the previous result
				uniforms.hasPreviousAccumulated.value = effectiveFrame >= 0 && frameValue > 0;

				if ( uniforms.hasPreviousAccumulated.value ) {

					uniforms.previousAccumulatedTexture.value = this.targetManager.getPreviousTextures().color;

				} else {

					uniforms.previousAccumulatedTexture.value = null;

				}

			}

		} else {

			// Accumulation disabled
			uniforms.accumulationAlpha.value = 1.0;
			uniforms.previousAccumulatedTexture.value = null;
			uniforms.hasPreviousAccumulated.value = false;

		}

	}

	updateAdaptiveSampling( frameValue, context ) {

		const uniforms = this.material.uniforms;
		const renderMode = uniforms.renderMode.value;

		// Read adaptive sampling texture from context instead of direct reference
		const adaptiveSamplingTexture = context.getTexture( 'adaptiveSampling:output' );
		const adaptiveSamplingEnabled = adaptiveSamplingTexture !== null;

		if ( adaptiveSamplingEnabled && ! this.cameraOptimizer.isInInteractionMode() ) {

			// Configure tile mode if using tiled rendering
			const isTileMode = renderMode === 1;
			if ( isTileMode ) {

				// Get current tile bounds from tile manager
				const currentTileIndex = frameValue > 0 ? ( ( frameValue - 1 ) % this.tileManager.totalTilesCache ) : - 1;
				if ( currentTileIndex >= 0 ) {

					const tileBounds = this.tileManager.calculateTileBounds(
						currentTileIndex,
						this.tileManager.tiles,
						this.width,
						this.height
					);

					// Emit event to configure adaptive sampling tile mode
					this.emit( 'adaptiveSampling:setTileMode', {
						enabled: true,
						tileBounds: tileBounds
					} );

				} else {

					this.emit( 'adaptiveSampling:setTileMode', { enabled: false } );

				}

			} else {

				this.emit( 'adaptiveSampling:setTileMode', { enabled: false } );

			}

			// Always update the adaptive sampling texture - remove frame toggling
			uniforms.adaptiveSamplingTexture.value = adaptiveSamplingTexture;
			uniforms.adaptiveSamplingMax.value = context.getState( 'adaptiveSamplingMax' ) || DEFAULT_STATE.adaptiveSamplingMax;

			// Emit event to update adaptive sampling MRT textures
			const mrtTextures = this.targetManager.getMRTTextures();
			this.emit( 'adaptiveSampling:setTextures', {
				colorTexture: mrtTextures.color,
				normalDepthTexture: mrtTextures.normalDepth
			} );

		} else if ( this.cameraOptimizer.isInInteractionMode() ) {

			// Disable adaptive sampling during interaction
			uniforms.adaptiveSamplingTexture.value = null;

		}

	}

	updateCompletionThreshold() {

		const renderMode = this.material.uniforms.renderMode.value;
		const maxFrames = this.material.uniforms.maxFrames.value;

		this.completionThreshold = PathTracerUtils.updateCompletionThreshold(
			renderMode,
			maxFrames,
			this.tileManager.totalTilesCache
		);

	}

	// ===== ASVGF DENOISING MANAGEMENT =====

	manageASVGFForRenderMode( renderMode, frameValue ) {

		// Only process render mode changes if actually different
		if ( renderMode !== this.lastRenderMode ) {

			// Debounce rapid render mode changes
			if ( this.renderModeChangeTimeout ) {

				clearTimeout( this.renderModeChangeTimeout );

			}

			this.pendingRenderMode = renderMode;

			this.renderModeChangeTimeout = setTimeout( () => {

				if ( this.pendingRenderMode !== null && this.pendingRenderMode !== this.lastRenderMode ) {

					this.lastRenderMode = this.pendingRenderMode;
					this.onRenderModeChanged( this.pendingRenderMode );

				}

				this.renderModeChangeTimeout = null;
				this.pendingRenderMode = null;

			}, this.renderModeChangeDelay );

		}

		if ( renderMode === 1 ) { // Tiled rendering

			this.handleTiledASVGF( frameValue );

		} else { // Full quad rendering

			this.handleFullQuadASVGF( frameValue );

		}

	}

	onRenderModeChanged( newMode ) {

		if ( newMode === 1 ) {

			// Switching to tiled - prepare ASVGF
			this.emit( 'asvgf:updateParameters', {
				enableDebug: false, // Disable debug during tiles
				temporalAlpha: 0.15 // Slightly higher for tile transitions
			} );

		} else {

			// Switching to full quad - optimize for temporal consistency
			this.emit( 'asvgf:updateParameters', {
				temporalAlpha: 0.1, // Normal temporal blending
			} );

		}

		// Reset ASVGF temporal data when switching modes
		this.emit( 'asvgf:reset' );

	}

	handleTiledASVGF( frameValue ) {

		const isFirstFrame = frameValue === 0;
		const currentTileIndex = isFirstFrame ? - 1 : ( ( frameValue - 1 ) % this.tileManager.totalTilesCache );
		const isLastTileInSample = currentTileIndex === this.tileManager.totalTilesCache - 1;

		if ( isFirstFrame ) {

			// Full screen first frame - enable temporal
			this.emit( 'asvgf:setTemporal', { enabled: true } );

		} else if ( isLastTileInSample ) {

			// Last tile of sample - enable full temporal processing
			this.emit( 'asvgf:setTemporal', { enabled: true } );
			this.tileCompletionFrame = frameValue;

		} else {

			// Middle of tile sequence - spatial only
			this.emit( 'asvgf:setTemporal', { enabled: false } );

		}

	}

	handleFullQuadASVGF() {

		// Full quad mode - always enable temporal
		this.emit( 'asvgf:setTemporal', { enabled: true } );

	}

	// ===== ENVIRONMENT MANAGEMENT =====

	async buildEnvironmentCDF() {

		if ( ! this.scene.environment ) {

			// Clear existing CDF if no environment
			this.material.uniforms.envCDF.value = null;
			this.material.uniforms.useEnvMapIS.value = false;
			this.material.uniforms.envMapTotalLuminance.value = 1.0;
			return;

		}

		try {

			const startTime = performance.now();

			// Build CDF with improved algorithm
			const result = await this.environmentCDFBuilder.buildEnvironmentCDF( this.scene.environment );

			this.cdfBuildTime = performance.now() - startTime;

			if ( result ) {

				// Update shader uniforms
				this.material.uniforms.envCDF.value = result.cdfTexture;
				this.material.uniforms.envCDFSize.value.set( result.cdfSize.width, result.cdfSize.height );
				this.material.uniforms.useEnvMapIS.value = true;
				this.material.uniforms.envMapTotalLuminance.value = result.debugInfo?.luminanceStats?.total || 1.0;

				if ( this.environmentCDFBuilder.options.enableValidation ) {

					// Store validation results for debugging
					this.lastCDFValidation = result.validationResults;

					// Log build information
					console.log( `Environment CDF built in ${this.cdfBuildTime.toFixed( 2 )}ms (${result.cdfSize.width}x${result.cdfSize.height})` );

				}

			} else {

				// Fallback to uniform sampling
				this.material.uniforms.useEnvMapIS.value = false;
				this.material.uniforms.envMapTotalLuminance.value = 1.0;
				console.warn( 'Failed to build environment CDF, using uniform sampling' );

			}

		} catch ( error ) {

			console.error( 'Error building environment CDF:', error );
			this.material.uniforms.useEnvMapIS.value = false;
			this.material.uniforms.envMapTotalLuminance.value = 1.0;

		}

	}

	async setEnvironmentMap( envMap ) {

		this.scene.environment = envMap;
		this.material.uniforms.environment.value = envMap;
		if ( envMap ) {

			// Rebuild CDF asynchronously
			await this.buildEnvironmentCDF();

		} else {

			this.material.uniforms.envCDF.value = null;
			this.material.uniforms.useEnvMapIS.value = false;
			this.material.uniforms.envMapTotalLuminance.value = 1.0;

		}

		this.reset();

	}

	setEnvironmentRotation( rotationDegrees ) {

		const rotationRadians = rotationDegrees * ( Math.PI / 180 );
		this.environmentRotationMatrix.makeRotationY( rotationRadians );
		this.material.uniforms.environmentMatrix.value.copy( this.environmentRotationMatrix );

	}

	// ===== MATERIAL MANAGEMENT =====

	updateTextureTransform( materialIndex, textureName, transformMatrix ) {

		if ( ! this.material.uniforms.materialTexture.value ) {

			console.warn( "Material texture not available" );
			return;

		}

		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const data = this.material.uniforms.materialTexture.value.image.data;
		const stride = materialIndex * dataLengthPerMaterial;

		// Map texture names to their transform locations in the material data
		const transformOffsets = {
			'map': 52,						// Pixel 14-15: Map matrix
			'normalMap': 60,				// Pixel 16-17: Normal map matrix
			'roughnessMap': 68,				// Pixel 18-19: Roughness map matrix
			'metalnessMap': 76,				// Pixel 20-21: Metalness map matrix
			'emissiveMap': 84,				// Pixel 22-23: Emissive map matrix
			'bumpMap': 92,					// Pixel 24-25: Bump map matrix
			'displacementMap': 100			// Pixel 26-27: Displacement map matrix
		};

		const offset = transformOffsets[ textureName ];
		if ( offset === undefined ) {

			console.warn( `Unknown texture name for transform update: ${textureName}` );
			return;

		}

		// Store the 3x3 transform matrix in the data texture
		// Matrix is stored as [m00, m01, m02, m10, m11, m12, m20, m21, m22]
		for ( let i = 0; i < 9; i ++ ) {

			if ( stride + offset + i < data.length ) {

				data[ stride + offset + i ] = transformMatrix[ i ];

			}

		}

		// Mark texture for update
		this.material.uniforms.materialTexture.value.needsUpdate = true;
		this.reset();

	}

	updateMaterial( materialIndex, material ) {

		// Create a complete material object using GeometryExtractor's logic
		const completeMaterialData = this.sdfs.geometryExtractor.createMaterialObject( material );

		// Update the material data texture with the complete material
		this.updateMaterialDataFromObject( materialIndex, completeMaterialData );

	}

	updateMaterialProperty( materialIndex, property, value ) {

		// Direct property update - much more efficient for single changes
		const data = this.material.uniforms.materialTexture.value.image.data;
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const stride = materialIndex * dataLengthPerMaterial;

		switch ( property ) {

			case 'color':
				if ( value.r !== undefined ) {

					data[ stride + 0 ] = value.r;
					data[ stride + 1 ] = value.g;
					data[ stride + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 0 ] = value[ 0 ];
					data[ stride + 1 ] = value[ 1 ];
					data[ stride + 2 ] = value[ 2 ];

				}

				break;
			case 'metalness': 			data[ stride + 3 ] = value; break;
			case 'emissive':
				if ( value.r !== undefined ) {

					data[ stride + 4 ] = value.r;
					data[ stride + 5 ] = value.g;
					data[ stride + 6 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 4 ] = value[ 0 ];
					data[ stride + 5 ] = value[ 1 ];
					data[ stride + 6 ] = value[ 2 ];

				}

				break;
			case 'roughness': 			data[ stride + 7 ] = value; break;
			case 'ior': 				data[ stride + 8 ] = value; break;
			case 'transmission': 		data[ stride + 9 ] = value; break;
			case 'thickness': 			data[ stride + 10 ] = value; break;
			case 'emissiveIntensity': 	data[ stride + 11 ] = value; break;
			case 'attenuationColor':
				if ( value.r !== undefined ) {

					data[ stride + 12 ] = value.r;
					data[ stride + 13 ] = value.g;
					data[ stride + 14 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 12 ] = value[ 0 ];
					data[ stride + 13 ] = value[ 1 ];
					data[ stride + 14 ] = value[ 2 ];

				}

				break;
			case 'attenuationDistance': data[ stride + 15 ] = value; break;
			case 'dispersion': 			data[ stride + 16 ] = value; break;
			case 'visible': 			data[ stride + 17 ] = value; break;
			case 'sheen': 				data[ stride + 18 ] = value; break;
			case 'sheenRoughness': 		data[ stride + 19 ] = value; break;
			case 'sheenColor':
				if ( value.r !== undefined ) {

					data[ stride + 20 ] = value.r;
					data[ stride + 21 ] = value.g;
					data[ stride + 22 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 20 ] = value[ 0 ];
					data[ stride + 21 ] = value[ 1 ];
					data[ stride + 22 ] = value[ 2 ];

				}

				break;
			case 'specularIntensity': 	data[ stride + 24 ] = value; break;
			case 'specularColor':
				if ( value.r !== undefined ) {

					data[ stride + 25 ] = value.r;
					data[ stride + 26 ] = value.g;
					data[ stride + 27 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 25 ] = value[ 0 ];
					data[ stride + 26 ] = value[ 1 ];
					data[ stride + 27 ] = value[ 2 ];

				}

				break;
			case 'iridescence': 		data[ stride + 28 ] = value; break;
			case 'iridescenceIOR': 		data[ stride + 29 ] = value; break;
			case 'iridescenceThicknessRange':
				if ( Array.isArray( value ) ) {

					data[ stride + 30 ] = value[ 0 ];
					data[ stride + 31 ] = value[ 1 ];

				}

				break;
			case 'clearcoat': 			data[ stride + 38 ] = value; break;
			case 'clearcoatRoughness': 	data[ stride + 39 ] = value; break;
			case 'opacity': 			data[ stride + 40 ] = value; break;
			case 'side': 				data[ stride + 41 ] = value; break;
			case 'transparent': 		data[ stride + 42 ] = value; break;
			case 'alphaTest': 			data[ stride + 43 ] = value; break;
			case 'alphaMode': 			data[ stride + 44 ] = value; break;
			case 'depthWrite': 			data[ stride + 45 ] = value; break;
			case 'normalScale':
				if ( value.x !== undefined ) {

					data[ stride + 46 ] = value.x;
					data[ stride + 47 ] = value.y;

				} else if ( typeof value === 'number' ) {

					data[ stride + 46 ] = value;
					data[ stride + 47 ] = value;

				}

				break;
			case 'bumpScale': 			data[ stride + 48 ] = value; break;
			case 'displacementScale': 	data[ stride + 49 ] = value; break;
			default:
				console.warn( `Unknown material property: ${property}` );
				return;

		}

		// Mark texture for update
		this.material.uniforms.materialTexture.value.needsUpdate = true;
		this.reset();

	}

	updateMaterialDataFromObject( materialIndex, materialData ) {

		// Update all material properties in the texture
		const data = this.material.uniforms.materialTexture.value.image.data;
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const stride = materialIndex * dataLengthPerMaterial;

		// Base material properties
		if ( materialData.color ) {

			data[ stride + 0 ] = materialData.color.r ?? materialData.color[ 0 ] ?? 1;
			data[ stride + 1 ] = materialData.color.g ?? materialData.color[ 1 ] ?? 1;
			data[ stride + 2 ] = materialData.color.b ?? materialData.color[ 2 ] ?? 1;

		}

		data[ stride + 3 ] = materialData.metalness ?? 0;

		if ( materialData.emissive ) {

			data[ stride + 4 ] = materialData.emissive.r ?? materialData.emissive[ 0 ] ?? 0;
			data[ stride + 5 ] = materialData.emissive.g ?? materialData.emissive[ 1 ] ?? 0;
			data[ stride + 6 ] = materialData.emissive.b ?? materialData.emissive[ 2 ] ?? 0;

		}

		data[ stride + 7 ] = materialData.roughness ?? 1;
		data[ stride + 8 ] = materialData.ior ?? 1.5;
		data[ stride + 9 ] = materialData.transmission ?? 0;
		data[ stride + 10 ] = materialData.thickness ?? 0.1;
		data[ stride + 11 ] = materialData.emissiveIntensity ?? 1;

		if ( materialData.attenuationColor ) {

			data[ stride + 12 ] = materialData.attenuationColor.r ?? materialData.attenuationColor[ 0 ] ?? 1;
			data[ stride + 13 ] = materialData.attenuationColor.g ?? materialData.attenuationColor[ 1 ] ?? 1;
			data[ stride + 14 ] = materialData.attenuationColor.b ?? materialData.attenuationColor[ 2 ] ?? 1;

		}

		data[ stride + 15 ] = materialData.attenuationDistance ?? Infinity;
		data[ stride + 16 ] = materialData.dispersion ?? 0;
		data[ stride + 17 ] = materialData.visible ?? 1;
		data[ stride + 18 ] = materialData.sheen ?? 0;
		data[ stride + 19 ] = materialData.sheenRoughness ?? 1;

		if ( materialData.sheenColor ) {

			data[ stride + 20 ] = materialData.sheenColor.r ?? materialData.sheenColor[ 0 ] ?? 0;
			data[ stride + 21 ] = materialData.sheenColor.g ?? materialData.sheenColor[ 1 ] ?? 0;
			data[ stride + 22 ] = materialData.sheenColor.b ?? materialData.sheenColor[ 2 ] ?? 0;

		}

		data[ stride + 24 ] = materialData.specularIntensity ?? 1;

		if ( materialData.specularColor ) {

			data[ stride + 25 ] = materialData.specularColor.r ?? materialData.specularColor[ 0 ] ?? 1;
			data[ stride + 26 ] = materialData.specularColor.g ?? materialData.specularColor[ 1 ] ?? 1;
			data[ stride + 27 ] = materialData.specularColor.b ?? materialData.specularColor[ 2 ] ?? 1;

		}

		data[ stride + 28 ] = materialData.iridescence ?? 0;
		data[ stride + 29 ] = materialData.iridescenceIOR ?? 1.3;

		if ( materialData.iridescenceThicknessRange ) {

			data[ stride + 30 ] = materialData.iridescenceThicknessRange[ 0 ] ?? 100;
			data[ stride + 31 ] = materialData.iridescenceThicknessRange[ 1 ] ?? 400;

		}

		data[ stride + 38 ] = materialData.clearcoat ?? 0;
		data[ stride + 39 ] = materialData.clearcoatRoughness ?? 0;
		data[ stride + 40 ] = materialData.opacity ?? 1;
		data[ stride + 41 ] = materialData.side ?? 0;
		data[ stride + 42 ] = materialData.transparent ?? 0;
		data[ stride + 43 ] = materialData.alphaTest ?? 0;

		data[ stride + 46 ] = materialData.normalScale ?? 1;
		data[ stride + 48 ] = materialData.bumpScale ?? 1;
		data[ stride + 49 ] = materialData.displacementScale ?? 1;

		// Mark texture for update
		this.material.uniforms.materialTexture.value.needsUpdate = true;
		this.reset();

	}

	updateMaterialDataTexture( materialIndex, property, value ) {

		// Delegate to the more efficient updateMaterialProperty method
		this.updateMaterialProperty( materialIndex, property, value );

	}

	rebuildMaterialDataTexture( materialIndex, material ) {

		// Use the new updateMaterial method for consistency
		this.updateMaterial( materialIndex, material );

	}

	// ===== UTILITY METHODS =====

	updateUniforms( updates ) {

		const hasChanges = PathTracerUtils.validateAndUpdateUniforms( this.material, updates );

		if ( hasChanges ) {

			this.reset();

		}

	}

	dispose() {

		// Clean up scissor state
		if ( this.tileManager.scissorEnabled ) {

			this.tileManager.disableScissor( this.renderer );

		}

		// Clear render mode change timeout
		if ( this.renderModeChangeTimeout ) {

			clearTimeout( this.renderModeChangeTimeout );
			this.renderModeChangeTimeout = null;

		}

		// Dispose managers
		this.tileManager.dispose();
		this.targetManager.dispose();
		this.cameraOptimizer.dispose();

		// Dispose remaining resources
		this.material.uniforms.albedoMaps.value?.dispose();
		this.material.uniforms.emissiveMaps.value?.dispose();
		this.material.uniforms.normalMaps.value?.dispose();
		this.material.uniforms.bumpMaps.value?.dispose();
		this.material.uniforms.roughnessMaps.value?.dispose();
		this.material.uniforms.metalnessMaps.value?.dispose();
		this.material.uniforms.triangleTexture.value?.dispose();
		this.material.uniforms.bvhTexture.value?.dispose();
		this.material.uniforms.materialTexture.value?.dispose();
		this.material.uniforms.envCDF.value?.dispose();
		this.material.dispose();
		this.fsQuad.dispose();

	}

	async rebuildMaterials( scene ) {

		if ( ! this.sdfs ) {

			throw new Error( "Scene not built yet. Call build() first." );

		}

		try {

			console.log( 'PathTracer: Starting material rebuild...' );

			// Rebuild materials and textures only
			await this.sdfs.rebuildMaterials( scene );

			// Update scene uniforms with new material data
			this.updateSceneUniforms();

			// Update lights in case any emissive materials changed
			this.updateLights();

			// Force material needsUpdate to ensure GPU upload
			this.material.needsUpdate = true;

			// Reset accumulation to apply changes
			this.reset();

			console.log( 'PathTracer materials rebuilt successfully' );

		} catch ( error ) {

			console.error( 'Error rebuilding PathTracer materials:', error );

			// Try to recover by forcing a complete reset
			try {

				console.warn( 'Attempting recovery by resetting path tracer...' );
				this.reset();

			} catch ( recoveryError ) {

				console.error( 'Recovery failed:', recoveryError );

			}

			throw error;

		}

	}

}
