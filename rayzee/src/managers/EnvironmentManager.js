/**
 * EnvironmentManager.js
 * Manages HDRI loading, CDF importance sampling, procedural/gradient/solid sky
 * generation, and environment rotation for the path tracing pipeline.
 *
 * Storage buffer nodes are created once and never replaced — only .value
 * is mutated to preserve TSL shader graph references after compilation.
 */

import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { storage } from 'three/tsl';
import {
	RGBAFormat, FloatType, Vector2, Vector3, Color, Matrix4, DataTexture,
} from 'three';
import { EquirectHDRInfo } from '../Processor/EquirectHDRInfo.js';
import { ProceduralSky } from '../Processor/ProceduralSky.js';
import { SimpleSky } from '../Processor/SimpleSky.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE } from '../EngineDefaults.js';

export class EnvironmentManager {

	/**
	 * @param {Object} scene - Three.js scene
	 * @param {import('./UniformManager').UniformManager} uniforms
	 */
	constructor( scene, uniforms ) {

		this.scene = scene;
		this.uniforms = uniforms;

		// CDF computation engine
		this.equirectHdrInfo = new EquirectHDRInfo();

		// Sky renderers (lazy init)
		this.proceduralSkyRenderer = null;
		this.simpleSkyRenderer = null;

		// Environment texture — 1×1 black placeholder for shader compilation
		this._envPlaceholder = new DataTexture(
			new Float32Array( [ 0, 0, 0, 1 ] ), 1, 1, RGBAFormat, FloatType
		);
		this._envPlaceholder.needsUpdate = true;
		this.environmentTexture = this._envPlaceholder;
		this.envTexSize = new Vector2();

		// CDF storage buffers
		this.envMarginalStorageAttr = null;
		this.envMarginalStorageNode = null;
		this.envConditionalStorageAttr = null;
		this.envConditionalStorageNode = null;
		this._initCDFStorageBuffers();

		// Environment rotation
		this.environmentRotationMatrix = new Matrix4();

		// CDF timing
		this.cdfBuildTime = 0;

		// Environment parameters (CPU-side)
		this.envParams = {
			mode: 'hdri',

			// Gradient Sky
			gradientZenithColor: new Color( DEFAULT_STATE.gradientZenithColor ),
			gradientHorizonColor: new Color( DEFAULT_STATE.gradientHorizonColor ),
			gradientGroundColor: new Color( DEFAULT_STATE.gradientGroundColor ),

			// Solid Color Sky
			solidSkyColor: new Color( DEFAULT_STATE.solidSkyColor ),

			// Procedural Sky (Preetham Model)
			skySunDirection: this._calculateInitialSunDirection(),
			skySunIntensity: DEFAULT_STATE.skySunIntensity,
			skyRayleighDensity: DEFAULT_STATE.skyRayleighDensity,
			skyTurbidity: DEFAULT_STATE.skyTurbidity,
			skyMieAnisotropy: DEFAULT_STATE.skyMieAnisotropy,
		};

		/**
		 * Optional callbacks set by the owning stage.
		 * @type {{ onReset?: Function, onAutoExposureReset?: Function, getSceneTextureNodes?: Function }}
		 */
		this.callbacks = {};

		// Mode state machine (absorbed from EnvironmentAPI)
		this._previousHDRI = null;

	}

	// ===== MODE STATE MACHINE =====

	/**
	 * Switches the environment mode (hdri, gradient, color, procedural).
	 * Preserves the HDRI texture when switching away, restores when switching back.
	 * @param {'hdri'|'gradient'|'color'|'procedural'} mode
	 */
	async setMode( mode ) {

		const prev = this.envParams.mode;
		this.envParams.mode = mode;

		// Cache HDRI texture when leaving HDRI mode
		if ( mode !== 'hdri' && prev === 'hdri' ) {

			this._previousHDRI = this.environmentTexture;

		}

		if ( mode === 'gradient' ) {

			await this.generateGradientTexture();

		} else if ( mode === 'color' ) {

			await this.generateSolidColorTexture();

		} else if ( mode === 'procedural' ) {

			await this.generateProceduralSkyTexture();

		} else if ( mode === 'hdri' && this._previousHDRI ) {

			await this.setEnvironmentMap( this._previousHDRI );
			this._previousHDRI = null;

		}

		this.markDirty();
		this.callbacks.onAutoExposureReset?.();
		this._notifyReset();

	}

	/**
	 * Marks the environment texture as needing GPU re-upload on the next frame.
	 */
	markDirty() {

		if ( this.environmentTexture ) this.environmentTexture.needsUpdate = true;

	}

	// ===== Aliases (match Sub-API surface for zero-churn migration) =====

	/** @see envParams */
	get params() {

		return this.envParams;

	}

	/** @see environmentTexture */
	get texture() {

		return this.environmentTexture;

	}

	/** @see generateGradientTexture */
	generateGradient() {

		return this.generateGradientTexture();

	}

	/** @see generateSolidColorTexture */
	generateSolid() {

		return this.generateSolidColorTexture();

	}

	/** @see generateProceduralSkyTexture */
	generateProcedural() {

		return this.generateProceduralSkyTexture();

	}

	// ===== CDF STORAGE BUFFERS =====

	/**
	 * Initialize CDF storage buffers with placeholder data.
	 * Must be called before shader compilation so the nodes exist in the graph.
	 * @private
	 */
	_initCDFStorageBuffers() {

		// Marginal: 1 float per entry, default placeholder
		const marginalPlaceholder = new Float32Array( [ 0, 1 ] );
		this.envMarginalStorageAttr = new StorageInstancedBufferAttribute( marginalPlaceholder, 1 );
		this.envMarginalStorageNode = storage( this.envMarginalStorageAttr, 'float', 2 ).toReadOnly();

		// Conditional: 1 float per entry, default placeholder
		const conditionalPlaceholder = new Float32Array( [ 0, 0, 1, 1 ] );
		this.envConditionalStorageAttr = new StorageInstancedBufferAttribute( conditionalPlaceholder, 1 );
		this.envConditionalStorageNode = storage( this.envConditionalStorageAttr, 'float', 4 ).toReadOnly();

	}

	/**
	 * Update marginal CDF storage buffer from Float32Array.
	 */
	setEnvMarginalData( floatData ) {

		if ( ! floatData ) return;

		this.envMarginalStorageAttr = new StorageInstancedBufferAttribute( floatData, 1 );
		this.envMarginalStorageNode.value = this.envMarginalStorageAttr;
		this.envMarginalStorageNode.bufferCount = floatData.length;

	}

	/**
	 * Update conditional CDF storage buffer from Float32Array.
	 */
	setEnvConditionalData( floatData ) {

		if ( ! floatData ) return;

		this.envConditionalStorageAttr = new StorageInstancedBufferAttribute( floatData, 1 );
		this.envConditionalStorageNode.value = this.envConditionalStorageAttr;
		this.envConditionalStorageNode.bufferCount = floatData.length;

	}

	/**
	 * Update both CDF storage buffers from equirectHdrInfo.
	 * @private
	 */
	_updateCDFStorageBuffers() {

		this.setEnvMarginalData( this.equirectHdrInfo.marginalData );
		this.setEnvConditionalData( this.equirectHdrInfo.conditionalData );

	}

	/**
	 * Get CDF storage nodes for shader graph.
	 * @returns {{ marginalNode: StorageNode, conditionalNode: StorageNode }}
	 */
	getCDFStorageNodes() {

		return {
			marginalNode: this.envMarginalStorageNode,
			conditionalNode: this.envConditionalStorageNode,
		};

	}

	// ===== ENVIRONMENT TEXTURE =====

	/**
	 * Sets the environment map texture reference and size.
	 * @param {import('three').Texture} envTex
	 */
	setEnvironmentTexture( envTex ) {

		if ( ! envTex ) return;

		this.environmentTexture = envTex;
		this.envTexSize.set( envTex.image.width, envTex.image.height );

		console.log( `EnvironmentManager: Environment map ${envTex.image.width}x${envTex.image.height}` );

	}

	/**
	 * Get the current environment texture.
	 * @returns {import('three').Texture}
	 */
	getEnvironmentTexture() {

		return this.environmentTexture;

	}

	// ===== ENVIRONMENT ROTATION =====

	/**
	 * Set environment rotation from degrees.
	 * @param {number} rotationDegrees
	 */
	setEnvironmentRotation( rotationDegrees ) {

		const rotationRadians = rotationDegrees * ( Math.PI / 180 );
		this.environmentRotationMatrix.makeRotationY( rotationRadians );
		this.uniforms.get( 'environmentMatrix' ).value.copy( this.environmentRotationMatrix );

	}

	// ===== CDF BUILDING =====

	/**
	 * Build environment CDF for importance sampling.
	 * @param {Object} [options]
	 * @param {boolean} [options.useWorker=true]
	 */
	async buildEnvironmentCDF( { useWorker = true } = {} ) {

		if ( ! this.scene.environment ) {

			this._updateCDFStorageBuffers();
			this.uniforms.set( 'envTotalSum', 0.0 );
			this.uniforms.set( 'useEnvMapIS', 0 );
			return;

		}

		try {

			const startTime = performance.now();
			const textureForCDF = this.scene.environment;

			if ( ! textureForCDF.image || ! textureForCDF.image.data ) {

				this._updateCDFStorageBuffers();
				this.uniforms.set( 'envTotalSum', 0.0 );
				this.uniforms.set( 'useEnvMapIS', 0 );
				return;

			}

			if ( useWorker ) {

				await this.equirectHdrInfo.updateFromAsync( textureForCDF );

			} else {

				this.equirectHdrInfo.updateFrom( textureForCDF );

			}

			this.cdfBuildTime = performance.now() - startTime;

			this._updateCDFStorageBuffers();
			this.uniforms.set( 'envTotalSum', this.equirectHdrInfo.totalSum );
			this.uniforms.set( 'useEnvMapIS', 1 );

			const { width, height } = this.equirectHdrInfo;
			if ( width && height ) {

				this.uniforms.get( 'envResolution' ).value.set( width, height );

			}

			console.log( `Environment CDF built in ${this.cdfBuildTime.toFixed( 2 )}ms (worker: ${useWorker})` );

		} catch ( error ) {

			console.error( 'Error building environment CDF:', error );
			this.uniforms.set( 'useEnvMapIS', 0 );
			this.uniforms.set( 'envTotalSum', 0.0 );

		}

	}

	/**
	 * Apply CDF results and update TSL env texture nodes after a parallel CDF build.
	 */
	applyCDFResults() {

		const envMap = this.scene.environment;

		const nodes = this.callbacks.getSceneTextureNodes?.();
		if ( nodes && envMap && nodes.envTex ) {

			nodes.envTex.value = envMap;

		}

		if ( envMap && ! envMap._isGeneratedProcedural ) {

			this.uniforms.set( 'hasSun', 0 );

		}

	}

	// ===== ENVIRONMENT MAP LOADING =====

	/**
	 * Set environment map, build CDF, and update shader texture nodes.
	 * @param {import('three').Texture|null} envMap
	 */
	async setEnvironmentMap( envMap ) {

		this.scene.environment = envMap;
		this.setEnvironmentTexture( envMap );

		if ( envMap ) {

			await this.buildEnvironmentCDF();

		} else {

			this._updateCDFStorageBuffers();
			this.uniforms.set( 'envTotalSum', 0.0 );
			this.uniforms.set( 'useEnvMapIS', 0 );

		}

		// Update TSL texture nodes so the shader sees the new environment
		const nodes = this.callbacks.getSceneTextureNodes?.();
		if ( nodes ) {

			if ( envMap && nodes.envTex ) {

				nodes.envTex.value = envMap;

			}

		}

		if ( envMap && ! envMap._isGeneratedProcedural ) {

			this.uniforms.set( 'hasSun', 0 );

		}

		this._notifyReset();

	}

	// ===== SKY GENERATORS =====

	/**
	 * Generate gradient sky texture and set as environment.
	 */
	async generateGradientTexture() {

		if ( ! this.simpleSkyRenderer ) {

			this.simpleSkyRenderer = new SimpleSky( 512, 256 );

		}

		const params = {
			zenithColor: this.envParams.gradientZenithColor,
			horizonColor: this.envParams.gradientHorizonColor,
			groundColor: this.envParams.gradientGroundColor,
		};

		try {

			const texture = this.simpleSkyRenderer.renderGradient( params );
			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );
			this.uniforms.set( 'hasSun', 0 );

		} catch ( error ) {

			console.error( 'Error generating gradient sky:', error );

		}

	}

	/**
	 * Generate solid color sky texture and set as environment.
	 */
	async generateSolidColorTexture() {

		if ( ! this.simpleSkyRenderer ) {

			this.simpleSkyRenderer = new SimpleSky( 512, 256 );

		}

		const params = {
			color: this.envParams.solidSkyColor,
		};

		try {

			const texture = this.simpleSkyRenderer.renderSolid( params );
			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );
			this.uniforms.set( 'hasSun', 0 );

		} catch ( error ) {

			console.error( 'Error generating solid color sky:', error );

		}

	}

	/**
	 * Generate procedural (Preetham) sky texture and set as environment.
	 */
	async generateProceduralSkyTexture() {

		if ( ! this.proceduralSkyRenderer ) {

			this.proceduralSkyRenderer = new ProceduralSky( 512, 256 );

		}

		const params = {
			sunDirection: this.envParams.skySunDirection.clone(),
			sunIntensity: this.envParams.skySunIntensity * 0.05,
			rayleighDensity: this.envParams.skyRayleighDensity * 2.0,
			mieDensity: this.envParams.skyTurbidity * 0.005,
			mieAnisotropy: this.envParams.skyMieAnisotropy,
			turbidity: this.envParams.skyTurbidity * 2.0,
		};

		try {

			const texture = this.proceduralSkyRenderer.render( params );
			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );

			this.uniforms.get( 'sunDirection' ).value.copy( this.envParams.skySunDirection );
			this.uniforms.set( 'sunAngularSize', 0.0087 );
			this.uniforms.set( 'hasSun', 1 );

			console.log( `Sun parameters synced: dir=${this.envParams.skySunDirection.toArray().map( v => v.toFixed( 2 ) ).join( ',' )}` );

		} catch ( error ) {

			console.error( 'Error generating procedural sky:', error );

		}

	}

	// ===== HELPERS =====

	/** @private */
	_calculateInitialSunDirection() {

		const azimuth = DEFAULT_STATE.skySunAzimuth * ( Math.PI / 180 );
		const elevation = DEFAULT_STATE.skySunElevation * ( Math.PI / 180 );
		return new Vector3(
			Math.cos( elevation ) * Math.sin( azimuth ),
			Math.sin( elevation ),
			Math.cos( elevation ) * Math.cos( azimuth )
		).normalize();

	}

	/** @private */
	_notifyReset() {

		if ( this.callbacks.onReset ) {

			this.callbacks.onReset();

		}

	}

	// ===== DISPOSAL =====

	dispose() {

		this.proceduralSkyRenderer = null;
		this.simpleSkyRenderer = null;
		this.envMarginalStorageAttr = null;
		this.envMarginalStorageNode = null;
		this.envConditionalStorageAttr = null;
		this.envConditionalStorageNode = null;
		this._envPlaceholder?.dispose();
		this._envPlaceholder = null;
		this.environmentTexture = null;

	}

}
