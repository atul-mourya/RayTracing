import {
	ShaderMaterial, Vector2, Matrix4, WebGLRenderTarget,
	FloatType,
	NearestFilter,
	TextureLoader,
	RepeatWrapping,
	GLSL3,
	LinearSRGBColorSpace,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { LightDataTransfer } from '../Processor/LightDataTransfer';
import FragmentShader from './pathtracer.fs';
import VertexShader from './pathtracer.vs';
import TriangleSDF from '../Processor/TriangleSDF';
import { EnvironmentCDFBuilder } from '../Processor/EnvironmentCDFBuilder';
import blueNoiseImage from '../../../public/noise/simple_bluenoise.png';
import { DEFAULT_STATE } from '../../Constants';

export class PathTracerPass extends Pass {

	constructor( renderer, scene, camera, width, height ) {

		super();

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.scene = scene;
		this.tiles = DEFAULT_STATE.tiles;
		this.tileIndex = 0;
		this.spiralOrder = this.generateSpiralOrder( this.tiles );
		this.cameras = [];
		this.sdfs = new TriangleSDF();
		this.lightDataTransfer = new LightDataTransfer();

		// Tile rendering state
		this.currentTileBounds = null;
		this.scissorEnabled = false;
		this.tileHighlightPass = null;

		// Performance caches
		this.tileBoundsCache = new Map();
		this.totalTilesCache = this.tiles * this.tiles;
		this.mrtTexturesCache = { color: null, normalDepth: null };
		this.adaptiveSamplingFrameToggle = false;

		// Create improved CDF builder with production settings
		this.environmentCDFBuilder = new EnvironmentCDFBuilder( renderer, {
			maxCDFSize: 1024,
			minCDFSize: 256,
			adaptiveResolution: true,
			enableValidation: false,
			enableDebug: false,
			hotspotThreshold: 0.01
		} );

		this.name = 'PathTracerPass';

		// Store CDF validation results for debugging
		this.lastCDFValidation = null;
		this.cdfBuildTime = 0;

		// ========================================
		// UNIFIED RENDER TARGET SYSTEM
		// ========================================

		const targetOptions = {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			type: FloatType,
			colorSpace: LinearSRGBColorSpace,
			depthBuffer: false,
			count: 2, // Always MRT: Color + NormalDepth
			samples: 0 // IMPORTANT: No multisampling to avoid blitFramebuffer issues
		};

		// Single pair of ping-pong MRT targets
		this.currentTarget = new WebGLRenderTarget( width, height, targetOptions );
		this.previousTarget = new WebGLRenderTarget( width, height, targetOptions );

		// Set texture names for debugging
		this.currentTarget.textures[ 0 ].name = 'CurrentColor';
		this.currentTarget.textures[ 1 ].name = 'CurrentNormalDepth';
		this.previousTarget.textures[ 0 ].name = 'PreviousColor';
		this.previousTarget.textures[ 1 ].name = 'PreviousNormalDepth';

		// Accumulation state
		this.accumulationEnabled = true;

		this.name = 'PathTracerPass';
		this.material = new ShaderMaterial( {

			name: 'PathTracingShader',

			defines: {
				MAX_SPHERE_COUNT: 0,
				MAX_DIRECTIONAL_LIGHTS: 0,
				MAX_AREA_LIGHTS: 0,
				ENABLE_ACCUMULATION: '',
			},

			uniforms: {

				resolution: { value: new Vector2( width, height ) },
				exposure: { value: DEFAULT_STATE.exposure },
				enableEnvironmentLight: { value: DEFAULT_STATE.enableEnvironment },
				environment: { value: scene.environment },
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

				albedoMaps: { value: null },
				emissiveMaps: { value: null },
				normalMaps: { value: null },
				bumpMaps: { value: null },
				roughnessMaps: { value: null },
				metalnessMaps: { value: null },

				triangleTexture: { value: null },
				bvhTexture: { value: null },
				materialTexture: { value: null },

				triangleTexSize: { value: new Vector2() },
				bvhTexSize: { value: new Vector2() },
				materialTexSize: { value: new Vector2() },

				useEnvMipMap: { value: true },
				envSamplingBias: { value: 1.2 },
				maxEnvSamplingBounce: { value: 3 },

			},

			vertexShader: VertexShader,
			fragmentShader: FragmentShader,
			glslVersion: GLSL3,

		} );

		this.fsQuad = new FullScreenQuad( this.material );

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

		this.asvgfPass = null;
		this.lastRenderMode = - 1;
		this.tileCompletionFrame = 0;

		// Add render mode change debouncing
		this.renderModeChangeTimeout = null;
		this.renderModeChangeDelay = 50; // ms
		this.pendingRenderMode = null;

		this.isComplete = false;
		this.adaptiveSamplingPass = null;

		// Performance optimization during interaction
		this.interactionMode = false;
		this.interactionModeEnabled = DEFAULT_STATE.interactionModeEnabled;
		this.interactionTimeout = null;
		this.interactionDelay = 100;
		this.originalValues = {};

		this.uniformsDirty = {
			camera: true,
			lights: true,
			environment: true,
			settings: true
		};

		// Pre-calculate completion thresholds
		this.completionThreshold = 0;
		this.updateCompletionThreshold();

		// Cache frequently used objects
		this.tempVector2 = new Vector2();
		this.lastCameraMatrix = new Matrix4();
		this.lastProjectionMatrix = new Matrix4();
		this.environmentRotationMatrix = new Matrix4();

		// Enhanced interaction mode settings
		this.interactionQualitySettings = {
			maxBounceCount: 1,
			numRaysPerPixel: 1,
			useAdaptiveSampling: false,
			useEnvMapIS: false,
			pixelRatio: 0.25,
			enableAccumulation: false,
		};

	}

	/**
	 * Calculate the scissor bounds for a given tile
	 * @param {number} tileIndex - The index of the tile
	 * @param {number} totalTiles - Total number of tiles per row/column
	 * @param {number} width - Render target width
	 * @param {number} height - Render target height
	 * @returns {Object} - Scissor bounds {x, y, width, height}
	 */
	calculateTileBounds( tileIndex, totalTiles, width, height ) {

		// Use cache to avoid recalculation
		const cacheKey = `${tileIndex}-${totalTiles}-${width}-${height}`;
		if ( this.tileBoundsCache.has( cacheKey ) ) {

			return this.tileBoundsCache.get( cacheKey );

		}

		// Calculate tile size using ceiling division to ensure all pixels are covered
		const tileWidth = Math.ceil( width / totalTiles );
		const tileHeight = Math.ceil( height / totalTiles );

		// Calculate tile coordinates
		const tileX = tileIndex % totalTiles;
		const tileY = Math.floor( tileIndex / totalTiles );

		// Calculate pixel bounds
		const x = tileX * tileWidth;
		const y = tileY * tileHeight;

		// Clamp to actual render target bounds
		const clampedWidth = Math.min( tileWidth, width - x );
		const clampedHeight = Math.min( tileHeight, height - y );

		const bounds = {
			x: x,
			y: y,
			width: clampedWidth,
			height: clampedHeight
		};

		// Cache the result
		this.tileBoundsCache.set( cacheKey, bounds );
		return bounds;

	}

	/**
	 * Set up scissor testing for tile rendering
	 * @param {WebGLRenderer} renderer - The Three.js renderer
	 * @param {Object} bounds - Scissor bounds {x, y, width, height}
	 */
	enableScissorForTile( renderer, bounds ) {

		// Skip if already set to these exact bounds
		if ( this.scissorEnabled &&
			 this.currentTileBounds &&
			 this.currentTileBounds.x === bounds.x &&
			 this.currentTileBounds.y === bounds.y &&
			 this.currentTileBounds.width === bounds.width &&
			 this.currentTileBounds.height === bounds.height ) {

			return;

		}

		const gl = renderer.getContext();

		// Enable scissor testing
		gl.enable( gl.SCISSOR_TEST );

		// Set scissor rectangle
		// Note: WebGL scissor coordinates are from bottom-left, Three.js render targets are top-left
		// We need to flip the Y coordinate
		const flippedY = this.height - bounds.y - bounds.height;
		gl.scissor( bounds.x, flippedY, bounds.width, bounds.height );

		this.scissorEnabled = true;
		this.currentTileBounds = { ...bounds };

	}

	/**
	 * Disable scissor testing
	 * @param {WebGLRenderer} renderer - The Three.js renderer
	 */
	disableScissor( renderer ) {

		const gl = renderer.getContext();
		gl.disable( gl.SCISSOR_TEST );
		this.scissorEnabled = false;
		this.currentTileBounds = null;

	}

	setTileHighlightPass( tileHighlightPass ) {

		this.tileHighlightPass = tileHighlightPass;

	}

	setASVGFPass( asvgfPass ) {

		this.asvgfPass = asvgfPass;

	}

	getCurrentAccumulation() {

		return this.currentTarget;

	}

	getCurrentRawSample() {

		return this.currentTarget;

	}

	getMRTTextures() {

		// Reuse cached object to avoid allocation
		this.mrtTexturesCache.color = this.currentTarget.textures[ 0 ];
		this.mrtTexturesCache.normalDepth = this.currentTarget.textures[ 1 ];
		return this.mrtTexturesCache;

	}

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

	async build( scene ) {

		this.dispose();

		await this.sdfs.buildBVH( scene );
		this.cameras = this.sdfs.cameras;

		this.material.defines.MAX_SPHERE_COUNT = this.sdfs.spheres.length;

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

		// Update light uniforms
		this.updateLights();

	}

	updateLights() {

		this.lightDataTransfer.processSceneLights( this.scene, this.material );

	}

	// Add method to update individual light properties
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

		// itarate over materialData and update the materialTexture
		for ( const property in materialData ) {

			this.updateMaterialDataTexture( materialIndex, property, materialData[ property ] );

		}

	}

	reset() {

		// Reset accumulation state
		this.material.uniforms.frame.value = 0;
		this.material.uniforms.hasPreviousAccumulated.value = false;

		this.lastRenderMode = - 1;
		this.tileCompletionFrame = 0;

		if ( this.asvgfPass ) this.asvgfPass.reset();

		this.spiralOrder = this.generateSpiralOrder( this.tiles );

		// Clear both targets
		const currentRenderTarget = this.renderer.getRenderTarget();

		this.renderer.setRenderTarget( this.currentTarget );
		this.renderer.clear();
		this.renderer.setRenderTarget( this.previousTarget );
		this.renderer.clear();

		this.renderer.setRenderTarget( currentRenderTarget );

		// Update completion threshold if render mode changed
		this.updateCompletionThreshold();
		this.isComplete = false;

	}

	setTileCount( newTileCount ) {

		this.tiles = newTileCount;
		this.totalTilesCache = newTileCount * newTileCount; // Cache total tiles
		this.tileIndex = 0; // Reset tile index when tile count changes
		this.spiralOrder = this.generateSpiralOrder( newTileCount );
		this.updateCompletionThreshold(); // Recalculate based on new tile count
		this.tileBoundsCache.clear(); // Clear cache when tile count changes
		this.reset(); // Reset accumulation

	}

	generateSpiralOrder( tiles ) {

		const totalTiles = tiles * tiles;
		const center = ( tiles - 1 ) / 2;
		const tilePositions = [];

		// Create array of tile positions with their distances from center
		for ( let i = 0; i < totalTiles; i ++ ) {

			const x = i % tiles;
			const y = Math.floor( i / tiles );
			const distanceFromCenter = Math.sqrt( Math.pow( x - center, 2 ) + Math.pow( y - center, 2 ) );

			// Calculate angle for spiral ordering within same distance rings
			const angle = Math.atan2( y - center, x - center );

			tilePositions.push( {
				index: i,
				x,
				y,
				distance: distanceFromCenter,
				angle: angle
			} );

		}

		// Sort by distance from center, then by angle for spiral effect
		tilePositions.sort( ( a, b ) => {

			const distanceDiff = a.distance - b.distance;
			if ( Math.abs( distanceDiff ) < 0.01 ) {

				// Within same distance ring, sort by angle for spiral
				return a.angle - b.angle;

			}

			return distanceDiff;

		} );

		return tilePositions.map( pos => pos.index );

	}

	updateCompletionThreshold() {

		const renderMode = this.material.uniforms.renderMode.value;
		const maxFrames = this.material.uniforms.maxFrames.value;

		this.completionThreshold = renderMode === 1
			? this.totalTilesCache * maxFrames
			: maxFrames;

	}

	// Track camera changes for dirty flags
	updateCameraUniforms() {

		// Check if camera actually moved
		if ( ! this.lastCameraMatrix.equals( this.camera.matrixWorld ) ||
            ! this.lastProjectionMatrix.equals( this.camera.projectionMatrixInverse ) ) {

			this.material.uniforms.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
			this.material.uniforms.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

			// Cache current matrices
			this.lastCameraMatrix.copy( this.camera.matrixWorld );
			this.lastProjectionMatrix.copy( this.camera.projectionMatrixInverse );

			this.uniformsDirty.camera = false;
			return true; // Camera changed

		}

		return false; // No change

	}

	enterInteractionMode() {

		// Check if interaction mode is enabled globally
		if ( ! this.interactionModeEnabled ) return;

		if ( this.interactionMode ) {

			// Already in interaction mode, just clear the timeout
			clearTimeout( this.interactionTimeout );

		} else {

			// Enter interaction mode and save original values
			this.interactionMode = true;
			this.originalValues = {}; // Reset stored values

			// Store and apply all interaction settings
			Object.keys( this.interactionQualitySettings ).forEach( key => {

				if ( this.material.uniforms[ key ] ) {

					this.originalValues[ key ] = this.material.uniforms[ key ].value;
					this.material.uniforms[ key ].value = this.interactionQualitySettings[ key ];

				}

			} );

			// Disable accumulation during interaction for immediate feedback
			this.material.uniforms.enableAccumulation.value = false;
			this.material.uniforms.cameraIsMoving.value = true;

			// Store and reduce pixel ratio
			this.originalValues.dpr = this.renderer.getPixelRatio();
			this.renderer.setPixelRatio( this.interactionQualitySettings.pixelRatio );

		}

		// Set timeout to exit interaction mode
		this.interactionTimeout = setTimeout( () => {

			this.exitInteractionMode();

		}, this.interactionDelay );

	}

	exitInteractionMode() {

		if ( ! this.interactionMode ) return;

		// Restore original values
		Object.keys( this.originalValues ).forEach( key => {

			if ( this.material.uniforms[ key ] ) {

				this.material.uniforms[ key ].value = this.originalValues[ key ];

			}

		} );

		this.renderer.setPixelRatio( this.originalValues.dpr );

		// Re-enable accumulation and reset
		this.material.uniforms.enableAccumulation.value = this.accumulationEnabled;
		this.material.uniforms.cameraIsMoving.value = false;

		this.interactionMode = false;
		this.reset(); // Reset to start fresh accumulation

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

	setInteractionModeEnabled( enabled ) {

		this.interactionModeEnabled = enabled;

		// If turning off while in interaction mode, exit immediately
		if ( ! enabled && this.interactionMode ) {

			clearTimeout( this.interactionTimeout );
			this.exitInteractionMode();

		}

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.material.uniforms.resolution.value.set( width, height );

		// Resize unified targets
		this.currentTarget.setSize( width, height );
		this.previousTarget.setSize( width, height );

	}

	render( renderer, writeBuffer, readBuffer ) {

		// Combine early exit conditions for better performance
		if ( ! this.enabled || this.isComplete ||
			 this.material.uniforms.frame.value >= this.completionThreshold ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

		}

		const uniforms = this.material.uniforms;
		const frameValue = uniforms.frame.value;
		const renderMode = uniforms.renderMode.value;

		if ( this.asvgfPass ) this.manageASVGFForRenderMode( renderMode, frameValue );

		// Track if we should swap targets this frame
		let shouldSwapTargets = true;

		// 2. Handle tile rendering with scissor testing
		if ( renderMode === 1 ) {

			if ( frameValue === 0 ) {

				// First frame: render entire image, disable scissor
				this.disableScissor( renderer );
				this.tileIndex = - 1;

			} else {

				// Calculate current tile index (frames 1+ are tile-based)
				const linearTileIndex = ( frameValue - 1 ) % this.totalTilesCache;
				this.tileIndex = this.spiralOrder[ linearTileIndex ];

				// Set up scissor testing for current tile
				const tileBounds = this.calculateTileBounds( this.tileIndex, this.tiles, this.width, this.height );
				this.enableScissorForTile( renderer, tileBounds );

				// Update tile highlight pass only when values change
				if ( this.tileHighlightPass && this.tileHighlightPass.enabled ) {

					const needsUpdate = (
						this.tileHighlightPass.uniforms.tileIndex.value !== this.tileIndex ||
						this.tileHighlightPass.uniforms.renderMode.value !== renderMode ||
						this.tileHighlightPass.uniforms.tiles.value !== this.tiles
					);

					if ( needsUpdate ) {

						this.tileHighlightPass.uniforms.tileIndex.value = this.tileIndex;
						this.tileHighlightPass.uniforms.renderMode.value = renderMode;
						this.tileHighlightPass.uniforms.tiles.value = this.tiles;
						this.tileHighlightPass.setCurrentTileBounds( tileBounds );

					}

				}

				// Only swap targets after completing all tiles in a sample
				// Don't swap if we're still rendering tiles within the same sample
				shouldSwapTargets = ( linearTileIndex === this.totalTilesCache - 1 );

			}

		} else {

			// Regular rendering mode: disable scissor
			this.disableScissor( renderer );
			this.tileIndex = - 1;

			// Update tile highlight pass for non-tiled mode only when needed
			if ( this.tileHighlightPass && this.tileHighlightPass.enabled ) {

				const needsUpdate = (
					this.tileHighlightPass.uniforms.tileIndex.value !== this.tileIndex ||
					this.tileHighlightPass.uniforms.renderMode.value !== renderMode ||
					this.tileHighlightPass.uniforms.tiles.value !== this.tiles
				);

				if ( needsUpdate ) {

					this.tileHighlightPass.uniforms.tileIndex.value = this.tileIndex;
					this.tileHighlightPass.uniforms.renderMode.value = renderMode;
					this.tileHighlightPass.uniforms.tiles.value = this.tiles;

				}

			}

		}

		// 3. Only update uniforms that have changed
		this.updateCameraUniforms();

		// 4. Update accumulation state
		if ( this.accumulationEnabled && ! this.interactionMode ) {

			if ( renderMode !== 0 ) {

				if ( uniforms.frame.value === 0 ) {

					// First frame: render entire image for immediate preview
					uniforms.accumulationAlpha.value = 1.0;
					uniforms.hasPreviousAccumulated.value = false;

				} else {

					// Subsequent frames: use tile rendering with proper accumulation
					// Frame 0 was full image (sample 1), frames 1+ are tile-based
					// So frame 1-totalTiles is sample 2, frame (totalTiles+1)-(2*totalTiles) is sample 3, etc.
					const timesCurrentTileRendered = Math.floor( ( uniforms.frame.value - 1 ) / this.totalTilesCache ) + 2;

					uniforms.accumulationAlpha.value = 1.0 / timesCurrentTileRendered;
					uniforms.hasPreviousAccumulated.value = true; // Frame 0 provided initial accumulation

				}

			} else {

				uniforms.accumulationAlpha.value = 1.0 / Math.max( uniforms.frame.value, 1 );
				uniforms.hasPreviousAccumulated.value = uniforms.frame.value >= 1;

			}

			// Set previous accumulated texture
			uniforms.previousAccumulatedTexture.value = this.previousTarget.textures[ 0 ];

		} else {

			// During interaction, no accumulation
			uniforms.accumulationAlpha.value = 1.0;
			uniforms.previousAccumulatedTexture.value = null;
			uniforms.hasPreviousAccumulated.value = false;

		}

		// Set previous frame texture
		uniforms.previousFrameTexture.value = this.previousTarget.textures[ 0 ];

		// 5. Adaptive sampling optimization - use toggle instead of modulo
		if ( this.adaptiveSamplingPass?.enabled && ! this.interactionMode ) {

			this.adaptiveSamplingFrameToggle = ! this.adaptiveSamplingFrameToggle;
			if ( this.adaptiveSamplingFrameToggle ) {

				uniforms.adaptiveSamplingTexture.value = this.adaptiveSamplingPass.renderTarget.texture;
				uniforms.adaptiveSamplingMax.value = this.adaptiveSamplingPass.adaptiveSamplingMax;

				// Set MRT textures for adaptive sampling
				const mrtTextures = this.getMRTTextures();
				this.adaptiveSamplingPass.setTextures(
					mrtTextures.color,
					mrtTextures.normalDepth
				);

			}

		} else if ( this.interactionMode ) {

			// Disable adaptive sampling during interaction
			uniforms.adaptiveSamplingTexture.value = null;

		}

		// 6. Render to our internal MRT target with scissor testing
		renderer.setRenderTarget( this.currentTarget );
		this.fsQuad.render( renderer );

		// 7. Always copy the full accumulated result to writeBuffer
		if ( writeBuffer || this.renderToScreen ) {

			// Temporarily disable scissor for final copy to ensure full image is copied
			const wasScissorEnabled = this.scissorEnabled;
			if ( wasScissorEnabled ) {

				this.disableScissor( renderer );

			}

			this.efficientCopyColorOutput( renderer, writeBuffer );

			// Restore scissor state if it was enabled
			if ( wasScissorEnabled && this.currentTileBounds ) {

				this.enableScissorForTile( renderer, this.currentTileBounds );

			}

		}

		uniforms.frame.value ++;

		// 8. Conditional target swap - only swap when completing a full sample
		if ( shouldSwapTargets ) {

			[ this.currentTarget, this.previousTarget ] = [ this.previousTarget, this.currentTarget ];

		}

	}

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
		const currentTileIndex = isFirstFrame ? - 1 : ( ( frameValue - 1 ) % this.totalTilesCache );
		const isLastTileInSample = currentTileIndex === this.totalTilesCache - 1;

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

	efficientCopyColorOutput( renderer, writeBuffer ) {

		if ( ! this.copyMaterial ) {

			this.copyMaterial = new ShaderMaterial( {
				uniforms: {
					tDiffuse: { value: null }
				},

				vertexShader: `
					varying vec2 vUv;
					void main() {
						vUv = uv;
						gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
					}
				`,

				fragmentShader: `
					uniform sampler2D tDiffuse;
					varying vec2 vUv;
					void main() {
						gl_FragColor = texture2D( tDiffuse, vUv );
					}
				`,

				depthTest: false,
				depthWrite: false,
				transparent: false,
			} );

			this.copyQuad = new FullScreenQuad( this.copyMaterial );

		}

		// Set source texture (color output from our MRT)
		this.copyMaterial.uniforms.tDiffuse.value = this.currentTarget.textures[ 0 ];

		// Render to destination
		renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
		this.copyQuad.render( renderer );

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

	setAdaptiveSamplingPass( asPass ) {

		this.adaptiveSamplingPass = asPass;

	}

	updateUniforms( updates ) {

		let needsReset = false;

		Object.entries( updates ).forEach( ( [ key, value ] ) => {

			if ( this.material.uniforms[ key ] &&
                this.material.uniforms[ key ].value !== value ) {

				this.material.uniforms[ key ].value = value;
				needsReset = true;

			}

		} );

		if ( needsReset ) {

			this.reset();

		}

	}

	dispose() {

		// Clean up scissor state
		if ( this.scissorEnabled ) {

			this.disableScissor( this.renderer );

		}

		// Clear render mode change timeout
		if ( this.renderModeChangeTimeout ) {

			clearTimeout( this.renderModeChangeTimeout );
			this.renderModeChangeTimeout = null;

		}

		// Clear caches
		this.tileBoundsCache.clear();

		// Dispose unified targets
		this.currentTarget.dispose();
		this.previousTarget.dispose();

		// Dispose copy materials
		this.copyMaterial?.dispose();
		this.copyQuad?.dispose();

		// Dispose other resources
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
