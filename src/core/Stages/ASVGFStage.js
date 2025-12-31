import {
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	Vector2,
	NearestFilter,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';
import { DEFAULT_STATE } from '../../Constants.js';

/**
 * ASVGFStage - Adaptive Spatially Varying Gradient Filter (ASVGF) denoiser
 *
 * Refactored from ASVGFPass to use the new pipeline architecture.
 *
 * Execution: PER_CYCLE - Only runs when tile rendering cycle completes
 * This ensures the denoiser works on complete frame data and prevents artifacts
 * from denoising intermediate tile states.
 *
 * Key changes from ASVGFPass:
 * - Extends PipelineStage instead of Pass
 * - Reads PathTracer MRT textures from context
 * - Reads interaction mode state from context instead of window.pathTracerApp
 * - Listens to events for parameter updates
 * - Publishes temporal color and variance textures to context
 *
 * Events listened to:
 * - asvgf:updateParameters - Updates ASVGF parameters
 * - asvgf:setTemporal - Enables/disables temporal accumulation
 * - asvgf:reset - Resets temporal history
 * - pipeline:reset - Resets state
 *
 * Textures published to context:
 * - asvgf:output - Final denoised output
 * - asvgf:temporalColor - Temporal accumulation result
 * - asvgf:variance - Variance estimation
 */
export class ASVGFStage extends PipelineStage {

	constructor( options = {} ) {

		super( 'ASVGF', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE // Only denoise complete frames
		} );

		this.renderer = options.renderer || null;
		this.camera = options.camera || null;
		this.width = options.width || 1920;
		this.height = options.height || 1080;

		// ASVGF parameters with proper defaults
		this.params = {
			// Temporal parameters
			temporalAlpha: options.temporalAlpha ?? 0.1,
			temporalColorWeight: options.temporalColorWeight ?? 0.1,
			temporalNormalWeight: options.temporalNormalWeight ?? 0.1,
			temporalDepthWeight: options.temporalDepthWeight ?? 0.1,

			// Temporal gradient parameters (A-SVGF)
			enableTemporalGradient: options.enableTemporalGradient ?? true,
			gradientScale: options.gradientScale ?? 2.0,
			gradientMin: options.gradientMin ?? 0.01,
			gradientMax: options.gradientMax ?? 0.5,
			use3x3Gradient: options.use3x3Gradient ?? true,

			// Variance parameters
			varianceClip: options.varianceClip ?? 1.0,
			maxAccumFrames: options.maxAccumFrames ?? 32,

			// Edge-stopping parameters
			phiColor: options.phiColor ?? 10.0,
			phiNormal: options.phiNormal ?? 128.0,
			phiDepth: options.phiDepth ?? 1.0,
			phiLuminance: options.phiLuminance ?? 4.0,

			// A-trous parameters
			atrousIterations: options.atrousIterations ?? 4,
			filterSize: options.filterSize ?? 5,
			varianceBoost: options.varianceBoost ?? 1.0,

			// Debug options
			enableDebug: options.enableDebug ?? false,
			debugMode: options.debugMode ?? 0, // 0: off, 1: variance, 2: history, 3: motion, 4: normal, 5: temporal gradient

			...options
		};

		// Create render targets
		this.initRenderTargets();

		// Initialize shaders
		this.initMaterials();

		// Frame tracking
		this.frameCount = 0;
		this.isFirstFrame = true;

		// Tile handling state
		this.temporalEnabled = true;
		this.tileMode = false;
		this.lastTileIndex = - 1;

		// Create fullscreen quads
		this.temporalQuad = new FullScreenQuad( this.temporalMaterial );
		this.varianceQuad = new FullScreenQuad( this.varianceMaterial );
		this.atrousQuad = new FullScreenQuad( this.atrousMaterial );
		this.gradientQuad = new FullScreenQuad( this.gradientMaterial );
		this.finalQuad = new FullScreenQuad( this.finalMaterial );

		// Initialize heatmap system
		this.initHeatmapVisualization();

	}

	initRenderTargets() {

		const targetOptions = {
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false
		};

		const nearestTargetOptions = {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false
		};

		// Temporal accumulation targets
		this.temporalColorTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.temporalMomentsTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.temporalHistoryLengthTarget = new WebGLRenderTarget( this.width, this.height, nearestTargetOptions );

		// Previous frame storage
		this.prevColorTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.prevMomentsTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.prevHistoryLengthTarget = new WebGLRenderTarget( this.width, this.height, nearestTargetOptions );
		this.prevNormalDepthTarget = new WebGLRenderTarget( this.width, this.height, nearestTargetOptions );

		// Variance estimation
		this.varianceTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );

		// Temporal gradient estimation (A-SVGF)
		this.temporalGradientTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.prevGradientTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );

		// A-trous filtering (ping-pong)
		this.atrousTargetA = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.atrousTargetB = new WebGLRenderTarget( this.width, this.height, targetOptions );

		// Final output
		this.outputTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );

	}

	initMaterials() {

		// NOTE: Motion vectors are now provided by MotionVectorStage
		// ASVGF reads them from context via 'motionVector:screenSpace'

		// Temporal gradient estimation (A-SVGF)
		this.gradientMaterial = new ShaderMaterial( {
			uniforms: {
				tCurrentColor: { value: null },
				tPrevColor: { value: null },
				tMotion: { value: null },
				tCurrentNormalDepth: { value: null },
				tPrevNormalDepth: { value: null },
				resolution: { value: new Vector2( this.width, this.height ) },
				use3x3: { value: this.params.use3x3Gradient },
				gradientScale: { value: this.params.gradientScale }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tCurrentColor;
				uniform sampler2D tPrevColor;
				uniform sampler2D tMotion;
				uniform sampler2D tCurrentNormalDepth;
				uniform sampler2D tPrevNormalDepth;
				uniform vec2 resolution;
				uniform bool use3x3;
				uniform float gradientScale;

				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				// Select brightest pixel from 3x3 neighborhood (A-SVGF paper technique)
				vec2 selectBrightestSample(vec2 centerUV, sampler2D colorTex) {
					vec2 texelSize = 1.0 / resolution;
					float maxLuma = -1.0;
					vec2 brightestUV = centerUV;

					for (int x = -1; x <= 1; x++) {
						for (int y = -1; y <= 1; y++) {
							vec2 offset = vec2(float(x), float(y)) * texelSize;
							vec2 sampleUV = centerUV + offset;

							if (sampleUV.x >= 0.0 && sampleUV.x <= 1.0 &&
								sampleUV.y >= 0.0 && sampleUV.y <= 1.0) {
								vec3 sampleColor = texture2D(colorTex, sampleUV).rgb;
								float sampleLuma = getLuma(sampleColor);

								if (sampleLuma > maxLuma) {
									maxLuma = sampleLuma;
									brightestUV = sampleUV;
								}
							}
						}
					}

					return brightestUV;
				}

				void main() {
					vec4 motion = texture2D(tMotion, vUv);

					// Check if motion is valid
					bool validMotion = (motion.x < 100.0);

					if (!validMotion) {
						// Invalid motion, cannot compute gradient
						gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
						return;
					}

					vec2 prevUV = vUv - motion.xy;

					// Validate reprojected UV
					if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) {
						gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
						return;
					}

					// Get current and previous samples
					vec2 currentSampleUV = vUv;
					vec2 prevSampleUV = prevUV;

					// Optional: Select brightest pixel from 3x3 neighborhood (A-SVGF technique)
					if (use3x3) {
						currentSampleUV = selectBrightestSample(vUv, tCurrentColor);
					}

					vec3 currentColor = texture2D(tCurrentColor, currentSampleUV).rgb;
					vec3 prevColor = texture2D(tPrevColor, prevSampleUV).rgb;

					// Compute temporal gradient (color difference between frames)
					vec3 colorGradient = abs(currentColor - prevColor);

					// Convert to luminance gradient
					float lumaGradient = getLuma(colorGradient);

					// Normalize by average intensity to make gradient relative
					float avgIntensity = (getLuma(currentColor) + getLuma(prevColor)) * 0.5;
					lumaGradient = lumaGradient / max(avgIntensity, 1e-3);

					// Scale and store gradient
					// .r = luminance gradient, .g = max color channel gradient, .b = avgIntensity, .a = validity
					float maxChannelGradient = max(max(colorGradient.r, colorGradient.g), colorGradient.b);

					gl_FragColor = vec4(
						lumaGradient * gradientScale,
						maxChannelGradient * gradientScale,
						avgIntensity,
						1.0
					);
				}
			`
		} );

		// Temporal accumulation with variance
		this.temporalMaterial = new ShaderMaterial( {
			uniforms: {
				tCurrentColor: { value: null },
				tCurrentNormalDepth: { value: null },
				tMotion: { value: null },
				tPrevColor: { value: null },
				tPrevMoments: { value: null },
				tPrevHistoryLength: { value: null },
				tPrevNormalDepth: { value: null },
				tTemporalGradient: { value: null },

				temporalAlpha: { value: this.params.temporalAlpha },
				temporalColorWeight: { value: this.params.temporalColorWeight },
				temporalNormalWeight: { value: this.params.temporalNormalWeight },
				temporalDepthWeight: { value: this.params.temporalDepthWeight },
				varianceClip: { value: this.params.varianceClip },
				maxAccumFrames: { value: this.params.maxAccumFrames },

				enableTemporalGradient: { value: this.params.enableTemporalGradient },
				gradientMin: { value: this.params.gradientMin },
				gradientMax: { value: this.params.gradientMax },

				isFirstFrame: { value: true },
				frameCount: { value: 0 },
				resolution: { value: new Vector2( this.width, this.height ) },
				hasMotionVectors: { value: false }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tCurrentColor;
				uniform sampler2D tCurrentNormalDepth;
				uniform sampler2D tMotion;
				uniform sampler2D tPrevColor;
				uniform sampler2D tPrevMoments;
				uniform sampler2D tPrevHistoryLength;
				uniform sampler2D tPrevNormalDepth;
				uniform sampler2D tTemporalGradient;

				uniform float temporalAlpha;
				uniform float temporalColorWeight;
				uniform float temporalNormalWeight;
				uniform float temporalDepthWeight;
				uniform float varianceClip;
				uniform float maxAccumFrames;

				uniform bool enableTemporalGradient;
				uniform float gradientMin;
				uniform float gradientMax;

				uniform bool isFirstFrame;
				uniform float frameCount;
				uniform vec2 resolution;

				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				float computeWeight(vec3 currentNormal, vec3 prevNormal, float currentDepth, float prevDepth, vec3 currentColor, vec3 prevColor) {
					// Normal similarity
					float normalWeight = max(0.0, dot(currentNormal, prevNormal));
					normalWeight = pow(normalWeight, temporalNormalWeight);

					// Depth similarity
					float depthDiff = abs(currentDepth - prevDepth) / max(currentDepth, 1e-6);
					float depthWeight = exp(-depthDiff / temporalDepthWeight);

					// Color similarity
					float colorDiff = length(currentColor - prevColor);
					float colorWeight = exp(-colorDiff / temporalColorWeight);

					return normalWeight * depthWeight * colorWeight;
				}

				// Compute gradient-adaptive alpha (A-SVGF core algorithm)
				float computeGradientAdaptiveAlpha(float temporalGradient, float historyLength, float baseAlpha) {
					// Clamp gradient to valid range
					float clampedGradient = clamp(temporalGradient, gradientMin, gradientMax);

					// Map gradient to alpha modulation factor
					// High gradient = more change = higher alpha (less history accumulation)
					// Low gradient = static scene = lower alpha (more history accumulation)
					float gradientFactor = (clampedGradient - gradientMin) / (gradientMax - gradientMin);

					// Base alpha from history length
					float historyAlpha = max(baseAlpha, 1.0 / historyLength);

					// Modulate alpha based on gradient
					// gradientFactor = 0 (low gradient): use low alpha (more accumulation)
					// gradientFactor = 1 (high gradient): use high alpha (less accumulation, faster adaptation)
					float adaptiveAlpha = mix(historyAlpha, 1.0, gradientFactor * 0.8);

					return clamp(adaptiveAlpha, baseAlpha, 1.0);
				}

				void main() {
					vec4 currentColor = texture2D(tCurrentColor, vUv);
					vec4 currentNormalDepth = texture2D(tCurrentNormalDepth, vUv);
					vec4 motion = texture2D(tMotion, vUv);

					if (isFirstFrame) {
						// Initialize temporal accumulation
						float luma = getLuma(currentColor.rgb);
						gl_FragColor = vec4(currentColor.rgb, 1.0); // Store in temporalColorTarget
						return;
					}

					vec2 prevUV = vUv - motion.xy;

					// Check if reprojection is valid
					bool validReprojection = (motion.x < 100.0) &&
											(prevUV.x >= 0.0) && (prevUV.x <= 1.0) &&
											(prevUV.y >= 0.0) && (prevUV.y <= 1.0);

					if (!validReprojection) {
						// No valid history, use current frame
						gl_FragColor = vec4(currentColor.rgb, 1.0);
						return;
					}

					// Sample previous frame data
					vec4 prevColor = texture2D(tPrevColor, prevUV);
					vec4 prevMoments = texture2D(tPrevMoments, prevUV);
					vec4 prevHistoryData = texture2D(tPrevHistoryLength, prevUV);
					vec4 prevNormalDepth = texture2D(tPrevNormalDepth, prevUV);

					// Compute similarity weight
					float weight = computeWeight(
						currentNormalDepth.xyz,
						prevNormalDepth.xyz,
						currentNormalDepth.w,
						prevNormalDepth.w,
						currentColor.rgb,
						prevColor.rgb
					);

					// History length (stored in alpha channel)
					float prevHistory = prevHistoryData.a;
					float historyLength = min(prevHistory + 1.0, maxAccumFrames);

					// Compute alpha - either gradient-adaptive or history-based
					float alpha;
					if (enableTemporalGradient) {
						// A-SVGF: Use temporal gradient for adaptive alpha
						vec4 gradient = texture2D(tTemporalGradient, vUv);
						float temporalGradient = gradient.r; // Luminance gradient
						bool validGradient = gradient.a > 0.5;

						if (validGradient) {
							alpha = computeGradientAdaptiveAlpha(temporalGradient, historyLength, temporalAlpha);
						} else {
							// Fallback to history-based alpha
							alpha = max(temporalAlpha, 1.0 / historyLength);
						}
					} else {
						// Standard SVGF: History-based alpha only
						alpha = max(temporalAlpha, 1.0 / historyLength);
					}

					// Further modulate alpha by similarity weight
					alpha *= (1.0 - weight * 0.5); // Reduce accumulation for dissimilar pixels

					// Temporal accumulation
					vec3 temporalColor = mix(prevColor.rgb, currentColor.rgb, alpha);

					gl_FragColor = vec4(temporalColor, historyLength);
				}
			`
		} );

		// Variance estimation
		this.varianceMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tPrevMoments: { value: null },
				tHistoryLength: { value: null },
				resolution: { value: new Vector2( this.width, this.height ) },
				varianceBoost: { value: this.params.varianceBoost }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tColor;
				uniform sampler2D tPrevMoments;
				uniform sampler2D tHistoryLength;
				uniform vec2 resolution;
				uniform float varianceBoost;
				
				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				void main() {
					vec3 currentColor = texture2D(tColor, vUv).rgb;
					float currentLuma = getLuma(currentColor);
					vec4 historyData = texture2D(tHistoryLength, vUv);
					float historyLength = historyData.a; // History is in alpha channel

					// Get previous moments
					vec4 prevMoments = texture2D(tPrevMoments, vUv);
					float prevMean = prevMoments.x;
					float prevSecondMoment = prevMoments.y;

					// Temporal accumulation of moments
					float alpha = 1.0 / max(historyLength, 1.0);
					float newMean = mix(prevMean, currentLuma, alpha);
					float newSecondMoment = mix(prevSecondMoment, currentLuma * currentLuma, alpha);
					
					// Compute variance
					float variance = max(0.0, newSecondMoment - newMean * newMean);
					variance *= varianceBoost;
					
					// Compute 3x3 neighborhood variance for spatial filtering guidance
					vec2 texelSize = 1.0 / resolution;
					float neighborhoodVariance = 0.0;
					float count = 0.0;
					
					for (int x = -1; x <= 1; x++) {
						for (int y = -1; y <= 1; y++) {
							vec2 offset = vec2(float(x), float(y)) * texelSize;
							vec3 neighborColor = texture2D(tColor, vUv + offset).rgb;
							float neighborLuma = getLuma(neighborColor);
							neighborhoodVariance += (neighborLuma - newMean) * (neighborLuma - newMean);
							count += 1.0;
						}
					}
					neighborhoodVariance /= count;
					
					gl_FragColor = vec4(newMean, newSecondMoment, variance, neighborhoodVariance);
				}
			`
		} );

		// A-trous wavelet filtering
		this.atrousMaterial = new ShaderMaterial( {
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
				phiLuminance: { value: this.params.phiLuminance }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
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
				
				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				// A-trous wavelet kernel
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
					vec4 centerVariance = texture2D(tVariance, vUv);
					vec4 centerHistory = texture2D(tHistoryLength, vUv);

					float centerLuma = getLuma(centerColor);
					vec3 centerNormal = centerNormalDepth.xyz;
					float centerDepth = centerNormalDepth.w;
					float centerHistoryLength = centerHistory.a; // History in alpha channel

					// Compute history-based filter strength
					// As history increases, reduce spatial filtering (fade out blocks)
					// History 1-10: full filtering, History 20-32: minimal filtering
					float historyFactor = clamp(centerHistoryLength / 20.0, 0.0, 1.0);
					float filterStrength = 1.0 - historyFactor * 0.7; // 100% -> 30% strength

					// Use variance to guide filter strength
					// Use spatial variance (.w) for better noise estimation
					float sigma_l = phiLuminance * sqrt(max(centerVariance.w, 1e-6)) * filterStrength;
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
						vec4 sampleHistoryData = texture2D(tHistoryLength, sampleUV);
						float sampleHistoryLength = sampleHistoryData.a; // History in alpha channel

						float sampleLuma = getLuma(sampleColor);
						vec3 sampleNormal = sampleNormalDepth.xyz;
						float sampleDepth = sampleNormalDepth.w;

						// Edge-stopping functions
						float w_l = exp(-abs(centerLuma - sampleLuma) / sigma_l);
						float w_n = pow(max(0.0, dot(centerNormal, sampleNormal)), sigma_n);
						float w_z = exp(-abs(centerDepth - sampleDepth) / (sigma_z * max(centerDepth, 1e-3)));

						// Additional color-based edge detection for high-frequency details (text, sharp edges)
						vec3 colorDiff = abs(centerColor - sampleColor);
						float maxColorDiff = max(max(colorDiff.r, colorDiff.g), colorDiff.b);
						float w_c = exp(-maxColorDiff * phiColor * filterStrength);

						// History-based weight (trust pixels with more samples)
						float historyWeight = min(sampleHistoryLength / max(centerHistoryLength, 1.0), 2.0);

						float weight = kernel[i] * w_l * w_n * w_z * w_c * historyWeight;

						weightedSum += sampleColor * weight;
						weightSum += weight;
					}

					// Blend filtered result with original based on history
					vec3 filteredColor;
					if (weightSum > 1e-6) {
						filteredColor = weightedSum / weightSum;
					} else {
						filteredColor = centerColor;
					}

					// Fade out spatial filtering as temporal history increases
					vec3 finalColor = mix(filteredColor, centerColor, historyFactor * 0.5);
					gl_FragColor = vec4(finalColor, 1.0);
				}
			`
		} );

		// Final composition - always shows beauty pass
		// Debug visualizations are shown in RenderTargetHelper overlay instead
		this.finalMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tOriginalColor: { value: null } // Original path tracer output for alpha
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tColor;
				uniform sampler2D tOriginalColor;
				varying vec2 vUv;

				void main() {
					// Always show final denoised output (beauty pass)
					vec3 color = texture2D(tColor, vUv).rgb;
					// Preserve alpha from original path tracer output for transparent background support
					float alpha = texture2D(tOriginalColor, vUv).a;
					gl_FragColor = vec4(color, alpha);
				}
			`
		} );

	}

	initHeatmapVisualization() {

		// Create heatmap render target
		this.heatmapTarget = new WebGLRenderTarget( this.width, this.height, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Create heatmap material
		this.heatmapMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tVariance: { value: null },
				tHistoryLength: { value: null },
				tNormalDepth: { value: null },
				tMotion: { value: null },
				tTemporalGradient: { value: null },
				heatmapMode: { value: this.debugMode }, // 0=beauty, 1=variance, 2=history, 3=motion, 4=normal, 5=temporal gradient
				intensityScale: { value: 1.0 }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tColor;
				uniform sampler2D tVariance;
				uniform sampler2D tHistoryLength;
				uniform sampler2D tNormalDepth;
				uniform sampler2D tMotion;
				uniform sampler2D tTemporalGradient;
				uniform int heatmapMode;
				uniform float intensityScale;

				varying vec2 vUv;

				vec3 heatmap(float value) {
					value = clamp(value, 0.0, 1.0);
					if (value < 0.25) {
						return mix(vec3(0.0, 0.0, 0.5), vec3(0.0, 0.0, 1.0), value * 4.0);
					} else if (value < 0.5) {
						return mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), (value - 0.25) * 4.0);
					} else if (value < 0.75) {
						return mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), (value - 0.5) * 4.0);
					} else {
						return mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (value - 0.75) * 4.0);
					}
				}

				void main() {
					vec3 color = vec3(0.0);
					float value = 0.0;

					if (heatmapMode == 0) {
						// Beauty pass (final denoised output)
						color = texture2D(tColor, vUv).rgb;
					} else if (heatmapMode == 1) {
						// Variance visualization
						vec4 variance = texture2D(tVariance, vUv);

						// Show spatial (neighborhood) variance instead of temporal variance
						// .z = temporal variance (converges quickly, less useful)
						// .w = neighborhood variance (shows actual spatial noise)
						float spatialVariance = variance.w;
						float temporalVariance = variance.z;

						// Use spatial variance for better noise visualization
						// Increased scaling to show noise more clearly
						value = sqrt(spatialVariance) * intensityScale * 50.0;
						color = heatmap(value);
					} else if (heatmapMode == 2) {
						// History length visualization
						// History is stored in alpha channel of temporalColorTarget
						vec4 history = texture2D(tHistoryLength, vUv);
						value = history.a / 32.0;
						color = heatmap(value);
					} else if (heatmapMode == 3) {
						// Motion vectors visualization
						vec4 motion = texture2D(tMotion, vUv);
						if (motion.x > 100.0) {
							color = vec3(1.0, 0.0, 1.0); // Magenta for invalid
						} else {
							color = vec3(
								abs(motion.x),
								abs(motion.y),
								clamp(motion.z, 0.0, 1.0)  // depth in blue channel
							);
						}
					} else if (heatmapMode == 4) {
						// Normal visualization
						vec3 normal = texture2D(tNormalDepth, vUv).xyz;
						color = normal * 0.5 + 0.5;
					} else if (heatmapMode == 5) {
						// Temporal gradient visualization
						vec4 gradient = texture2D(tTemporalGradient, vUv);
						float lumaGradient = gradient.r;
						bool validGradient = gradient.a > 0.5;

						if (!validGradient) {
							color = vec3(0.0, 0.0, 0.0); // Black for invalid
						} else {
							value = lumaGradient * intensityScale * 5.0;
							color = heatmap(value);
						}
					}

					gl_FragColor = vec4(color, 1.0);
				}
			`
		} );

		this.heatmapQuad = new FullScreenQuad( this.heatmapMaterial );

		// Create helper for visualization
		this.heatmapHelper = RenderTargetHelper( this.renderer, this.heatmapTarget, {
			width: 400,
			height: 400,
			position: 'bottom-left',
			theme: 'dark',
			title: 'ASVGF Debug Visualization',
			autoUpdate: false
		} );

		this.showHeatmap = DEFAULT_STATE.showAsvgfHeatmap;
		document.body.appendChild( this.heatmapHelper );

		// Hide helper by default as per constants
		if ( ! this.showHeatmap ) {

			this.heatmapHelper.hide();

		}

	}

	toggleHeatmap( enabled ) {

		this.showHeatmap = enabled;
		if ( enabled ) {

			this.heatmapHelper.show();

		} else {

			this.heatmapHelper.hide();

		}

	}

	updateHeatmapVisualization( renderer, normalDepthTexture, motionTexture = null ) {

		if ( ! this.showHeatmap || ! this.heatmapMaterial ) return;

		// Update heatmap uniforms
		this.heatmapMaterial.uniforms.tColor.value = this.outputTarget?.texture || null;
		this.heatmapMaterial.uniforms.tVariance.value = this.varianceTarget?.texture || null;
		this.heatmapMaterial.uniforms.tHistoryLength.value = this.temporalColorTarget?.texture || null;
		this.heatmapMaterial.uniforms.tNormalDepth.value = normalDepthTexture || null;
		// Use provided motion texture (from MotionVectorStage or internal)
		this.heatmapMaterial.uniforms.tMotion.value = motionTexture || this.currentMotionTexture || this.motionTarget?.texture || null;
		this.heatmapMaterial.uniforms.tTemporalGradient.value = this.temporalGradientTarget?.texture || null;

		// Render heatmap
		const currentRenderTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( this.heatmapTarget );
		this.heatmapQuad.render( renderer );
		renderer.setRenderTarget( currentRenderTarget );

		// Update helper
		this.heatmapHelper.update();

	}

	reset() {

		this.frameCount = 0;
		this.isFirstFrame = true;

		// Clear render targets
		const renderer = this.renderer;
		const currentRenderTarget = renderer.getRenderTarget();

		const targetsToClear = [
			this.temporalColorTarget,
			this.temporalMomentsTarget,
			this.temporalHistoryLengthTarget,
			this.prevColorTarget,
			this.prevMomentsTarget,
			this.prevHistoryLengthTarget,
			this.prevNormalDepthTarget,
			this.varianceTarget,
			this.temporalGradientTarget,
			this.prevGradientTarget
		];

		targetsToClear.forEach( target => {

			renderer.setRenderTarget( target );
			renderer.clear();

		} );

		renderer.setRenderTarget( currentRenderTarget );

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		// Resize all render targets
		const targets = [
			this.temporalColorTarget,
			this.temporalMomentsTarget,
			this.temporalHistoryLengthTarget,
			this.prevColorTarget,
			this.prevMomentsTarget,
			this.prevHistoryLengthTarget,
			this.prevNormalDepthTarget,
			this.varianceTarget,
			this.temporalGradientTarget,
			this.prevGradientTarget,
			this.atrousTargetA,
			this.atrousTargetB,
			this.outputTarget
		];

		targets.forEach( target => target.setSize( width, height ) );

		// Update resolution uniforms
		const resolutionVector = new Vector2( width, height );
		this.gradientMaterial.uniforms.resolution.value.copy( resolutionVector );
		this.temporalMaterial.uniforms.resolution.value.copy( resolutionVector );
		this.varianceMaterial.uniforms.resolution.value.copy( resolutionVector );
		this.atrousMaterial.uniforms.resolution.value.copy( resolutionVector );
		// Note: finalMaterial doesn't use resolution uniform (simple passthrough)

	}

	/**
	 * Setup event listeners for pipeline events
	 */
	setupEventListeners() {

		// Listen for parameter updates from other stages
		this.on( 'asvgf:updateParameters', ( data ) => {

			if ( data ) this.updateParameters( data );

		} );

		// Listen for temporal enable/disable
		this.on( 'asvgf:setTemporal', ( data ) => {

			if ( data && data.enabled !== undefined ) {

				this.setTemporalEnabled( data.enabled );

			}

		} );

		// Listen for reset requests
		this.on( 'asvgf:reset', () => {

			this.reset();

		} );

		// Listen for pipeline-wide reset
		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

	}

	updateParameters( params ) {

		Object.assign( this.params, params );

		// Update shader uniforms
		this.temporalMaterial.uniforms.temporalAlpha.value = this.params.temporalAlpha;
		this.temporalMaterial.uniforms.temporalColorWeight.value = this.params.temporalColorWeight;
		this.temporalMaterial.uniforms.temporalNormalWeight.value = this.params.temporalNormalWeight;
		this.temporalMaterial.uniforms.temporalDepthWeight.value = this.params.temporalDepthWeight;
		this.temporalMaterial.uniforms.varianceClip.value = this.params.varianceClip;
		this.temporalMaterial.uniforms.maxAccumFrames.value = this.params.maxAccumFrames;
		this.temporalMaterial.uniforms.enableTemporalGradient.value = this.params.enableTemporalGradient;
		this.temporalMaterial.uniforms.gradientMin.value = this.params.gradientMin;
		this.temporalMaterial.uniforms.gradientMax.value = this.params.gradientMax;

		this.gradientMaterial.uniforms.use3x3.value = this.params.use3x3Gradient;
		this.gradientMaterial.uniforms.gradientScale.value = this.params.gradientScale;

		this.varianceMaterial.uniforms.varianceBoost.value = this.params.varianceBoost;

		this.atrousMaterial.uniforms.phiColor.value = this.params.phiColor;
		this.atrousMaterial.uniforms.phiNormal.value = this.params.phiNormal;
		this.atrousMaterial.uniforms.phiDepth.value = this.params.phiDepth;
		this.atrousMaterial.uniforms.phiLuminance.value = this.params.phiLuminance;

		// Update heatmap mode (debug visualization shown in overlay, not main canvas)
		if ( this.heatmapMaterial ) {

			this.heatmapMaterial.uniforms.heatmapMode.value = this.params.debugMode || 0;

		}

		// Note: Final material no longer uses debug modes - always shows beauty pass
		// Debug visualizations are shown in the RenderTargetHelper overlay instead

		// Store original values for restoration
		if ( params.temporalAlpha !== undefined ) {

			this.originalTemporalAlpha = params.temporalAlpha;

		}

	}

	setTemporalEnabled( enabled ) {

		this.temporalEnabled = enabled;

		if ( enabled ) {

			// Normal temporal processing
			this.temporalMaterial.uniforms.temporalAlpha.value = this.params.temporalAlpha;

		} else {

			// Spatial-only mode for tiles
			this.temporalMaterial.uniforms.temporalAlpha.value = 1.0;

		}

	}

	// Enhanced render method with tile awareness
	/**
	 * Main render method - called by pipeline each frame
	 * @param {PipelineContext} context - Pipeline context
	 * @param {THREE.WebGLRenderTarget} writeBuffer - Output buffer
	 */
	render( context, writeBuffer ) {

		if ( ! this.enabled ) return;

		// Get renderer from context or use stored reference
		const renderer = this.renderer || context.renderer;

		if ( ! renderer ) {

			this.warn( 'No renderer available' );
			return;

		}

		// Read PathTracer MRT textures from context
		const colorTexture = context.getTexture( 'pathtracer:color' );
		const normalDepthTexture = context.getTexture( 'pathtracer:normalDepth' );

		if ( ! colorTexture || ! normalDepthTexture ) {

			this.warn( 'Missing PathTracer MRT textures in context' );
			return;

		}

		// Get motion vectors from MotionVectorStage
		const externalMotionTexture = context.getTexture( 'motionVector:screenSpace' );

		// Check interaction mode for adaptive processing
		const interactionMode = context.getState( 'interactionMode' );

		if ( interactionMode ) {

			// Fast path: copy raw path tracer color for immediate feedback
			this.renderInteractionFastCopy( renderer, colorTexture );

			// Still update heatmap during interaction so motion vectors can be visualized
			if ( externalMotionTexture ) {

				this.currentMotionTexture = externalMotionTexture;
				this.updateHeatmapVisualization( renderer, normalDepthTexture, externalMotionTexture );

			}

		} else {

			// Normal operation with full temporal processing
			this.renderWithTemporal( renderer, writeBuffer, colorTexture, normalDepthTexture, externalMotionTexture );

		}

		// Publish textures to context
		this.publishTexturesToContext( context );

	}

	/**
	 * Fast copy path used during interaction mode to keep responsiveness high.
	 * Avoids any temporal or spatial filtering cost.
	 */
	renderInteractionFastCopy( renderer, colorTexture ) {

		if ( ! this.outputTarget ) return;

		// Use existing copyTexture helper for reliability
		// Wrap colorTexture into an object with .texture to match expected interface
		const source = { texture: colorTexture };
		this.copyTexture( renderer, source, this.outputTarget );

	}

	renderWithTemporal( renderer, writeBuffer, colorTexture, normalDepthTexture, externalMotionTexture = null ) {

		// Full ASVGF pipeline
		this.frameCount ++;

		// Use external motion vectors from MotionVectorStage (required)
		const motionTexture = externalMotionTexture;

		// Step 1.5: Calculate temporal gradients (if enabled and not first frame)
		if ( this.params.enableTemporalGradient && ! this.isFirstFrame && motionTexture ) {

			this.gradientMaterial.uniforms.tCurrentColor.value = colorTexture;
			this.gradientMaterial.uniforms.tPrevColor.value = this.prevColorTarget.texture;
			this.gradientMaterial.uniforms.tMotion.value = motionTexture;
			this.gradientMaterial.uniforms.tCurrentNormalDepth.value = normalDepthTexture;
			this.gradientMaterial.uniforms.tPrevNormalDepth.value = this.prevNormalDepthTarget.texture;

			renderer.setRenderTarget( this.temporalGradientTarget );
			this.gradientQuad.render( renderer );

		}

		// Step 2: Temporal accumulation
		this.temporalMaterial.uniforms.tCurrentColor.value = colorTexture;
		this.temporalMaterial.uniforms.tCurrentNormalDepth.value = normalDepthTexture;
		this.temporalMaterial.uniforms.tMotion.value = motionTexture;
		this.temporalMaterial.uniforms.tTemporalGradient.value = this.temporalGradientTarget.texture;
		this.temporalMaterial.uniforms.hasMotionVectors.value = motionTexture !== null;
		this.temporalMaterial.uniforms.tPrevColor.value = this.prevColorTarget.texture;
		this.temporalMaterial.uniforms.tPrevMoments.value = this.prevMomentsTarget.texture;
		this.temporalMaterial.uniforms.tPrevHistoryLength.value = this.prevHistoryLengthTarget.texture;
		this.temporalMaterial.uniforms.tPrevNormalDepth.value = this.prevNormalDepthTarget.texture;
		this.temporalMaterial.uniforms.isFirstFrame.value = this.isFirstFrame;
		this.temporalMaterial.uniforms.frameCount.value = this.frameCount;

		renderer.setRenderTarget( this.temporalColorTarget );
		this.temporalQuad.render( renderer );

		// Step 3: Variance estimation
		this.varianceMaterial.uniforms.tColor.value = this.temporalColorTarget.texture;
		this.varianceMaterial.uniforms.tPrevMoments.value = this.prevMomentsTarget.texture;
		this.varianceMaterial.uniforms.tHistoryLength.value = this.temporalColorTarget.texture; // History in alpha

		renderer.setRenderTarget( this.varianceTarget );
		this.varianceQuad.render( renderer );

		// Step 4: A-trous wavelet filtering
		// Start with temporal color as input for first iteration
		let inputTexture = this.temporalColorTarget.texture;
		let currentOutput = this.atrousTargetA;
		let nextOutput = this.atrousTargetB;

		// Set static uniforms once
		this.atrousMaterial.uniforms.tVariance.value = this.varianceTarget.texture;
		this.atrousMaterial.uniforms.tNormalDepth.value = normalDepthTexture;
		this.atrousMaterial.uniforms.tHistoryLength.value = this.temporalColorTarget.texture;

		for ( let i = 0; i < this.params.atrousIterations; i ++ ) {

			// Set input texture for this iteration
			this.atrousMaterial.uniforms.tColor.value = inputTexture;
			this.atrousMaterial.uniforms.stepSize.value = Math.pow( 2, i );
			this.atrousMaterial.uniforms.iteration.value = i;

			// Render to current output
			renderer.setRenderTarget( currentOutput );
			this.atrousQuad.render( renderer );

			// For next iteration: input becomes current output, swap ping-pong buffers
			inputTexture = currentOutput.texture;
			[ currentOutput, nextOutput ] = [ nextOutput, currentOutput ];

		}

		// The final result is in inputTexture (last output)
		const finalFilteredTexture = inputTexture;

		// Step 5: Final composition (beauty pass only - debug views shown in heatmap overlay)
		this.finalMaterial.uniforms.tColor.value = finalFilteredTexture;
		this.finalMaterial.uniforms.tOriginalColor.value = colorTexture; // For alpha preservation

		// Render to outputTarget first (for context publication)
		renderer.setRenderTarget( this.outputTarget );
		this.finalQuad.render( renderer );

		// Then copy to writeBuffer for pipeline
		if ( writeBuffer && ! this.renderToScreen ) {

			this.copyTexture( renderer, this.outputTarget, writeBuffer );

		}

		// Update heatmap visualization if enabled
		// Store the motion texture used this frame for heatmap
		this.currentMotionTexture = motionTexture;
		this.updateHeatmapVisualization( renderer, normalDepthTexture, motionTexture );

		// Step 6: Store history for next frame
		this.copyTexture( renderer, this.temporalColorTarget, this.prevColorTarget );
		this.copyTexture( renderer, this.varianceTarget, this.prevMomentsTarget );
		this.copyTexture( renderer, this.temporalColorTarget, this.prevHistoryLengthTarget ); // History in alpha
		if ( normalDepthTexture ) {

			this.copyTexture( renderer, { texture: normalDepthTexture }, this.prevNormalDepthTarget );

		}

		this.isFirstFrame = false;

	}

	renderSpatialOnly( renderer, writeBuffer, colorTexture, normalDepthTexture ) {

		// Skip temporal accumulation and motion vectors
		// Only do variance estimation and A-trous filtering

		// Textures are now passed as parameters (colorTexture, normalDepthTexture)
		// No need to access PathTracerPass directly

		// Skip to variance estimation
		this.varianceMaterial.uniforms.tColor.value = colorTexture;
		this.varianceMaterial.uniforms.tPrevMoments.value = this.prevMomentsTarget.texture;
		this.varianceMaterial.uniforms.tHistoryLength.value = this.temporalColorTarget.texture;

		renderer.setRenderTarget( this.varianceTarget );
		this.varianceQuad.render( renderer );

		// A-trous filtering with reduced iterations for performance
		let inputTexture = colorTexture;
		let currentOutput = this.atrousTargetA;
		let nextOutput = this.atrousTargetB;

		const spatialIterations = Math.max( 2, Math.floor( this.params.atrousIterations / 2 ) );

		for ( let i = 0; i < spatialIterations; i ++ ) {

			this.atrousMaterial.uniforms.tColor.value = inputTexture;
			this.atrousMaterial.uniforms.stepSize.value = Math.pow( 2, i );
			this.atrousMaterial.uniforms.iteration.value = i;

			renderer.setRenderTarget( currentOutput );
			this.atrousQuad.render( renderer );

			inputTexture = currentOutput.texture;
			[ currentOutput, nextOutput ] = [ nextOutput, currentOutput ];

		}

		// Final output
		this.finalMaterial.uniforms.tColor.value = inputTexture;
		this.finalMaterial.uniforms.tOriginalColor.value = colorTexture; // For alpha preservation

		// Render to outputTarget first (for context publication)
		renderer.setRenderTarget( this.outputTarget );
		this.finalQuad.render( renderer );

		// Then copy to writeBuffer for pipeline
		if ( writeBuffer && ! this.renderToScreen ) {

			this.copyTexture( renderer, this.outputTarget, writeBuffer );

		}

		// Update heatmap visualization if enabled
		this.updateHeatmapVisualization( renderer, normalDepthTexture );

	}

	copyTexture( renderer, source, destination ) {

		if ( ! this.copyMaterial ) {

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
					uniform sampler2D tDiffuse;
					varying vec2 vUv;
					void main() {
						gl_FragColor = texture2D( tDiffuse, vUv );
					}
				`
			} );
			this.copyQuad = new FullScreenQuad( this.copyMaterial );

		}

		const currentRenderTarget = renderer.getRenderTarget();

		this.copyMaterial.uniforms.tDiffuse.value = source.texture || source;
		renderer.setRenderTarget( destination );
		this.copyQuad.render( renderer );

		renderer.setRenderTarget( currentRenderTarget );

	}

	getTemporalData() {

		return {
			moments: this.momentsTarget?.texture || null,
			history: this.historyTarget?.texture || null,
			variance: this.varianceTarget?.texture || null
		};

	}

	// Add method to get specific temporal metrics
	getTemporalMetrics() {

		return {
			temporalAlpha: this.temporalAlpha,
			maxAccumFrames: this.maxAccumFrames,
			currentFrame: this.frameCount || 0
		};

	}

	dispose() {

		// Dispose render targets
		const targets = [
			this.temporalColorTarget,
			this.temporalMomentsTarget,
			this.temporalHistoryLengthTarget,
			this.prevColorTarget,
			this.prevMomentsTarget,
			this.prevHistoryLengthTarget,
			this.prevNormalDepthTarget,
			this.varianceTarget,
			this.temporalGradientTarget,
			this.prevGradientTarget,
			this.atrousTargetA,
			this.atrousTargetB,
			this.outputTarget
		];

		targets.forEach( target => target.dispose() );

		// Dispose materials
		this.gradientMaterial.dispose();
		this.temporalMaterial.dispose();
		this.varianceMaterial.dispose();
		this.atrousMaterial.dispose();
		this.finalMaterial.dispose();
		this.copyMaterial?.dispose();

		// Dispose quads
		this.temporalQuad.dispose();
		this.varianceQuad.dispose();
		this.atrousQuad.dispose();
		this.gradientQuad.dispose();
		this.finalQuad.dispose();
		this.copyQuad?.dispose();

	}

	/**
	 * Publish ASVGF textures to pipeline context
	 * @param {PipelineContext} context - Pipeline context
	 */
	publishTexturesToContext( context ) {

		// Publish main output
		if ( this.outputTarget && this.outputTarget.texture ) {

			context.setTexture( 'asvgf:output', this.outputTarget.texture );

		}

		// Publish temporal color for AdaptiveSamplingStage
		if ( this.temporalColorTarget && this.temporalColorTarget.texture ) {

			context.setTexture( 'asvgf:temporalColor', this.temporalColorTarget.texture );

		}

		// Publish variance for AdaptiveSamplingStage
		if ( this.varianceTarget && this.varianceTarget.texture ) {

			context.setTexture( 'asvgf:variance', this.varianceTarget.texture );

		}

	}

}

/**
 * Debug Mode Reference Guide

  Mode 0: Beauty Pass

  What you should see:
  - The final denoised output from A-SVGF
  - Should look smooth and clean with noise reduced
  - Same as what appears on the main canvas

  Indicates working when:
  - Image is significantly cleaner than raw path tracer output
  - No obvious artifacts or ghosting
  - Edges are preserved (not overly blurred)

  ---
  Mode 1: Variance 🔵→🔴

  What you should see:
  - Blue/Dark areas: Low variance (little noise, well-converged)
  - Green/Yellow areas: Medium variance (some noise)
  - Red/Bright areas: High variance (lots of noise)

  Indicates working when:
  - Static areas turn blue over time as they accumulate samples
  - Complex lighting (caustics, reflections) shows more red/yellow
  - Newly exposed areas (camera movement) start red, then fade to blue
  - Direct lighting areas converge faster (blue) than indirect lighting
  (stays yellow/red longer)

  ---
  Mode 2: History Length 🔵→🔴

  What you should see:
  - Blue/Dark: New pixels (low history count, just appeared)
  - Red/Bright: Old pixels (high history count, many accumulated frames)

  Indicates working when:
  - Static scene: Entire screen turns red over ~32 frames
  - Camera rotation: New areas appear blue at screen edges, center stays red
  - Moving objects: Blue "trails" follow object motion
  - Disocclusions: Blue areas appear where previously hidden surfaces are
  revealed

  Perfect test: Start still → should go all red. Then rotate camera → edges
  turn blue, center stays red.

  ---
  Mode 3: Motion Vectors 🔵→🔴

  What you should see:
  - Blue/Dark: No motion (static areas)
  - Yellow/Red: Motion detected (camera movement or moving objects)
  - Magenta/Pink: Invalid motion vectors (screen edges, new geometry)

  Indicates working when:
  - Camera still: Entire screen is dark blue/black
  - Camera rotation: Radial pattern from rotation center - edges move more
  (red), center less (blue)
  - Camera translation: Directional flow across entire screen
  - Moving objects: Red/yellow highlights only on moving geometry

  Perfect test: Stay completely still → all blue. Then pan camera → you
  should see a coherent flow pattern.

  ---
  Mode 4: Normals 🎨

  What you should see:
  - RGB color-coded surface normals:
    - Red channel: X-axis (left = dark, right = bright)
    - Green channel: Y-axis (down = dark, up = bright)
    - Blue channel: Z-axis (away = dark, toward = bright)
  - Surfaces facing camera appear more cyan/white
  - Surfaces facing away appear darker

  Indicates working when:
  - Smooth gradients across curved surfaces
  - Sharp color transitions at edges between different faces
  - Colors stay consistent as you move (surface normals don't change with
  camera)

  ---
  Mode 5: Temporal Gradient ✨ 🔵→🔴

  This is the NEW A-SVGF feature!

  What you should see:
  - Black: Invalid gradients (disocclusions, screen edges, first frame)
  - Dark Blue: Very low temporal change (static, well-converged areas)
  - Green/Yellow: Moderate temporal change (still converging)
  - Red/Bright: High temporal change (actively changing lighting/geometry)

  Indicates working correctly when:

  1. Static Scene (Camera Still):
    - Starts with some color (yellow/green) on first few frames
    - Gradually transitions to dark blue as scene converges
    - After ~10-20 frames, most of screen should be blue (scene is stable)
    - Only areas with complex indirect lighting stay slightly yellow
  2. Camera Movement:
    - Immediately lights up with red/yellow across moving areas
    - Shows where the denoiser needs to adapt quickly
    - New areas at screen edges show black (invalid) or red (high gradient)
  3. Moving Objects:
    - Red/yellow highlights follow the object
    - Static background stays blue
    - Object boundaries show highest gradients (bright red)
  4. Animated Lights:
    - Areas affected by light change show yellow/red
    - Shadows moving across surfaces create gradients
    - Static unlit areas stay blue

  Perfect test sequence:
  - Frame 1: Mostly black (no previous frame) or random colors
  - Frames 2-10: Yellow/green across screen (scene converging)
  - Frames 10+: Transitions to blue (scene stable)
  - Then rotate camera: Instant spike to red/yellow
  - Stop moving: Fades back to blue over ~10-20 frames

  ---
  Quick Verification Checklist

  To verify A-SVGF is working correctly:

  1. ✅ Mode 5 (Gradient) turns blue when camera is still
  2. ✅ Mode 5 turns red when you move the camera
  3. ✅ Mode 2 (History) accumulates to red when still
  4. ✅ Mode 2 shows blue at screen edges when rotating
  5. ✅ Mode 1 (Variance) decreases over time (red → blue)
  6. ✅ Mode 0 (Beauty) looks cleaner than raw path tracer

  Common Issues to Watch For

  - Gradient stuck at black: Motion vectors might not be working
  - Gradient always red: Gradients too sensitive, increase gradientMin
  - Gradient always blue: Gradients too insensitive, decrease gradientMax or
   increase gradientScale
  - Beauty has ghosting: Temporal alpha too low, or gradients not adapting
  fast enough
  - Beauty too noisy: Temporal alpha too high, not enough accumulation
 */
