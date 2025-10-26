import {
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	Vector2,
	NearestFilter,
	Matrix4,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PipelineStage } from '../Pipeline/PipelineStage.js';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';
import { DEFAULT_STATE } from '../../Constants.js';

/**
 * ASVGFStage - Adaptive Spatially Varying Gradient Filter (ASVGF) denoiser
 *
 * Refactored from ASVGFPass to use the new pipeline architecture.
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

		super( 'ASVGF', options );

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
			debugMode: options.debugMode ?? 0, // 0: off, 1: variance, 2: temporal weight, 3: spatial weight

			...options
		};

		// Camera matrices for motion vector calculation
		this.prevViewMatrix = new Matrix4();
		this.prevProjectionMatrix = new Matrix4();
		this.prevViewProjectionMatrix = new Matrix4();
		this.currentViewProjectionMatrix = new Matrix4();

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
		this.motionQuad = new FullScreenQuad( this.motionMaterial );
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

		// Motion vectors and depth
		this.motionTarget = new WebGLRenderTarget( this.width, this.height, nearestTargetOptions );
		this.prevMotionTarget = new WebGLRenderTarget( this.width, this.height, nearestTargetOptions );

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

		// A-trous filtering (ping-pong)
		this.atrousTargetA = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.atrousTargetB = new WebGLRenderTarget( this.width, this.height, targetOptions );

		// Final output
		this.outputTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );

	}

	initMaterials() {

		// Motion vector calculation
		this.motionMaterial = new ShaderMaterial( {
			uniforms: {
				tNormalDepth: { value: null },
				tPrevNormalDepth: { value: null },
				currentViewProjectionMatrix: { value: new Matrix4() },
				prevViewProjectionMatrix: { value: new Matrix4() },
				resolution: { value: new Vector2( this.width, this.height ) }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tNormalDepth;
				uniform sampler2D tPrevNormalDepth;
				uniform mat4 currentViewProjectionMatrix;
				uniform mat4 prevViewProjectionMatrix;
				uniform vec2 resolution;
				
				varying vec2 vUv;

				vec3 getWorldPosition(vec2 uv, float depth, mat4 invViewProjMatrix) {
					vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
					vec4 worldPos = invViewProjMatrix * clipPos;
					return worldPos.xyz / worldPos.w;
				}

				void main() {
					vec4 normalDepth = texture2D(tNormalDepth, vUv);
					float depth = normalDepth.a;
					
					if (depth >= 1.0) {
						// Sky/background - no motion
						gl_FragColor = vec4(0.0, 0.0, depth, 1.0);
						return;
					}
					
					// Reconstruct world position
					mat4 invCurrentVP = inverse(currentViewProjectionMatrix);
					vec3 worldPos = getWorldPosition(vUv, depth, invCurrentVP);
					
					// Project to previous frame
					vec4 prevClipPos = prevViewProjectionMatrix * vec4(worldPos, 1.0);
					vec2 prevScreenPos = (prevClipPos.xy / prevClipPos.w) * 0.5 + 0.5;
					
					// Calculate motion vector
					vec2 motion = vUv - prevScreenPos;
					
					// Validate motion vector
					if (prevScreenPos.x < 0.0 || prevScreenPos.x > 1.0 || 
						prevScreenPos.y < 0.0 || prevScreenPos.y > 1.0) {
						// Outside screen bounds
						motion = vec2(1000.0); // Invalid motion marker
					}
					
					gl_FragColor = vec4(motion, depth, 1.0);
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

				temporalAlpha: { value: this.params.temporalAlpha },
				temporalColorWeight: { value: this.params.temporalColorWeight },
				temporalNormalWeight: { value: this.params.temporalNormalWeight },
				temporalDepthWeight: { value: this.params.temporalDepthWeight },
				varianceClip: { value: this.params.varianceClip },
				maxAccumFrames: { value: this.params.maxAccumFrames },

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
				
				uniform float temporalAlpha;
				uniform float temporalColorWeight;
				uniform float temporalNormalWeight;
				uniform float temporalDepthWeight;
				uniform float varianceClip;
				uniform float maxAccumFrames;
				
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
					vec4 prevHistoryLength = texture2D(tPrevHistoryLength, prevUV);
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
					
					// History length and adaptive alpha
					float historyLength = min(prevHistoryLength.r + 1.0, maxAccumFrames);
					float alpha = max(temporalAlpha, 1.0 / historyLength);
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
					vec4 historyLength = texture2D(tHistoryLength, vUv);
					
					// Get previous moments
					vec4 prevMoments = texture2D(tPrevMoments, vUv);
					float prevMean = prevMoments.x;
					float prevSecondMoment = prevMoments.y;
					
					// Temporal accumulation of moments
					float alpha = 1.0 / max(historyLength.r, 1.0);
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
					
					// Use variance to guide filter strength
					float sigma_l = phiLuminance * sqrt(max(centerVariance.z, 1e-6));
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
						vec4 sampleHistory = texture2D(tHistoryLength, sampleUV);
						
						float sampleLuma = getLuma(sampleColor);
						vec3 sampleNormal = sampleNormalDepth.xyz;
						float sampleDepth = sampleNormalDepth.w;
						
						// Edge-stopping functions
						float w_l = exp(-abs(centerLuma - sampleLuma) / sigma_l);
						float w_n = pow(max(0.0, dot(centerNormal, sampleNormal)), sigma_n);
						float w_z = exp(-abs(centerDepth - sampleDepth) / (sigma_z * max(centerDepth, 1e-3)));
						
						// History-based weight (trust pixels with more samples)
						float historyWeight = min(sampleHistory.r / max(centerHistory.r, 1.0), 2.0);
						
						float weight = kernel[i] * w_l * w_n * w_z * historyWeight;
						
						weightedSum += sampleColor * weight;
						weightSum += weight;
					}
					
					if (weightSum > 1e-6) {
						gl_FragColor = vec4(weightedSum / weightSum, 1.0);
					} else {
						gl_FragColor = vec4(centerColor, 1.0);
					}
				}
			`
		} );

		// Final composition with debug modes
		this.finalMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tVariance: { value: null },
				tHistoryLength: { value: null },
				tNormalDepth: { value: null },
				tMotion: { value: null },

				enableDebug: { value: this.params.enableDebug },
				debugMode: { value: this.params.debugMode },
				resolution: { value: new Vector2( this.width, this.height ) }
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
				uniform sampler2D tHistoryLength;
				uniform sampler2D tNormalDepth;
				uniform sampler2D tMotion;
				
				uniform bool enableDebug;
				uniform int debugMode;
				uniform vec2 resolution;
				
				varying vec2 vUv;

				vec3 heatmap(float value) {
					value = clamp(value, 0.0, 1.0);
					return mix(
						mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), value * 2.0),
						mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (value - 0.5) * 2.0),
						step(0.5, value)
					);
				}

				void main() {
					vec3 color = texture2D(tColor, vUv).rgb;
					
					if (!enableDebug) {
						// Add subtle visual indicator that ASVGF is active
						// Slight warm tint to show ASVGF is processing
						color = color * vec3(1.02, 1.01, 0.98);
						gl_FragColor = vec4(color, 1.0);
						return;
					}
					
					if (debugMode == 1) {
						// Variance visualization
						float variance = texture2D(tVariance, vUv).z;
						gl_FragColor = vec4(heatmap(sqrt(variance) * 10.0), 1.0);
					} else if (debugMode == 2) {
						// History length visualization
						float history = texture2D(tHistoryLength, vUv).r / 32.0;
						gl_FragColor = vec4(heatmap(history), 1.0);
					} else if (debugMode == 3) {
						// Motion vectors visualization
						vec2 motion = texture2D(tMotion, vUv).xy;
						if (motion.x > 100.0) {
							gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); // Magenta for invalid
						} else {
							gl_FragColor = vec4(abs(motion) * 50.0, 0.0, 1.0);
						}
					} else if (debugMode == 4) {
						// Normal visualization
						vec3 normal = texture2D(tNormalDepth, vUv).xyz;
						gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
					} else {
						gl_FragColor = vec4(color, 1.0);
					}
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
				tVariance: { value: null },
				tHistoryLength: { value: null },
				tNormalDepth: { value: null },
				tMotion: { value: null },
				heatmapMode: { value: 1 }, // 1=variance, 2=history, 3=motion, 4=normal
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
				uniform sampler2D tVariance;
				uniform sampler2D tHistoryLength;
				uniform sampler2D tNormalDepth;
				uniform sampler2D tMotion;
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

					if (heatmapMode == 1) {
						// Variance visualization
						vec4 variance = texture2D(tVariance, vUv);
						value = sqrt(variance.z) * intensityScale * 10.0;
						color = heatmap(value);
					} else if (heatmapMode == 2) {
						// History length visualization
						vec4 history = texture2D(tHistoryLength, vUv);
						value = history.r / 32.0;
						color = heatmap(value);
					} else if (heatmapMode == 3) {
						// Motion vectors visualization
						vec4 motion = texture2D(tMotion, vUv);
						if (motion.x > 100.0) {
							color = vec3(1.0, 0.0, 1.0); // Magenta for invalid
						} else {
							value = length(motion.xy) * 50.0;
							color = heatmap(value);
						}
					} else if (heatmapMode == 4) {
						// Normal visualization
						vec3 normal = texture2D(tNormalDepth, vUv).xyz;
						color = normal * 0.5 + 0.5;
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

	updateHeatmapVisualization( renderer, normalDepthTexture ) {

		if ( ! this.showHeatmap || ! this.heatmapMaterial ) return;

		// Update heatmap uniforms
		this.heatmapMaterial.uniforms.tVariance.value = this.varianceTarget?.texture || null;
		this.heatmapMaterial.uniforms.tHistoryLength.value = this.temporalColorTarget?.texture || null;
		this.heatmapMaterial.uniforms.tNormalDepth.value = normalDepthTexture || null;
		this.heatmapMaterial.uniforms.tMotion.value = this.motionTarget?.texture || null;

		// Render heatmap
		const currentRenderTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( this.heatmapTarget );
		this.heatmapQuad.render( renderer );
		renderer.setRenderTarget( currentRenderTarget );

		// Update helper
		this.heatmapHelper.update();

	}

	updateCameraMatrices( camera ) {

		// Store previous matrices
		this.prevViewMatrix.copy( this.currentViewMatrix || camera.matrixWorldInverse );
		this.prevProjectionMatrix.copy( this.currentProjectionMatrix || camera.projectionMatrix );
		this.prevViewProjectionMatrix.copy( this.currentViewProjectionMatrix || new Matrix4() );

		// Update current matrices
		this.currentViewMatrix = camera.matrixWorldInverse.clone();
		this.currentProjectionMatrix = camera.projectionMatrix.clone();
		this.currentViewProjectionMatrix.multiplyMatrices( this.currentProjectionMatrix, this.currentViewMatrix );

	}

	reset() {

		this.frameCount = 0;
		this.isFirstFrame = true;

		// Clear render targets
		const renderer = this.renderer;
		const currentRenderTarget = renderer.getRenderTarget();

		const targetsToClear = [
			this.motionTarget,
			this.temporalColorTarget,
			this.temporalMomentsTarget,
			this.temporalHistoryLengthTarget,
			this.prevColorTarget,
			this.prevMomentsTarget,
			this.prevHistoryLengthTarget,
			this.prevNormalDepthTarget,
			this.varianceTarget
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
			this.motionTarget,
			this.prevMotionTarget,
			this.temporalColorTarget,
			this.temporalMomentsTarget,
			this.temporalHistoryLengthTarget,
			this.prevColorTarget,
			this.prevMomentsTarget,
			this.prevHistoryLengthTarget,
			this.prevNormalDepthTarget,
			this.varianceTarget,
			this.atrousTargetA,
			this.atrousTargetB,
			this.outputTarget
		];

		targets.forEach( target => target.setSize( width, height ) );

		// Update resolution uniforms
		const resolutionVector = new Vector2( width, height );
		this.motionMaterial.uniforms.resolution.value.copy( resolutionVector );
		this.temporalMaterial.uniforms.resolution.value.copy( resolutionVector );
		this.varianceMaterial.uniforms.resolution.value.copy( resolutionVector );
		this.atrousMaterial.uniforms.resolution.value.copy( resolutionVector );
		this.finalMaterial.uniforms.resolution.value.copy( resolutionVector );

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

		this.varianceMaterial.uniforms.varianceBoost.value = this.params.varianceBoost;

		this.atrousMaterial.uniforms.phiColor.value = this.params.phiColor;
		this.atrousMaterial.uniforms.phiNormal.value = this.params.phiNormal;
		this.atrousMaterial.uniforms.phiDepth.value = this.params.phiDepth;
		this.atrousMaterial.uniforms.phiLuminance.value = this.params.phiLuminance;

		this.finalMaterial.uniforms.enableDebug.value = this.params.enableDebug;
		this.finalMaterial.uniforms.debugMode.value = this.params.debugMode;

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

		// Skip ASVGF during interaction mode for performance
		// Read interaction mode from context instead of global access
		const interactionMode = context.getState( 'interactionMode' );
		if ( interactionMode ) {

			// During interaction, pass through without denoising
			return;

		}

		// Read PathTracer MRT textures from context
		const colorTexture = context.getTexture( 'pathtracer:color' );
		const normalDepthTexture = context.getTexture( 'pathtracer:normalDepth' );

		if ( ! colorTexture || ! normalDepthTexture ) {

			this.warn( 'Missing PathTracer MRT textures in context' );
			return;

		}

		// Update camera matrices for motion vectors
		this.updateCameraMatrices( this.camera );

		// Handle tile vs full-screen differently
		if ( this.temporalEnabled ) {

			this.renderWithTemporal( renderer, writeBuffer, colorTexture, normalDepthTexture, this.camera );

		} else {

			this.renderSpatialOnly( renderer, writeBuffer, colorTexture, normalDepthTexture, this.camera );

		}

		// Publish textures to context
		this.publishTexturesToContext( context );

	}

	renderWithTemporal( renderer, writeBuffer, colorTexture, normalDepthTexture, camera ) {

		// Full ASVGF pipeline
		this.frameCount ++;

		// Update camera matrices for motion vectors
		this.updateCameraMatrices( camera );

		// Textures are now passed as parameters (colorTexture, normalDepthTexture)
		// No need to access PathTracerPass directly

		// Step 1: Calculate motion vectors (only if we have normal/depth data)
		if ( normalDepthTexture ) {

			this.motionMaterial.uniforms.tNormalDepth.value = normalDepthTexture;
			this.motionMaterial.uniforms.tPrevNormalDepth.value = this.prevNormalDepthTarget.texture;
			this.motionMaterial.uniforms.currentViewProjectionMatrix.value.copy( this.currentViewProjectionMatrix );
			this.motionMaterial.uniforms.prevViewProjectionMatrix.value.copy( this.prevViewProjectionMatrix );

			renderer.setRenderTarget( this.motionTarget );
			this.motionQuad.render( renderer );

		}

		// Step 2: Temporal accumulation
		this.temporalMaterial.uniforms.tCurrentColor.value = colorTexture;
		this.temporalMaterial.uniforms.tCurrentNormalDepth.value = normalDepthTexture;
		this.temporalMaterial.uniforms.tMotion.value = normalDepthTexture ? this.motionTarget.texture : null;
		this.temporalMaterial.uniforms.hasMotionVectors.value = normalDepthTexture !== null;
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

		// Step 5: Final composition
		this.finalMaterial.uniforms.tColor.value = finalFilteredTexture;
		this.finalMaterial.uniforms.tVariance.value = this.varianceTarget.texture;
		this.finalMaterial.uniforms.tHistoryLength.value = this.temporalColorTarget.texture;
		this.finalMaterial.uniforms.tNormalDepth.value = normalDepthTexture;
		this.finalMaterial.uniforms.tMotion.value = normalDepthTexture ? this.motionTarget.texture : null;

		// Render to outputTarget first (for context publication)
		renderer.setRenderTarget( this.outputTarget );
		this.finalQuad.render( renderer );

		// Then copy to writeBuffer for pipeline
		if ( writeBuffer && ! this.renderToScreen ) {

			this.copyTexture( renderer, this.outputTarget, writeBuffer );

		}

		// Update heatmap visualization if enabled
		this.updateHeatmapVisualization( renderer, normalDepthTexture );

		// Step 6: Store history for next frame
		this.copyTexture( renderer, this.temporalColorTarget, this.prevColorTarget );
		this.copyTexture( renderer, this.varianceTarget, this.prevMomentsTarget );
		this.copyTexture( renderer, this.temporalColorTarget, this.prevHistoryLengthTarget ); // History in alpha
		if ( normalDepthTexture ) {

			this.copyTexture( renderer, { texture: normalDepthTexture }, this.prevNormalDepthTarget );

		}

		this.isFirstFrame = false;

	}

	// eslint-disable-next-line no-unused-vars
	renderSpatialOnly( renderer, writeBuffer, colorTexture, normalDepthTexture, camera ) {

		// Skip temporal accumulation and motion vectors
		// Only do variance estimation and A-trous filtering
		// Note: camera parameter is unused in spatial-only mode (no temporal/motion vectors)

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
		this.finalMaterial.uniforms.tVariance.value = this.varianceTarget.texture;
		this.finalMaterial.uniforms.tNormalDepth.value = normalDepthTexture;

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
						gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
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
			this.motionTarget,
			this.prevMotionTarget,
			this.temporalColorTarget,
			this.temporalMomentsTarget,
			this.temporalHistoryLengthTarget,
			this.prevColorTarget,
			this.prevMomentsTarget,
			this.prevHistoryLengthTarget,
			this.prevNormalDepthTarget,
			this.varianceTarget,
			this.atrousTargetA,
			this.atrousTargetB,
			this.outputTarget
		];

		targets.forEach( target => target.dispose() );

		// Dispose materials
		this.motionMaterial.dispose();
		this.temporalMaterial.dispose();
		this.varianceMaterial.dispose();
		this.atrousMaterial.dispose();
		this.finalMaterial.dispose();
		this.copyMaterial?.dispose();

		// Dispose quads
		this.temporalQuad.dispose();
		this.varianceQuad.dispose();
		this.atrousQuad.dispose();
		this.motionQuad.dispose();
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
