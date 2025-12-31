import {
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	Vector2,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';

/**
 * VarianceEstimationStage - Standalone variance computation
 *
 * Computes temporal and spatial variance for:
 * - Adaptive sampling guidance (concentrate samples on high-variance regions)
 * - Firefly detection (outlier pixels with extremely high variance)
 * - Image quality metrics (convergence monitoring)
 * - Denoiser guidance (variance-weighted filtering)
 *
 * This stage works INDEPENDENTLY of ASVGF, making variance available
 * even when the full temporal denoiser is disabled.
 *
 * Execution: CONFIGURABLE - Can run per-frame or per-cycle
 *
 * Output texture format (RGBA):
 * - R: Mean luminance
 * - G: Second moment (mean of squared luminance)
 * - B: Temporal variance (secondMoment - mean^2)
 * - A: Spatial variance (3x3 neighborhood variance)
 *
 * Events listened to:
 * - variance:updateParameters - Updates variance parameters
 * - pipeline:reset - Resets temporal history
 *
 * Textures read from context:
 * - Input color texture (configurable, default: 'pathtracer:color')
 * - Optional: history length texture for temporal blending
 *
 * Textures published to context:
 * - variance:output - Variance estimation (mean, secondMoment, temporal, spatial)
 */
export class VarianceEstimationStage extends PipelineStage {

	constructor( options = {} ) {

		super( 'VarianceEstimation', {
			...options,
			executionMode: options.executionMode ?? StageExecutionMode.ALWAYS
		} );

		this.renderer = options.renderer || null;
		this.width = options.width || 1920;
		this.height = options.height || 1080;

		// Configurable input texture names
		this.inputTextureName = options.inputTextureName ?? 'pathtracer:color';
		this.historyLengthTextureName = options.historyLengthTextureName ?? null; // Optional

		// Output texture name
		this.outputTextureName = options.outputTextureName ?? 'variance:output';

		// Variance parameters
		this.params = {
			// Variance boost multiplier
			varianceBoost: options.varianceBoost ?? 1.0,

			// Temporal blending (when no external history is provided)
			useTemporalAccumulation: options.useTemporalAccumulation ?? true,
			temporalAlpha: options.temporalAlpha ?? 0.1, // Blend factor for new samples

			// Spatial variance kernel size (1 = 3x3, 2 = 5x5)
			spatialKernelRadius: options.spatialKernelRadius ?? 1,

			// Firefly detection threshold (for downstream stages)
			fireflyThreshold: options.fireflyThreshold ?? 10.0,

			...options
		};

		// Frame tracking
		this.frameCount = 0;
		this.isFirstFrame = true;

		// Initialize render targets
		this.initRenderTargets();

		// Initialize materials
		this.initMaterials();

		// Create fullscreen quad
		this.varianceQuad = new FullScreenQuad( this.varianceMaterial );

	}

	initRenderTargets() {

		const targetOptions = {
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false
		};

		// Current variance output
		this.varianceTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.varianceTarget.texture.name = 'Variance_Output';

		// Previous moments for temporal accumulation
		this.prevMomentsTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.prevMomentsTarget.texture.name = 'Variance_PrevMoments';

	}

	initMaterials() {

		// Variance estimation shader
		this.varianceMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tPrevMoments: { value: null },
				tHistoryLength: { value: null },

				resolution: { value: new Vector2( this.width, this.height ) },
				varianceBoost: { value: this.params.varianceBoost },

				useTemporalAccumulation: { value: this.params.useTemporalAccumulation },
				temporalAlpha: { value: this.params.temporalAlpha },
				isFirstFrame: { value: true },
				frameCount: { value: 0 },

				spatialKernelRadius: { value: this.params.spatialKernelRadius },
				fireflyThreshold: { value: this.params.fireflyThreshold },

				hasExternalHistory: { value: false }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				precision highp float;
				precision highp int;

				uniform sampler2D tColor;
				uniform sampler2D tPrevMoments;
				uniform sampler2D tHistoryLength;

				uniform vec2 resolution;
				uniform float varianceBoost;

				uniform bool useTemporalAccumulation;
				uniform float temporalAlpha;
				uniform bool isFirstFrame;
				uniform float frameCount;

				uniform int spatialKernelRadius;
				uniform float fireflyThreshold;

				uniform bool hasExternalHistory;

				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				void main() {
					vec3 currentColor = texture2D(tColor, vUv).rgb;
					float currentLuma = getLuma(currentColor);

					// Determine history length for temporal blending
					float historyLength = 1.0;
					if (hasExternalHistory) {
						// Use external history length (e.g., from temporal accumulator)
						vec4 historyData = texture2D(tHistoryLength, vUv);
						historyLength = max(historyData.a, 1.0);
					} else if (useTemporalAccumulation) {
						// Use internal frame count
						historyLength = frameCount;
					}

					// Get previous moments
					vec4 prevMoments = texture2D(tPrevMoments, vUv);
					float prevMean = prevMoments.x;
					float prevSecondMoment = prevMoments.y;

					// Compute temporal blending alpha
					float alpha;
					if (isFirstFrame) {
						alpha = 1.0; // First frame: use current sample entirely
					} else if (hasExternalHistory) {
						alpha = 1.0 / max(historyLength, 1.0);
					} else {
						alpha = temporalAlpha;
					}

					// Temporal accumulation of moments
					float newMean = mix(prevMean, currentLuma, alpha);
					float newSecondMoment = mix(prevSecondMoment, currentLuma * currentLuma, alpha);

					// Compute temporal variance (Var = E[X^2] - E[X]^2)
					float temporalVariance = max(0.0, newSecondMoment - newMean * newMean);
					temporalVariance *= varianceBoost;

					// Compute spatial (neighborhood) variance
					vec2 texelSize = 1.0 / resolution;
					float neighborhoodSum = 0.0;
					float neighborhoodSumSq = 0.0;
					float count = 0.0;

					for (int x = -spatialKernelRadius; x <= spatialKernelRadius; x++) {
						for (int y = -spatialKernelRadius; y <= spatialKernelRadius; y++) {
							vec2 offset = vec2(float(x), float(y)) * texelSize;
							vec2 sampleUV = vUv + offset;

							// Bounds check
							if (sampleUV.x >= 0.0 && sampleUV.x <= 1.0 &&
								sampleUV.y >= 0.0 && sampleUV.y <= 1.0) {
								vec3 neighborColor = texture2D(tColor, sampleUV).rgb;
								float neighborLuma = getLuma(neighborColor);
								neighborhoodSum += neighborLuma;
								neighborhoodSumSq += neighborLuma * neighborLuma;
								count += 1.0;
							}
						}
					}

					// Spatial variance = E[X^2] - E[X]^2 over neighborhood
					float neighborhoodMean = neighborhoodSum / count;
					float neighborhoodSecondMoment = neighborhoodSumSq / count;
					float spatialVariance = max(0.0, neighborhoodSecondMoment - neighborhoodMean * neighborhoodMean);
					spatialVariance *= varianceBoost;

					// Output: mean, secondMoment, temporalVariance, spatialVariance
					gl_FragColor = vec4(newMean, newSecondMoment, temporalVariance, spatialVariance);
				}
			`
		} );

		// Copy material for storing previous moments
		this.copyMaterial = new ShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				precision highp float;

				uniform sampler2D tDiffuse;
				varying vec2 vUv;
				void main() {
					gl_FragColor = texture2D( tDiffuse, vUv );
				}
			`
		} );
		this.copyQuad = new FullScreenQuad( this.copyMaterial );

	}

	/**
	 * Setup event listeners
	 */
	setupEventListeners() {

		// Listen for parameter updates
		this.on( 'variance:updateParameters', ( data ) => {

			if ( data ) this.updateParameters( data );

		} );

		// Listen for pipeline reset
		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

	}

	/**
	 * Update variance parameters
	 */
	updateParameters( params ) {

		Object.assign( this.params, params );

		// Update shader uniforms
		const uniforms = this.varianceMaterial.uniforms;
		uniforms.varianceBoost.value = this.params.varianceBoost;
		uniforms.useTemporalAccumulation.value = this.params.useTemporalAccumulation;
		uniforms.temporalAlpha.value = this.params.temporalAlpha;
		uniforms.spatialKernelRadius.value = this.params.spatialKernelRadius;
		uniforms.fireflyThreshold.value = this.params.fireflyThreshold;

	}

	/**
	 * Configure input/output texture names
	 */
	setTextureNames( config ) {

		if ( config.input ) this.inputTextureName = config.input;
		if ( config.historyLength ) this.historyLengthTextureName = config.historyLength;
		if ( config.output ) this.outputTextureName = config.output;

	}

	/**
	 * Reset temporal history
	 */
	reset() {

		this.frameCount = 0;
		this.isFirstFrame = true;

		// Clear render targets
		if ( this.renderer ) {

			const currentRT = this.renderer.getRenderTarget();

			this.renderer.setRenderTarget( this.varianceTarget );
			this.renderer.clear();

			this.renderer.setRenderTarget( this.prevMomentsTarget );
			this.renderer.clear();

			this.renderer.setRenderTarget( currentRT );

		}

	}

	/**
	 * Set render size
	 */
	setSize( width, height ) {

		this.width = width;
		this.height = height;

		// Resize render targets
		this.varianceTarget.setSize( width, height );
		this.prevMomentsTarget.setSize( width, height );

		// Update resolution uniform
		this.varianceMaterial.uniforms.resolution.value.set( width, height );

	}

	/**
	 * Main render method
	 */
	render( context, writeBuffer ) {

		if ( ! this.enabled ) return;

		const renderer = this.renderer || context.renderer;
		if ( ! renderer ) {

			this.warn( 'No renderer available' );
			return;

		}

		// Get input color texture from context
		const colorTexture = context.getTexture( this.inputTextureName );
		if ( ! colorTexture ) {

			// Input not ready, skip
			return;

		}

		// Optional: get external history length texture
		const historyLengthTexture = this.historyLengthTextureName
			? context.getTexture( this.historyLengthTextureName )
			: null;

		// Increment frame count
		this.frameCount ++;

		// Compute variance
		this.computeVariance( renderer, colorTexture, historyLengthTexture );

		// Publish output to context
		context.setTexture( this.outputTextureName, this.varianceTarget.texture );

		// Also publish with legacy naming for backward compatibility
		context.setTexture( 'variance:temporal', this.varianceTarget.texture );
		context.setTexture( 'variance:spatial', this.varianceTarget.texture );

		// Update first frame flag
		this.isFirstFrame = false;

	}

	/**
	 * Compute variance estimation
	 */
	computeVariance( renderer, colorTexture, historyLengthTexture ) {

		const uniforms = this.varianceMaterial.uniforms;

		// Set uniforms
		uniforms.tColor.value = colorTexture;
		uniforms.tPrevMoments.value = this.prevMomentsTarget.texture;
		uniforms.tHistoryLength.value = historyLengthTexture;
		uniforms.hasExternalHistory.value = historyLengthTexture !== null;
		uniforms.isFirstFrame.value = this.isFirstFrame;
		uniforms.frameCount.value = this.frameCount;

		// Render variance
		const currentRT = renderer.getRenderTarget();
		renderer.setRenderTarget( this.varianceTarget );
		this.varianceQuad.render( renderer );

		// Store current moments for next frame
		this.copyMaterial.uniforms.tDiffuse.value = this.varianceTarget.texture;
		renderer.setRenderTarget( this.prevMomentsTarget );
		this.copyQuad.render( renderer );

		renderer.setRenderTarget( currentRT );

	}

	/**
	 * Direct compute method for standalone use (not via pipeline)
	 * Returns the variance texture directly
	 */
	compute( renderer, colorTexture, historyLengthTexture = null ) {

		this.frameCount ++;
		this.computeVariance( renderer, colorTexture, historyLengthTexture );
		this.isFirstFrame = false;
		return this.varianceTarget.texture;

	}

	/**
	 * Get variance texture directly
	 */
	getVarianceTexture() {

		return this.varianceTarget.texture;

	}

	/**
	 * Get temporal variance value at a specific UV coordinate
	 * Note: This requires reading back from GPU - use sparingly
	 */
	getTemporalVariance() {

		return {
			texture: this.varianceTarget.texture,
			// R = mean, G = secondMoment, B = temporal variance, A = spatial variance
			temporalChannel: 'b',
			spatialChannel: 'a'
		};

	}

	/**
	 * Check if a pixel is likely a firefly based on variance
	 * This is a utility for downstream stages
	 */
	getFireflyThreshold() {

		return this.params.fireflyThreshold;

	}

	/**
	 * Dispose resources
	 */
	dispose() {

		// Dispose render targets
		this.varianceTarget.dispose();
		this.prevMomentsTarget.dispose();

		// Dispose materials
		this.varianceMaterial.dispose();
		this.copyMaterial.dispose();

		// Dispose quads
		this.varianceQuad.dispose();
		this.copyQuad.dispose();

	}

}
