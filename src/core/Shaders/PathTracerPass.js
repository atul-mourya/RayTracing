// PathTracerPass.js - Clean Consolidated Refactor
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
		this.cameras = [];
		this.sdfs = null;
		this.sdfs = new TriangleSDF();
		this.lightDataTransfer = new LightDataTransfer();

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
				useEnvMapIS: { value: true },
				envCDF: { value: null },
				envCDFSize: { value: new Vector2() },
				globalIlluminationIntensity: { value: DEFAULT_STATE.globalIlluminationIntensity * Math.PI },

				cameraWorldMatrix: { value: new Matrix4() },
				cameraProjectionMatrixInverse: { value: new Matrix4() },
				focusDistance: { value: DEFAULT_STATE.focusDistance },
				focalLength: { value: DEFAULT_STATE.focalLength },
				aperture: { value: DEFAULT_STATE.aperture },
				apertureScale: { value: 2.0 },

				directionalLights: { value: null },
				pointLights: { value: null },
				spotLights: { value: null },
				areaLights: { value: null },

				frame: { value: 0 },
				maxFrames: { value: DEFAULT_STATE.maxSamples },
				maxBounceCount: { value: DEFAULT_STATE.bounces },
				numRaysPerPixel: { value: DEFAULT_STATE.samplesPerPixel },
				transmissiveBounces: { value: 8 },

				samplingTechnique: { value: DEFAULT_STATE.samplingTechnique },
				useAdaptiveSampling: { value: DEFAULT_STATE.adaptiveSampling },
				adaptiveSamplingTexture: { value: null },
				adaptiveSamplingMax: { value: DEFAULT_STATE.adaptiveSamplingMax },
				fireflyThreshold: { value: DEFAULT_STATE.fireflyThreshold },

				renderMode: { value: DEFAULT_STATE.renderMode },
				tiles: { value: this.tiles },
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
			tiles: 1,
			enableAccumulation: false,
		};

	}

	getCurrentAccumulation() {

		return this.currentTarget;

	}

	getCurrentRawSample() {

		return this.currentTarget;

	}

	getMRTTextures() {

		return {
			color: this.currentTarget.textures[ 0 ],
			normalDepth: this.currentTarget.textures[ 1 ]
		};

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
		this.material.uniforms.tiles.value = newTileCount;
		this.updateCompletionThreshold(); // Recalculate based on new tile count
		this.reset(); // Reset accumulation

	}

	updateCompletionThreshold() {

		const renderMode = this.material.uniforms.renderMode.value;
		const maxFrames = this.material.uniforms.maxFrames.value;

		this.completionThreshold = renderMode === 1
			? Math.pow( this.tiles, 2 ) * maxFrames
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

		if ( ! this.enabled || this.isComplete ) return;

		// 1. Early completion check with pre-calculated threshold
		if ( this.material.uniforms.frame.value >= this.completionThreshold ) {

			this.isComplete = true;
			return;

		}

		const uniforms = this.material.uniforms;
		const frameValue = uniforms.frame.value;
		const renderMode = uniforms.renderMode.value;

		// 2. Only update uniforms that have changed
		this.updateCameraUniforms();

		// 3. Update accumulation state
		if ( this.accumulationEnabled && ! this.interactionMode ) {

			if ( renderMode !== 0 ) {

				const totalTiles = Math.pow( this.tiles, 2 );

				if ( uniforms.frame.value === 0 ) {

					// First frame: render entire image with tiles = 1 for immediate preview
					uniforms.tiles.value = 1;
					uniforms.accumulationAlpha.value = 1.0;
					uniforms.hasPreviousAccumulated.value = false;

				} else {

					// Subsequent frames: use tile rendering with proper accumulation
					uniforms.tiles.value = this.tiles;

					// Calculate how many times the current tile has been rendered
					// Frame 0 was full image (sample 1), frames 1+ are tile-based
					// So frame 1-totalTiles is sample 2, frame (totalTiles+1)-(2*totalTiles) is sample 3, etc.
					const timesCurrentTileRendered = Math.floor( ( uniforms.frame.value - 1 ) / totalTiles ) + 2;

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

		// 4. Adaptive sampling optimization - skip during interaction
		if ( this.adaptiveSamplingPass?.enabled && ! this.interactionMode ) {

			// Only update adaptive sampling every few frames for better performance
			if ( frameValue % 2 === 0 ) {

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

		// Update tiles for tiled rendering
		if ( renderMode === 1 && frameValue === 0 ) {

			uniforms.tiles.value = 1;

		} else if ( renderMode === 1 && uniforms.tiles.value !== this.tiles ) {

			uniforms.tiles.value = this.tiles;

		}

		// 5. Render to our internal MRT target for accumulation and data
		renderer.setRenderTarget( this.currentTarget );
		this.fsQuad.render( renderer );

		// 6. Simple, efficient copy to writeBuffer (when needed)
		if ( writeBuffer || this.renderToScreen ) {

			this.efficientCopyColorOutput( renderer, writeBuffer );

		}

		uniforms.frame.value ++;

		// 8. Single target swap
		[ this.currentTarget, this.previousTarget ] = [ this.previousTarget, this.currentTarget ];

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

