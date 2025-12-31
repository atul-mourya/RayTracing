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
 * BilateralFilteringStage - Edge-aware A-trous wavelet filtering
 *
 * A standalone bilateral filtering stage that can be used for:
 * - Denoising path tracer output
 * - Edge-aware upsampling
 * - Post-processing blur with edge preservation
 * - Super-resolution detail injection
 *
 * This stage implements an A-trous wavelet filter with edge-stopping functions
 * based on:
 * - Luminance similarity
 * - Normal similarity
 * - Depth similarity
 * - Color difference
 *
 * Unlike the full ASVGF denoiser, this stage has NO temporal dependencies
 * and works on any single frame with color + normal/depth data.
 *
 * Execution: CONFIGURABLE - Can run per-frame or per-cycle
 *
 * Events listened to:
 * - bilateralFiltering:updateParameters - Updates filter parameters
 * - pipeline:reset - Resets state
 *
 * Textures read from context:
 * - Input texture (configurable, default: 'pathtracer:color')
 * - Normal/depth texture (configurable, default: 'pathtracer:normalDepth')
 * - Optional: variance texture for guided filtering
 * - Optional: history length texture for adaptive filtering
 *
 * Textures published to context:
 * - bilateralFiltering:output - Filtered output
 */
export class BilateralFilteringStage extends PipelineStage {

	constructor( options = {} ) {

		super( 'BilateralFiltering', {
			...options,
			executionMode: options.executionMode ?? StageExecutionMode.ALWAYS
		} );

		this.renderer = options.renderer || null;
		this.width = options.width || 1920;
		this.height = options.height || 1080;

		// Configurable input texture names (allows reuse in different contexts)
		this.inputTextureName = options.inputTextureName ?? 'pathtracer:color';
		this.normalDepthTextureName = options.normalDepthTextureName ?? 'pathtracer:normalDepth';
		this.varianceTextureName = options.varianceTextureName ?? 'asvgf:variance';
		this.historyLengthTextureName = options.historyLengthTextureName ?? 'asvgf:temporalColor';

		// Output texture name
		this.outputTextureName = options.outputTextureName ?? 'bilateralFiltering:output';

		// Filter parameters
		this.params = {
			// Edge-stopping parameters
			phiColor: options.phiColor ?? 10.0,
			phiNormal: options.phiNormal ?? 128.0,
			phiDepth: options.phiDepth ?? 1.0,
			phiLuminance: options.phiLuminance ?? 4.0,

			// A-trous parameters
			iterations: options.iterations ?? 4,
			stepSizeMultiplier: options.stepSizeMultiplier ?? 2.0, // Step size = stepSizeMultiplier^iteration

			// Optional variance-guided filtering
			useVarianceGuide: options.useVarianceGuide ?? false,
			varianceBoost: options.varianceBoost ?? 1.0,

			// Optional history-adaptive filtering
			useHistoryAdaptive: options.useHistoryAdaptive ?? false,
			historyFadeStart: options.historyFadeStart ?? 10.0,
			historyFadeEnd: options.historyFadeEnd ?? 20.0,

			...options
		};

		// Initialize render targets
		this.initRenderTargets();

		// Initialize materials
		this.initMaterials();

		// Create fullscreen quad
		this.filterQuad = new FullScreenQuad( this.filterMaterial );

	}

	initRenderTargets() {

		const targetOptions = {
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false
		};

		// Ping-pong buffers for iterative filtering
		this.filterTargetA = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.filterTargetB = new WebGLRenderTarget( this.width, this.height, targetOptions );

		// Final output
		this.outputTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );

	}

	initMaterials() {

		// A-trous wavelet bilateral filter
		this.filterMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tVariance: { value: null },
				tNormalDepth: { value: null },
				tHistoryLength: { value: null },

				resolution: { value: new Vector2( this.width, this.height ) },
				stepSize: { value: 1 },
				iteration: { value: 0 },

				phiColor: { value: this.params.phiColor },
				phiNormal: { value: this.params.phiNormal },
				phiDepth: { value: this.params.phiDepth },
				phiLuminance: { value: this.params.phiLuminance },

				useVarianceGuide: { value: this.params.useVarianceGuide },
				varianceBoost: { value: this.params.varianceBoost },

				useHistoryAdaptive: { value: this.params.useHistoryAdaptive },
				historyFadeStart: { value: this.params.historyFadeStart },
				historyFadeEnd: { value: this.params.historyFadeEnd }
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
				uniform sampler2D tVariance;
				uniform sampler2D tNormalDepth;
				uniform sampler2D tHistoryLength;

				uniform vec2 resolution;
				uniform int stepSize;
				uniform int iteration;

				uniform float phiColor;
				uniform float phiNormal;
				uniform float phiDepth;
				uniform float phiLuminance;

				uniform bool useVarianceGuide;
				uniform float varianceBoost;

				uniform bool useHistoryAdaptive;
				uniform float historyFadeStart;
				uniform float historyFadeEnd;

				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				// A-trous wavelet kernel (5x5)
				const float kernel[25] = float[](
					1.0/256.0, 4.0/256.0, 6.0/256.0, 4.0/256.0, 1.0/256.0,
					4.0/256.0, 16.0/256.0, 24.0/256.0, 16.0/256.0, 4.0/256.0,
					6.0/256.0, 24.0/256.0, 36.0/256.0, 24.0/256.0, 6.0/256.0,
					4.0/256.0, 16.0/256.0, 24.0/256.0, 16.0/256.0, 4.0/256.0,
					1.0/256.0, 4.0/256.0, 6.0/256.0, 4.0/256.0, 1.0/256.0
				);

				const ivec2 offsets[25] = ivec2[](
					ivec2(-2,-2), ivec2(-1,-2), ivec2(0,-2), ivec2(1,-2), ivec2(2,-2),
					ivec2(-2,-1), ivec2(-1,-1), ivec2(0,-1), ivec2(1,-1), ivec2(2,-1),
					ivec2(-2,0), ivec2(-1,0), ivec2(0,0), ivec2(1,0), ivec2(2,0),
					ivec2(-2,1), ivec2(-1,1), ivec2(0,1), ivec2(1,1), ivec2(2,1),
					ivec2(-2,2), ivec2(-1,2), ivec2(0,2), ivec2(1,2), ivec2(2,2)
				);

				void main() {
					vec2 texelSize = 1.0 / resolution;

					vec3 centerColor = texture2D(tColor, vUv).rgb;
					vec4 centerNormalDepth = texture2D(tNormalDepth, vUv);

					float centerLuma = getLuma(centerColor);
					vec3 centerNormal = centerNormalDepth.xyz;
					float centerDepth = centerNormalDepth.w;

					// Compute filter strength modifiers
					float filterStrength = 1.0;
					float centerHistoryLength = 1.0;

					// History-adaptive filtering: reduce filtering as history accumulates
					if (useHistoryAdaptive) {
						vec4 historyData = texture2D(tHistoryLength, vUv);
						centerHistoryLength = historyData.a; // History stored in alpha

						// Fade out filtering as history increases
						float historyFactor = clamp(
							(centerHistoryLength - historyFadeStart) / (historyFadeEnd - historyFadeStart),
							0.0, 1.0
						);
						filterStrength = 1.0 - historyFactor * 0.7; // 100% -> 30% strength
					}

					// Variance-guided sigma for luminance edge-stopping
					float sigma_l = phiLuminance;
					if (useVarianceGuide) {
						vec4 variance = texture2D(tVariance, vUv);
						// Use spatial variance (.w) for better noise estimation
						float spatialVariance = variance.w * varianceBoost;
						sigma_l = phiLuminance * sqrt(max(spatialVariance, 1e-6)) * filterStrength;
					}

					float sigma_n = phiNormal;
					float sigma_z = phiDepth;

					vec3 weightedSum = vec3(0.0);
					float weightSum = 0.0;

					for (int i = 0; i < 25; i++) {
						vec2 offset = vec2(offsets[i]) * float(stepSize) * texelSize;
						vec2 sampleUV = vUv + offset;

						if (sampleUV.x < 0.0 || sampleUV.x > 1.0 ||
							sampleUV.y < 0.0 || sampleUV.y > 1.0) {
							continue;
						}

						vec3 sampleColor = texture2D(tColor, sampleUV).rgb;
						vec4 sampleNormalDepth = texture2D(tNormalDepth, sampleUV);

						float sampleLuma = getLuma(sampleColor);
						vec3 sampleNormal = sampleNormalDepth.xyz;
						float sampleDepth = sampleNormalDepth.w;

						// Edge-stopping functions
						float w_l = exp(-abs(centerLuma - sampleLuma) / max(sigma_l, 1e-6));
						float w_n = pow(max(0.0, dot(centerNormal, sampleNormal)), sigma_n);
						float w_z = exp(-abs(centerDepth - sampleDepth) / (sigma_z * max(centerDepth, 1e-3)));

						// Additional color-based edge detection for high-frequency details
						vec3 colorDiff = abs(centerColor - sampleColor);
						float maxColorDiff = max(max(colorDiff.r, colorDiff.g), colorDiff.b);
						float w_c = exp(-maxColorDiff * phiColor * filterStrength);

						// Optional: History-based weight (trust pixels with more samples)
						float historyWeight = 1.0;
						if (useHistoryAdaptive) {
							vec4 sampleHistoryData = texture2D(tHistoryLength, sampleUV);
							float sampleHistoryLength = sampleHistoryData.a;
							historyWeight = min(sampleHistoryLength / max(centerHistoryLength, 1.0), 2.0);
						}

						float weight = kernel[i] * w_l * w_n * w_z * w_c * historyWeight;

						weightedSum += sampleColor * weight;
						weightSum += weight;
					}

					// Compute filtered result
					vec3 filteredColor;
					if (weightSum > 1e-6) {
						filteredColor = weightedSum / weightSum;
					} else {
						filteredColor = centerColor;
					}

					// Optional: Blend with original based on history (fade out spatial filtering)
					if (useHistoryAdaptive) {
						float historyFactor = clamp(centerHistoryLength / historyFadeEnd, 0.0, 1.0);
						filteredColor = mix(filteredColor, centerColor, historyFactor * 0.5);
					}

					gl_FragColor = vec4(filteredColor, 1.0);
				}
			`
		} );

		// Copy material for final output
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
		this.on( 'bilateralFiltering:updateParameters', ( data ) => {

			if ( data ) this.updateParameters( data );

		} );

		// Listen for pipeline reset
		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

	}

	/**
	 * Update filter parameters
	 */
	updateParameters( params ) {

		Object.assign( this.params, params );

		// Update shader uniforms
		const uniforms = this.filterMaterial.uniforms;
		uniforms.phiColor.value = this.params.phiColor;
		uniforms.phiNormal.value = this.params.phiNormal;
		uniforms.phiDepth.value = this.params.phiDepth;
		uniforms.phiLuminance.value = this.params.phiLuminance;
		uniforms.useVarianceGuide.value = this.params.useVarianceGuide;
		uniforms.varianceBoost.value = this.params.varianceBoost;
		uniforms.useHistoryAdaptive.value = this.params.useHistoryAdaptive;
		uniforms.historyFadeStart.value = this.params.historyFadeStart;
		uniforms.historyFadeEnd.value = this.params.historyFadeEnd;

	}

	/**
	 * Set number of filter iterations
	 */
	setIterations( iterations ) {

		this.params.iterations = iterations;

	}

	/**
	 * Configure input/output texture names
	 */
	setTextureNames( config ) {

		if ( config.input ) this.inputTextureName = config.input;
		if ( config.normalDepth ) this.normalDepthTextureName = config.normalDepth;
		if ( config.variance ) this.varianceTextureName = config.variance;
		if ( config.historyLength ) this.historyLengthTextureName = config.historyLength;
		if ( config.output ) this.outputTextureName = config.output;

	}

	/**
	 * Reset state
	 */
	reset() {

		// Clear render targets
		if ( this.renderer ) {

			const currentRT = this.renderer.getRenderTarget();

			this.renderer.setRenderTarget( this.filterTargetA );
			this.renderer.clear();

			this.renderer.setRenderTarget( this.filterTargetB );
			this.renderer.clear();

			this.renderer.setRenderTarget( this.outputTarget );
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
		this.filterTargetA.setSize( width, height );
		this.filterTargetB.setSize( width, height );
		this.outputTarget.setSize( width, height );

		// Update resolution uniform
		this.filterMaterial.uniforms.resolution.value.set( width, height );

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

		// Get input textures from context
		const colorTexture = context.getTexture( this.inputTextureName );
		const normalDepthTexture = context.getTexture( this.normalDepthTextureName );

		if ( ! colorTexture || ! normalDepthTexture ) {

			// Input textures not ready, skip
			return;

		}

		// Optional textures for guided/adaptive filtering
		const varianceTexture = this.params.useVarianceGuide
			? context.getTexture( this.varianceTextureName )
			: null;

		const historyLengthTexture = this.params.useHistoryAdaptive
			? context.getTexture( this.historyLengthTextureName )
			: null;

		// Run the bilateral filter
		this.applyFilter( renderer, colorTexture, normalDepthTexture, varianceTexture, historyLengthTexture );

		// Publish output to context
		context.setTexture( this.outputTextureName, this.outputTarget.texture );

		// Copy to writeBuffer if provided
		if ( writeBuffer && ! this.renderToScreen ) {

			this.copyTexture( renderer, this.outputTarget, writeBuffer );

		}

	}

	/**
	 * Apply bilateral filter with iterative A-trous wavelet
	 */
	applyFilter( renderer, colorTexture, normalDepthTexture, varianceTexture, historyLengthTexture ) {

		// Set static uniforms
		const uniforms = this.filterMaterial.uniforms;
		uniforms.tNormalDepth.value = normalDepthTexture;
		uniforms.tVariance.value = varianceTexture;
		uniforms.tHistoryLength.value = historyLengthTexture;

		// Iterative A-trous filtering
		let inputTexture = colorTexture;
		let currentOutput = this.filterTargetA;
		let nextOutput = this.filterTargetB;

		const currentRT = renderer.getRenderTarget();

		for ( let i = 0; i < this.params.iterations; i ++ ) {

			// Set iteration-specific uniforms
			uniforms.tColor.value = inputTexture;
			uniforms.stepSize.value = Math.pow( this.params.stepSizeMultiplier, i );
			uniforms.iteration.value = i;

			// Render to current output
			renderer.setRenderTarget( currentOutput );
			this.filterQuad.render( renderer );

			// Swap for next iteration
			inputTexture = currentOutput.texture;
			[ currentOutput, nextOutput ] = [ nextOutput, currentOutput ];

		}

		// Copy final result to output target
		this.copyMaterial.uniforms.tDiffuse.value = inputTexture;
		renderer.setRenderTarget( this.outputTarget );
		this.copyQuad.render( renderer );

		renderer.setRenderTarget( currentRT );

	}

	/**
	 * Direct filter method for standalone use (not via pipeline)
	 * Returns the output texture directly
	 */
	filter( renderer, colorTexture, normalDepthTexture, varianceTexture = null, historyLengthTexture = null ) {

		this.applyFilter( renderer, colorTexture, normalDepthTexture, varianceTexture, historyLengthTexture );
		return this.outputTarget.texture;

	}

	/**
	 * Copy texture helper
	 */
	copyTexture( renderer, source, destination ) {

		const currentRT = renderer.getRenderTarget();

		this.copyMaterial.uniforms.tDiffuse.value = source.texture || source;
		renderer.setRenderTarget( destination );
		this.copyQuad.render( renderer );

		renderer.setRenderTarget( currentRT );

	}

	/**
	 * Get output texture directly
	 */
	getOutputTexture() {

		return this.outputTarget.texture;

	}

	/**
	 * Dispose resources
	 */
	dispose() {

		// Dispose render targets
		this.filterTargetA.dispose();
		this.filterTargetB.dispose();
		this.outputTarget.dispose();

		// Dispose materials
		this.filterMaterial.dispose();
		this.copyMaterial.dispose();

		// Dispose quads
		this.filterQuad.dispose();
		this.copyQuad.dispose();

	}

}
