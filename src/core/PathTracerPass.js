import {
	Vector2, Matrix4, TextureLoader, RepeatWrapping, FloatType, NearestFilter, GLSL3
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

import { TileRenderingManager } from './Processor/TileRenderingManager.js';
import { InteractionModeController } from './Processor/InteractionModeController.js';
import { RenderTargetManager } from './Processor/RenderTargetManager.js';
import { PathTracerUtils } from './Processor/PathTracerUtils.js';
import { LightDataTransfer } from './Processor/LightDataTransfer';
import FragmentShader from './Shaders/pathtracer.fs';
import VertexShader from './Shaders/pathtracer.vs';
import TriangleSDF from './Processor/TriangleSDF';
import { EnvironmentCDFBuilder } from './Processor/EnvironmentCDFBuilder';
import blueNoiseImage from '../../public/noise/simple_bluenoise.png';
import { DEFAULT_STATE } from '../Constants';

export class PathTracerPass extends Pass {

	constructor( renderer, scene, camera, width, height ) {

		super();

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.scene = scene;
		this.name = 'PathTracerPass';

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

		// Pass connections
		this.asvgfPass = null;
		this.adaptiveSamplingPass = null;
		this.tileHighlightPass = null;

		// Performance monitoring
		this.performanceMonitor = PathTracerUtils.createPerformanceMonitor();
		this.completionThreshold = 0;

		// Create shader material
		this.setupMaterial();
		this.setupBlueNoise();

		// Now that material is created, we can update completion threshold
		this.updateCompletionThreshold();

		// Initialize interaction controller after material is created
		this.interactionController = new InteractionModeController( renderer, this.material, {
			enabled: DEFAULT_STATE.interactionModeEnabled,
			qualitySettings: {
				maxBounceCount: 1,
				numRaysPerPixel: 1,
				useAdaptiveSampling: false,
				useEnvMapIS: false,
				pixelRatio: 0.25,
				enableAccumulation: false,
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
				globalIlluminationIntensity: { value: DEFAULT_STATE.globalIlluminationIntensity * Math.PI },

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

				// Geometry textures
				triangleTexture: { value: null },
				bvhTexture: { value: null },
				materialTexture: { value: null },

				triangleTexSize: { value: new Vector2() },
				bvhTexSize: { value: new Vector2() },
				materialTexSize: { value: new Vector2() },

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

		// Update geometry uniforms
		this.material.uniforms.triangleTexture.value = this.sdfs.triangleTexture;
		this.material.uniforms.bvhTexture.value = this.sdfs.bvhTexture;
		this.material.uniforms.materialTexture.value = this.sdfs.materialTexture;

		// Update texture sizes
		this.material.uniforms.triangleTexSize.value.set( this.sdfs.triangleTexture.image.width, this.sdfs.triangleTexture.image.height );
		this.material.uniforms.bvhTexSize.value.set( this.sdfs.bvhTexture.image.width, this.sdfs.bvhTexture.image.height );
		this.material.uniforms.materialTexSize.value.set( this.sdfs.materialTexture.image.width, this.sdfs.materialTexture.image.height );

	}

	updateLights() {

		this.lightDataTransfer.processSceneLights( this.scene, this.material );

	}

	reset() {

		// Reset accumulation state
		this.material.uniforms.frame.value = 0;
		this.material.uniforms.hasPreviousAccumulated.value = false;

		if ( this.asvgfPass ) this.asvgfPass.reset();

		// Reset managers
		this.tileManager.spiralOrder = this.tileManager.generateSpiralOrder( this.tileManager.tiles );
		this.targetManager.clearTargets();

		// Update completion threshold
		this.updateCompletionThreshold();
		this.isComplete = false;
		this.performanceMonitor.reset();

		this.lastRenderMode = - 1;
		this.tileCompletionFrame = 0;

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

		this.interactionController.enterInteractionMode();

	}

	setInteractionModeEnabled( enabled ) {

		this.interactionController.setInteractionModeEnabled( enabled );

	}

	// ===== PASS CONNECTIONS (Maintain compatibility) =====

	setASVGFPass( asvgfPass ) {

		this.asvgfPass = asvgfPass;

	}

	setAdaptiveSamplingPass( adaptiveSamplingPass ) {

		this.adaptiveSamplingPass = adaptiveSamplingPass;

	}

	setTileHighlightPass( tileHighlightPass ) {

		this.tileHighlightPass = tileHighlightPass;

	}

	// ===== PROPERTY GETTERS (Maintain compatibility) =====

	get tiles() {

		return this.tileManager.tiles;

	}

	get interactionMode() {

		return this.interactionController.isInInteractionMode();

	}

	// ===== CORE RENDER METHOD =====

	render( renderer, writeBuffer, readBuffer ) {

		// Early exit conditions
		if ( ! this.enabled || this.isComplete ||
			 this.material.uniforms.frame.value >= this.completionThreshold ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

		}

		this.performanceMonitor.start();

		const uniforms = this.material.uniforms;
		const frameValue = uniforms.frame.value;
		const renderMode = uniforms.renderMode.value;

		// Handle ASVGF denoising
		this.manageASVGFForRenderMode( renderMode, frameValue );

		// Handle tile rendering with the manager
		const tileInfo = this.tileManager.handleTileRendering(
			renderer,
			renderMode,
			frameValue,
			this.tileHighlightPass
		);

		// Update camera and interaction
		const cameraChanged = this.updateCameraUniforms();
		this.interactionController.updateInteractionMode( cameraChanged );

		// Update accumulation state
		this.updateAccumulationUniforms( frameValue, renderMode );

		// Set previous frame texture
		const previousTextures = this.targetManager.getPreviousTextures();
		uniforms.previousFrameTexture.value = previousTextures.color;

		// Handle adaptive sampling
		this.updateAdaptiveSampling( frameValue );

		// Render to current target
		renderer.setRenderTarget( this.targetManager.currentTarget );
		this.fsQuad.render( renderer );

		// Copy to output buffer
		if ( writeBuffer || this.renderToScreen ) {

			// Temporarily disable scissor for final copy to ensure full image is copied
			const wasScissorEnabled = this.tileManager.scissorEnabled;
			if ( wasScissorEnabled ) {

				this.tileManager.disableScissor( renderer );

			}

			this.targetManager.efficientCopyColorOutput( renderer, writeBuffer, this.renderToScreen );

			// Restore scissor state if it was enabled
			if ( wasScissorEnabled && this.tileManager.currentTileBounds ) {

				this.tileManager.enableScissorForTile( renderer, this.tileManager.currentTileBounds );

			}

		}

		uniforms.frame.value ++;

		// Conditional target swap
		if ( tileInfo.shouldSwapTargets ) {

			this.targetManager.swapTargets();

		}

		this.performanceMonitor.end();

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

		if ( this.accumulationEnabled && ! this.interactionController.isInInteractionMode() ) {

			uniforms.accumulationAlpha.value = PathTracerUtils.calculateAccumulationAlpha(
				frameValue,
				renderMode,
				this.tileManager.totalTilesCache
			);
			uniforms.hasPreviousAccumulated.value = frameValue >= 1;
			uniforms.previousAccumulatedTexture.value = this.targetManager.getPreviousTextures().color;

		} else {

			// During interaction, no accumulation
			uniforms.accumulationAlpha.value = 1.0;
			uniforms.previousAccumulatedTexture.value = null;
			uniforms.hasPreviousAccumulated.value = false;

		}

	}

	updateAdaptiveSampling( frameValue ) {

		const uniforms = this.material.uniforms;

		if ( this.adaptiveSamplingPass?.enabled && ! this.interactionController.isInInteractionMode() ) {

			this.adaptiveSamplingFrameToggle = ! this.adaptiveSamplingFrameToggle;
			if ( this.adaptiveSamplingFrameToggle ) {

				uniforms.adaptiveSamplingTexture.value = this.adaptiveSamplingPass.renderTarget.texture;
				uniforms.adaptiveSamplingMax.value = this.adaptiveSamplingPass.adaptiveSamplingMax;

				// Set MRT textures for adaptive sampling
				const mrtTextures = this.targetManager.getMRTTextures();
				this.adaptiveSamplingPass.setTextures(
					mrtTextures.color,
					mrtTextures.normalDepth
				);

			}

		} else if ( this.interactionController.isInInteractionMode() ) {

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

		if ( ! this.asvgfPass ) return;

		if ( newMode === 1 ) {

			// Switching to tiled - prepare ASVGF
			this.asvgfPass.updateParameters( {
				enableDebug: false, // Disable debug during tiles
				temporalAlpha: 0.15 // Slightly higher for tile transitions
			} );

		} else {

			// Switching to full quad - optimize for temporal consistency
			this.asvgfPass.updateParameters( {
				temporalAlpha: 0.1, // Normal temporal blending
			} );

		}

		// Reset ASVGF temporal data when switching modes
		this.asvgfPass.reset();

	}

	handleTiledASVGF( frameValue ) {

		const isFirstFrame = frameValue === 0;
		const currentTileIndex = isFirstFrame ? - 1 : ( ( frameValue - 1 ) % this.tileManager.totalTilesCache );
		const isLastTileInSample = currentTileIndex === this.tileManager.totalTilesCache - 1;

		if ( isFirstFrame ) {

			// Full screen first frame - enable temporal
			this.asvgfPass.setTemporalEnabled && this.asvgfPass.setTemporalEnabled( true );

		} else if ( isLastTileInSample ) {

			// Last tile of sample - enable full temporal processing
			this.asvgfPass.setTemporalEnabled && this.asvgfPass.setTemporalEnabled( true );
			this.tileCompletionFrame = frameValue;

		} else {

			// Middle of tile sequence - spatial only
			this.asvgfPass.setTemporalEnabled && this.asvgfPass.setTemporalEnabled( false );

		}

	}

	handleFullQuadASVGF( frameValue ) {

		// Full quad mode - always enable temporal
		this.asvgfPass.setTemporalEnabled && this.asvgfPass.setTemporalEnabled( true );

	}

	// ===== ENVIRONMENT MANAGEMENT =====

	async buildEnvironmentCDF() {

		if ( ! this.scene.environment ) {

			// Clear existing CDF if no environment
			this.material.uniforms.envCDF.value = null;
			this.material.uniforms.useEnvMapIS.value = false;
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

				if ( this.environmentCDFBuilder.options.enableValidation ) {

					// Store validation results for debugging
					this.lastCDFValidation = result.validationResults;

					// Log build information
					console.log( `Environment CDF built in ${this.cdfBuildTime.toFixed( 2 )}ms (${result.cdfSize.width}x${result.cdfSize.height})` );

				}

			} else {

				// Fallback to uniform sampling
				this.material.uniforms.useEnvMapIS.value = false;
				console.warn( 'Failed to build environment CDF, using uniform sampling' );

			}

		} catch ( error ) {

			console.error( 'Error building environment CDF:', error );
			this.material.uniforms.useEnvMapIS.value = false;

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

		}

		this.reset();

	}

	setEnvironmentRotation( rotationDegrees ) {

		const rotationRadians = rotationDegrees * ( Math.PI / 180 );
		this.environmentRotationMatrix.makeRotationY( rotationRadians );
		this.material.uniforms.environmentMatrix.value.copy( this.environmentRotationMatrix );

	}

	// ===== MATERIAL MANAGEMENT =====

	updateDirectionalLightAngle( lightIndex, angleInRadians ) {

		// Update the directional lights uniform array
		const directionalLights = this.material.uniforms.directionalLights.value;
		if ( directionalLights && lightIndex < directionalLights.length / 8 ) {

			// Each directional light uses 8 floats, angle is at offset 7
			const baseIndex = lightIndex * 8;
			directionalLights[ baseIndex + 7 ] = angleInRadians;
			this.material.uniforms.directionalLights.needsUpdate = true;

		}

	}

	updateMaterialDataTexture( materialIndex, property, value ) {

		const data = this.material.uniforms.materialTexture.value.image.data;
		const stride = materialIndex * 96; // 24 pixels * 4 components per pixel

		switch ( property ) {

			case 'color': 				data.set( [ value.r, value.g, value.b ], stride + 0 ); break;
			case 'metalness': 			data[ stride + 3 ] = value; break;
			case 'emissive': 			data.set( [ value.r, value.g, value.b ], stride + 4 ); break;
			case 'roughness': 			data[ stride + 7 ] = value; break;
			case 'ior': 				data[ stride + 8 ] = value; break;
			case 'transmission': 		data[ stride + 9 ] = value; break;
			case 'thickness': 			data[ stride + 10 ] = value; break;
			case 'emissiveIntensity': 	data[ stride + 11 ] = value; break;
			case 'attenuationColor': 	data.set( [ value.r, value.g, value.b ], stride + 12 ); break;
			case 'attenuationDistance': data[ stride + 15 ] = value; break;
			case 'dispersion': 			data[ stride + 16 ] = value; break;
			case 'visible': 			data[ stride + 17 ] = value; break;
			case 'sheen': 				data[ stride + 18 ] = value; break;
			case 'sheenRoughness': 		data[ stride + 19 ] = value; break;
			case 'sheenColor': 			data.set( [ value.r, value.g, value.b ], stride + 20 ); break;
			case 'specularIntensity': 	data[ stride + 24 ] = value; break;
			case 'specularColor': 		data.set( [ value.r, value.g, value.b ], stride + 25 ); break;
			case 'iridescence': 		data[ stride + 28 ] = value; break;
			case 'iridescenceIOR': 		data[ stride + 29 ] = value; break;
			case 'iridescenceThicknessRange':
				data[ stride + 30 ] = value[ 0 ];
				data[ stride + 31 ] = value[ 1 ];
				break;
			case 'clearcoat': 			data[ stride + 38 ] = value; break;
			case 'clearcoatRoughness': 	data[ stride + 39 ] = value; break;
			case 'opacity': 			data[ stride + 40 ] = value; break;
			case 'side': 				data[ stride + 41 ] = value; break;
			case 'transparent': 		data[ stride + 42 ] = value; break;
			case 'alphaTest': 			data[ stride + 43 ] = value; break;

		}

		this.material.uniforms.materialTexture.value.needsUpdate = true;
		this.reset();

	}

	rebuildMaterialDataTexture( materialIndex, material ) {

		let materialData = this.sdfs.geometryExtractor.createMaterialObject( material );

		// iterate over materialData and update the materialTexture
		for ( const property in materialData ) {

			this.updateMaterialDataTexture( materialIndex, property, materialData[ property ] );

		}

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
		this.interactionController.dispose();

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

}
