import {
	ShaderMaterial,
	WebGLRenderTarget,
	NearestFilter,
	Vector2,
	Vector4,
	RGBAFormat,
	FloatType
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';
import { DEFAULT_STATE } from '../../Constants.js';

export class AdaptiveSamplingPass extends Pass {

	constructor( renderer, width, height ) {

		super();

		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.name = 'AdaptiveSamplingPass';
		this.counter = 0;
		this.delayByFrames = 2;

		this.adaptiveSamplingMin = DEFAULT_STATE.adaptiveSamplingMin;
		this.adaptiveSamplingMax = DEFAULT_STATE.adaptiveSamplingMax;
		this.adaptiveSamplingVarianceThreshold = DEFAULT_STATE.adaptiveSamplingVarianceThreshold;
		this.showAdaptiveSamplingHelper = DEFAULT_STATE.showAdaptiveSamplingHelper;

		this.asvgfPass = null;

		// Create the render target to store adaptive sampling data
		this.renderTarget = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// material that uses both spatial and temporal variance
		this.material = new ShaderMaterial( {
			uniforms: {
				resolution: { value: new Vector2( width, height ) },

				// ASVGF temporal data
				asvgfColorTexture: { value: null },
				asvgfVarianceTexture: { value: null },

				// G-buffer data
				normalDepthTexture: { value: null },
				currentColorTexture: { value: null },

				// Boolean flags for texture availability
				hasASVGFColor: { value: false },
				hasASVGFVariance: { value: false },
				hasNormalDepth: { value: false },
				hasCurrentColor: { value: false },

				// Sampling parameters
				adaptiveSamplingMin: { value: this.adaptiveSamplingMin },
				adaptiveSamplingMax: { value: this.adaptiveSamplingMax },
				adaptiveSamplingVarianceThreshold: { value: this.adaptiveSamplingVarianceThreshold },

				// Temporal adaptation controls
				materialBias: { value: 1.2 },
				edgeBias: { value: 1.5 },
				frameNumber: { value: 0 },
				convergenceSpeedUp: { value: 2.0 },

				// Temporal adaptation parameters
				minConvergenceFrames: { value: 50.0 }, // Much higher minimum before considering convergence
				maxConvergenceFrames: { value: 200.0 }, // Gradual reduction over more frames
				temporalAdaptationRate: { value: 0.95 }, // How quickly to adapt (0.95 = slow, 0.8 = fast)
				varianceDecayRate: { value: 0.98 }, // How quickly variance importance decays

				// Variance reliability and smoothing
				varianceSmoothingFactor: { value: 0.1 }, // Temporal smoothing for variance
				spatialVarianceWeight: { value: 0.3 }, // Weight for spatial variance estimation
				minSampleGuarantee: { value: 1.0 }, // Minimum samples per pixel

				// Hysteresis parameters for convergence stability
				convergenceThresholdLow: { value: 0.75 }, // Threshold to enter convergence
				convergenceThresholdHigh: { value: 0.9 }, // Threshold to exit convergence
				temporalStabilityFrames: { value: 10.0 }, // Frames to maintain stability

				// Tile rendering parameters
				isTileMode: { value: false },
				currentTileBounds: { value: new Vector4( 0, 0, 1, 1 ) }, // x, y, w, h

				// Debug controls
				debugMode: { value: true },
				showTemporalEvolution: { value: true },
			},

			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,

			fragmentShader: /* glsl */`
				precision highp float;

				uniform vec2 resolution;
				uniform sampler2D asvgfColorTexture;
				uniform sampler2D asvgfVarianceTexture;
				uniform sampler2D normalDepthTexture;
				uniform sampler2D currentColorTexture;
				
				// Boolean flags for available inputs
				uniform bool hasASVGFColor;
				uniform bool hasASVGFVariance;
				uniform bool hasNormalDepth;
				uniform bool hasCurrentColor;
				
				// Reliability and smoothing parameters
				uniform float varianceSmoothingFactor;
				uniform float spatialVarianceWeight;
				uniform float minSampleGuarantee;
				
				// Hysteresis parameters
				uniform float convergenceThresholdLow;
				uniform float convergenceThresholdHigh;
				uniform float temporalStabilityFrames;
				
				// Tile rendering support
				uniform bool isTileMode;
				uniform vec4 currentTileBounds; // x, y, width, height in pixels
				
				uniform int adaptiveSamplingMin;
				uniform int adaptiveSamplingMax;
				uniform float adaptiveSamplingVarianceThreshold;
				uniform float materialBias;
				uniform float edgeBias;
				uniform int frameNumber;
				uniform float convergenceSpeedUp;
				
				// Temporal adaptation
				uniform float minConvergenceFrames;
				uniform float maxConvergenceFrames;
				uniform float temporalAdaptationRate;
				uniform float varianceDecayRate;
				
				uniform bool debugMode;
				uniform bool showTemporalEvolution;
				
				varying vec2 vUv;

				// Test pattern with temporal variation
				vec4 generateTestPattern() {
					vec2 uv = gl_FragCoord.xy / resolution;
					
					// Add temporal variation to make changes visible
					float time = float(frameNumber) * 0.1;
					float pattern = sin(uv.x * 20.0 + time) * sin(uv.y * 20.0 + time);
					pattern = (pattern + 1.0) * 0.5;
					
					// Create areas that change over time
					float temporalFactor = sin(time * 0.5) * 0.3 + 0.7;
					pattern *= temporalFactor;
					
					float samples = mix(float(adaptiveSamplingMin), float(adaptiveSamplingMax), pattern);
					float normalizedSamples = samples / float(adaptiveSamplingMax);
					
					return vec4(normalizedSamples, pattern, temporalFactor, 1.0);
				}

				// Material classification with temporal awareness
				float classifyMaterial(vec3 normal, float depth, vec3 color, float historyLength) {
					if (length(normal) < 0.1) return 1.0;
					
					// Calculate complexity
					float normalVariation = length(fwidth(normal));
					float depthVariation = abs(fwidth(depth));
					float colorVariation = length(fwidth(color));
					
					float baseComplexity = normalVariation * 8.0 + depthVariation * 4.0 + colorVariation * 2.0;
					
					// Complexity importance over time (temporal adaptation)
					float temporalFactor = 1.0;
					if (historyLength > minConvergenceFrames) {
						temporalFactor = pow(temporalAdaptationRate, (historyLength - minConvergenceFrames) / 10.0);
					}
					
					float complexity = baseComplexity * temporalFactor;
					return clamp(complexity, 0.3, 2.5);
				}

				// Tile-aware edge detection with temporal adaptation
				float detectEdges(vec2 uv, float historyLength) {
					if (!hasNormalDepth) return 0.0;
					
					vec2 texelSize = 1.0 / resolution;
					vec2 pixelCoord = uv * resolution;
					
					// Center sample
					vec3 n0 = texture2D(normalDepthTexture, uv).rgb * 2.0 - 1.0;
					float d0 = texture2D(normalDepthTexture, uv).a;
					
					// Check which neighbors are valid in tile mode
					vec2 coord1 = uv + vec2(texelSize.x, 0.0);
					vec2 coord2 = uv + vec2(0.0, texelSize.y);
					vec2 coord3 = uv + vec2(-texelSize.x, 0.0);
					vec2 coord4 = uv + vec2(0.0, -texelSize.y);
					
					bool valid1 = !isTileMode || (coord1.x * resolution.x < currentTileBounds.x + currentTileBounds.z);
					bool valid2 = !isTileMode || (coord2.y * resolution.y < currentTileBounds.y + currentTileBounds.w);
					bool valid3 = !isTileMode || (coord3.x * resolution.x >= currentTileBounds.x);
					bool valid4 = !isTileMode || (coord4.y * resolution.y >= currentTileBounds.y);
					
					// Sample valid neighbors, fallback to center for invalid ones
					vec3 n1 = valid1 ? texture2D(normalDepthTexture, coord1).rgb * 2.0 - 1.0 : n0;
					vec3 n2 = valid2 ? texture2D(normalDepthTexture, coord2).rgb * 2.0 - 1.0 : n0;
					vec3 n3 = valid3 ? texture2D(normalDepthTexture, coord3).rgb * 2.0 - 1.0 : n0;
					vec3 n4 = valid4 ? texture2D(normalDepthTexture, coord4).rgb * 2.0 - 1.0 : n0;
					
					float d1 = valid1 ? texture2D(normalDepthTexture, coord1).a : d0;
					float d2 = valid2 ? texture2D(normalDepthTexture, coord2).a : d0;
					float d3 = valid3 ? texture2D(normalDepthTexture, coord3).a : d0;
					float d4 = valid4 ? texture2D(normalDepthTexture, coord4).a : d0;
					
					// Calculate edge strength only from valid neighbors
					float normalEdge = 0.0;
					float depthEdge = 0.0;
					float validCount = 0.0;
					
					if (valid1) { normalEdge += length(n0 - n1); depthEdge += abs(d0 - d1); validCount += 1.0; }
					if (valid2) { normalEdge += length(n0 - n2); depthEdge += abs(d0 - d2); validCount += 1.0; }
					if (valid3) { normalEdge += length(n0 - n3); depthEdge += abs(d0 - d3); validCount += 1.0; }
					if (valid4) { normalEdge += length(n0 - n4); depthEdge += abs(d0 - d4); validCount += 1.0; }
					
					// Average by valid neighbors, or return 0 if no valid neighbors
					if (validCount == 0.0) return 0.0;
					
					float edgeStrength = ((normalEdge + depthEdge * 15.0) / validCount) * 1.5;
					
					// Gradual edge importance reduction over time
					if (historyLength > minConvergenceFrames) {
						float edgeDecay = pow(0.97, (historyLength - minConvergenceFrames) / 5.0);
						edgeStrength *= edgeDecay;
					}
					
					return clamp(edgeStrength, 0.0, 1.0);
				}

				// Progressive convergence function with hysteresis
				float calculateConvergenceWeight(float historyLength, float variance, float previousConvergence) {
					// No convergence before minimum frames
					if (historyLength < minConvergenceFrames) {
						return 0.0;
					}
					
					// Very gradual convergence between min and max frames
					float convergenceProgress = (historyLength - minConvergenceFrames) / (maxConvergenceFrames - minConvergenceFrames);
					convergenceProgress = clamp(convergenceProgress, 0.0, 1.0);
					
					// Smooth convergence curve
					float convergenceCurve = 1.0 - pow(1.0 - convergenceProgress, 2.0);
					
					// Variance-based convergence strength
					float varianceWeight = 1.0 - clamp(variance / adaptiveSamplingVarianceThreshold, 0.0, 1.0);
					
					float baseConvergence = convergenceCurve * varianceWeight;
					
					// Apply hysteresis to prevent flickering
					float threshold = (previousConvergence > 0.5) ? convergenceThresholdHigh : convergenceThresholdLow;
					
					if (baseConvergence > threshold) {
						// Smoothly transition into convergence
						return mix(previousConvergence, baseConvergence, 0.1);
					} else if (baseConvergence < (threshold - 0.1)) {
						// Only exit convergence with clear evidence
						return mix(previousConvergence, baseConvergence, 0.05);
					} else {
						// Maintain current state in threshold zone
						return previousConvergence;
					}
				}

				void main() {
					vec2 texCoord = gl_FragCoord.xy / resolution;

					// Sample available inputs
					vec4 asvgfColor = vec4(0.5, 0.5, 0.5, 1.0);
					vec4 asvgfVariance = vec4(0.5, 0.5, 0.5, 0.5);
					vec4 normalDepth = vec4(0.0, 0.0, 1.0, 1.0);
					vec3 currentColor = vec3(0.5);
					
					if (hasASVGFColor) {
						asvgfColor = texture2D(asvgfColorTexture, texCoord);
					}
					
					if (hasASVGFVariance) {
						asvgfVariance = texture2D(asvgfVarianceTexture, texCoord);
					}
					
					if (hasNormalDepth) {
						normalDepth = texture2D(normalDepthTexture, texCoord);
					}
					
					if (hasCurrentColor) {
						currentColor = texture2D(currentColorTexture, texCoord).rgb;
					}

					// Generate test pattern if no inputs (with temporal variation)
					if (!hasASVGFColor && !hasNormalDepth && debugMode) {
						gl_FragColor = generateTestPattern();
						return;
					}
					
					// Fallback for missing inputs - provide reasonable defaults
					if (!hasASVGFColor && !hasNormalDepth) {
						gl_FragColor = vec4(0.5, 0.5, 0.0, 1.0); // Use middle sampling level
						return;
					}

					// Extract temporal data
					float historyLength = hasASVGFColor ? asvgfColor.a : 1.0;
					float variance = hasASVGFVariance ? asvgfVariance.a : 0.5;
					vec3 normal = hasNormalDepth ? normalDepth.rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
					float depth = hasNormalDepth ? normalDepth.a : 1.0;

					// Progressive convergence with hysteresis (use previous frame's convergence)
					float previousConvergence = hasASVGFColor ? asvgfColor.g : 0.0;
					float convergenceWeight = calculateConvergenceWeight(historyLength, variance, previousConvergence);
					
					// Material analysis with temporal adaptation
					float materialComplexity = hasNormalDepth ? 
						classifyMaterial(normal, depth, asvgfColor.rgb, historyLength) : 1.0;
					
					// Edge detection with temporal adaptation
					float edgeStrength = detectEdges(texCoord, historyLength);

					// Compute spatial variance when ASVGF variance unavailable
					float spatialVariance = 0.0;
					if (!hasASVGFVariance && hasCurrentColor) {
						vec2 texelSize = 1.0 / resolution;
						vec3 centerColor = texture2D(currentColorTexture, texCoord).rgb;
						
						// Tile-aware neighbor sampling
						vec2 pixelCoord = gl_FragCoord.xy;
						float validSamples = 1.0; // Center pixel always valid
						vec3 colorAccum = centerColor;
						
						// Check if neighbors are within tile bounds (if in tile mode)
						vec2 rightCoord = texCoord + vec2(texelSize.x, 0.0);
						vec2 downCoord = texCoord + vec2(0.0, texelSize.y);
						vec2 leftCoord = texCoord - vec2(texelSize.x, 0.0);
						vec2 upCoord = texCoord - vec2(0.0, texelSize.y);
						
						bool rightValid = !isTileMode || (rightCoord.x * resolution.x < currentTileBounds.x + currentTileBounds.z);
						bool downValid = !isTileMode || (downCoord.y * resolution.y < currentTileBounds.y + currentTileBounds.w);
						bool leftValid = !isTileMode || (leftCoord.x * resolution.x >= currentTileBounds.x);
						bool upValid = !isTileMode || (upCoord.y * resolution.y >= currentTileBounds.y);
						
						// Sample valid neighbors only
						vec3 rightColor = rightValid ? texture2D(currentColorTexture, rightCoord).rgb : centerColor;
						vec3 downColor = downValid ? texture2D(currentColorTexture, downCoord).rgb : centerColor;
						vec3 leftColor = leftValid ? texture2D(currentColorTexture, leftCoord).rgb : centerColor;
						vec3 upColor = upValid ? texture2D(currentColorTexture, upCoord).rgb : centerColor;
						
						// Calculate variance from valid color differences
						float colorDiff = 0.0;
						if (rightValid) colorDiff += length(centerColor - rightColor);
						if (downValid) colorDiff += length(centerColor - downColor);
						if (leftValid) colorDiff += length(centerColor - leftColor);
						if (upValid) colorDiff += length(centerColor - upColor);
						
						// Average by number of valid samples
						float validNeighbors = float(rightValid) + float(downValid) + float(leftValid) + float(upValid);
						spatialVariance = validNeighbors > 0.0 ? (colorDiff / validNeighbors) : 0.0;
					}
					
					// Reliable variance calculation with fallback hierarchy
					float reliableVariance;
					if (hasASVGFVariance) {
						// Primary: Use ASVGF variance with temporal smoothing
						float temporallyStabilizedVariance = variance;
						if (historyLength > 5.0) {
							// Apply gentle temporal decay only after initial settling
							temporallyStabilizedVariance *= pow(varianceDecayRate, (historyLength - 5.0) / 30.0);
						}
						reliableVariance = temporallyStabilizedVariance;
					} else if (hasCurrentColor) {
						// Secondary: Use spatial variance estimation
						reliableVariance = spatialVariance * spatialVarianceWeight;
					} else {
						// Final fallback: Conservative estimate based on material complexity
						reliableVariance = materialComplexity * 0.1;
					}
					
					// Material-aware threshold adjustment
					float adaptiveThreshold = adaptiveSamplingVarianceThreshold;
					if (materialComplexity > 2.0) {
						// More sensitive threshold for complex materials
						adaptiveThreshold *= 0.7;
					} else if (materialComplexity < 0.8) {
						// More relaxed threshold for simple materials  
						adaptiveThreshold *= 1.3;
					}
					
					// Base sample requirement from reliable variance
					float baseRequirement = reliableVariance / adaptiveThreshold;
					baseRequirement = clamp(baseRequirement, 0.0, 1.0);
					
					// Apply intelligent biases with temporal adaptation
					float finalRequirement = baseRequirement;
					finalRequirement *= materialComplexity * materialBias;
					finalRequirement += edgeStrength * edgeBias * 0.4;

					// Progressive sample reduction based on convergence
					float convergenceReduction = convergenceWeight * 0.7; // Max 70% reduction
					finalRequirement *= (1.0 - convergenceReduction);
					
					// Ensure gradual change over time
					if (hasASVGFColor && historyLength > 10.0) {
						float temporalSmoothing = 0.1 + convergenceWeight * 0.1;
						finalRequirement = mix(0.5, finalRequirement, temporalSmoothing);
					}
					
					// Ensure minimum sample guarantee
					float minSamples = max(minSampleGuarantee, float(adaptiveSamplingMin));
					
					// Convert to sample count with smoother transitions
					float targetSampleCount = mix(
						minSamples, 
						float(adaptiveSamplingMax), 
						clamp(finalRequirement, 0.0, 1.0)
					);
					
					// Temporal smoothing to prevent quantization oscillations
					float previousSampleCount = minSamples;
					if (hasASVGFColor && historyLength > 3.0) {
						// Extract previous sample count from stored data (if available)
						previousSampleCount = mix(minSamples, float(adaptiveSamplingMax), asvgfColor.b);
						// Apply temporal smoothing
						targetSampleCount = mix(previousSampleCount, targetSampleCount, varianceSmoothingFactor);
					}
					
					// Early frame boosting (more conservative to avoid conflicts)
					if (frameNumber < 5) {
						float earlyBoost = (5.0 - float(frameNumber)) / 5.0 * 0.2;
						float boostedCount = float(adaptiveSamplingMax) * (0.6 + earlyBoost);
						targetSampleCount = max(targetSampleCount, boostedCount);
					}
					
					float sampleCount = targetSampleCount;
					
					// Store normalized result
					float normalizedSamples = sampleCount / float(adaptiveSamplingMax);
					
					// Determine if pixel is converged with hysteresis
					bool pixelConverged = convergenceWeight > convergenceThresholdHigh && 
										  hasASVGFColor && 
										  historyLength > (minConvergenceFrames + temporalStabilityFrames);
					float convergenceFlag = pixelConverged ? 1.0 : 0.0;
					
					// Debug output showing temporal evolution
					if (debugMode) {
						gl_FragColor = vec4(
							normalizedSamples,
							hasASVGFColor ? convergenceWeight : 0.0, // Show convergence progress
							convergenceFlag, // Convergence flag for optimization
							materialComplexity / 2.5
						);
					} else {
						// Normal output
						gl_FragColor = vec4(
							normalizedSamples,
							variance / adaptiveSamplingVarianceThreshold, 
							convergenceFlag, // Convergence flag for optimization
							materialComplexity / 2.5
						);
					}
				}
			`,
		} );

		this.fsQuad = new FullScreenQuad( this.material );

		// Heatmap visualization showing temporal evolution
		this.heatmapTarget = new WebGLRenderTarget( width, height, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Create the heatmap visualization shader material
		this.heatmapMaterial = new ShaderMaterial( {
			uniforms: {
				samplingTexture: { value: null },
				heatmapIntensity: { value: 1.0 },
				minSamples: { value: this.adaptiveSamplingMin },
				maxSamples: { value: this.adaptiveSamplingMax },
				showDebugInfo: { value: true },
				debugMode: { value: true },
				showTemporalEvolution: { value: true }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D samplingTexture;
				uniform float heatmapIntensity;
				uniform float minSamples;
				uniform float maxSamples;
				uniform bool showDebugInfo;
				uniform bool debugMode;
				uniform bool showTemporalEvolution;
				varying vec2 vUv;

				// Colormap with temporal information
				vec3 getTemporalHeatmap(float samples, float convergence, float temporal) {
					// Base sample heatmap
					vec3 sampleColor;
					if (samples < 0.2) sampleColor = vec3(0.0, 0.0, 1.0);      // Blue - minimum
					else if (samples < 0.4) sampleColor = vec3(0.0, 1.0, 1.0); // Cyan
					else if (samples < 0.6) sampleColor = vec3(0.0, 1.0, 0.0); // Green
					else if (samples < 0.8) sampleColor = vec3(1.0, 1.0, 0.0); // Yellow  
					else sampleColor = vec3(1.0, 0.0, 0.0);                    // Red - maximum
					
					if (showTemporalEvolution) {
						// Show convergence as desaturation
						float desaturation = convergence * 0.6;
						vec3 gray = vec3(dot(sampleColor, vec3(0.299, 0.587, 0.114)));
						sampleColor = mix(sampleColor, gray, desaturation);
						
						// Show temporal progress as brightness modulation
						float brightness = 0.7 + temporal * 0.3;
						sampleColor *= brightness;
					}
					
					return sampleColor;
				}
			
				void main() {
					vec4 samplingData = texture2D(samplingTexture, vUv);
					
					float samples = samplingData.r;
					float convergence = samplingData.g; // Convergence progress or ASVGF availability
					float temporal = samplingData.b;    // Temporal progress or G-buffer availability
					float complexity = samplingData.a;  // Material complexity
					
					vec3 color;
					
					if (debugMode && showDebugInfo) {
						// Show temporal evolution heatmap
						color = getTemporalHeatmap(samples, convergence, temporal);
						
						// Add border indicators for convergence levels
						vec2 border = abs(vUv - 0.5);
						float maxBorder = max(border.x, border.y);
						if (maxBorder > 0.48 && maxBorder < 0.49) {
							if (convergence > 0.8) color = mix(color, vec3(1.0, 1.0, 1.0), 0.5); // White border for high convergence
							else if (convergence > 0.5) color = mix(color, vec3(1.0, 1.0, 0.0), 0.3); // Yellow border for medium convergence
						}
						
					} else {
						// Standard heatmap
						color = getTemporalHeatmap(samples, 0.0, 0.0);
					}
					
					// Subtle grid for clarity
					vec2 grid = fract(gl_FragCoord.xy * 0.02);
					float gridLine = 1.0 - step(0.92, max(grid.x, grid.y)) * 0.2;
					color *= gridLine;
					
					gl_FragColor = vec4(color, 1.0);
				}
			`,
		} );
		this.heatmapQuad = new FullScreenQuad( this.heatmapMaterial );

		// Enhanced helper with temporal information
		this.helper = RenderTargetHelper( this.renderer, this.heatmapTarget, {
			width: 400,
			height: 400,
			position: 'bottom-right',
			theme: 'dark',
			title: 'Adaptive Sampling (Temporal Evolution)',
			autoUpdate: false
		} );
		this.toggleHelper( this.showAdaptiveSamplingHelper );
		document.body.appendChild( this.helper );

	}

	// Set reference to ASVGF pass
	setASVGFPass( asvgfPass ) {

		this.asvgfPass = asvgfPass;

	}

	// Toggle visualization helper
	toggleHelper( signal ) {

		signal ? this.helper.show() : this.helper.hide();
		this.showAdaptiveSamplingHelper = signal;
		if ( this.heatmapMaterial ) {

			this.heatmapMaterial.uniforms.showDebugInfo.value = signal;
			this.heatmapMaterial.uniforms.showTemporalEvolution.value = signal;

		}

	}

	reset() {

		this.counter = 0;
		this.material.uniforms.frameNumber.value = 0;

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.renderTarget.setSize( width, height );
		this.heatmapTarget.setSize( width, height );
		this.material.uniforms.resolution.value.set( width, height );

	}

	// Temporal adaptation parameters
	setTemporalAdaptationParameters( params ) {

		if ( params.minConvergenceFrames !== undefined ) {

			this.material.uniforms.minConvergenceFrames.value = params.minConvergenceFrames;

		}

		if ( params.maxConvergenceFrames !== undefined ) {

			this.material.uniforms.maxConvergenceFrames.value = params.maxConvergenceFrames;

		}

		if ( params.temporalAdaptationRate !== undefined ) {

			this.material.uniforms.temporalAdaptationRate.value = params.temporalAdaptationRate;

		}

		if ( params.varianceDecayRate !== undefined ) {

			this.material.uniforms.varianceDecayRate.value = params.varianceDecayRate;

		}

	}

	// Add setter methods for external parameter updates
	setAdaptiveSamplingMin( value ) {

		this.adaptiveSamplingMin = value;
		this.material.uniforms.adaptiveSamplingMin.value = value;

	}

	setAdaptiveSamplingMax( value ) {

		this.adaptiveSamplingMax = value;
		this.material.uniforms.adaptiveSamplingMax.value = value;

	}

	setAdaptiveSamplingVarianceThreshold( value ) {

		this.adaptiveSamplingVarianceThreshold = value;
		this.material.uniforms.adaptiveSamplingVarianceThreshold.value = value;

	}

	render( renderer ) {

		if ( ! this.enabled ) return;

		this.counter ++;
		if ( this.counter <= this.delayByFrames ) return;

		this.material.uniforms.frameNumber.value ++;

		// Get ASVGF temporal data and update flags
		let hasASVGFColor = false;
		let hasASVGFVariance = false;

		if ( this.asvgfPass ) {

			const colorTexture = this.asvgfPass.temporalColorTarget?.texture;
			const varianceTexture = this.asvgfPass.varianceTarget?.texture;

			if ( colorTexture ) {

				this.material.uniforms.asvgfColorTexture.value = colorTexture;
				hasASVGFColor = true;

			}

			if ( varianceTexture ) {

				this.material.uniforms.asvgfVarianceTexture.value = varianceTexture;
				hasASVGFVariance = true;

			}

		}

		// Update boolean flags
		this.material.uniforms.hasASVGFColor.value = hasASVGFColor;
		this.material.uniforms.hasASVGFVariance.value = hasASVGFVariance;
		this.material.uniforms.hasNormalDepth.value = !! this.material.uniforms.normalDepthTexture.value;
		this.material.uniforms.hasCurrentColor.value = !! this.material.uniforms.currentColorTexture.value;

		// Update parameters - ensure they're always current
		this.material.uniforms.adaptiveSamplingMin.value = this.adaptiveSamplingMin;
		this.material.uniforms.adaptiveSamplingMax.value = this.adaptiveSamplingMax;
		this.material.uniforms.adaptiveSamplingVarianceThreshold.value = this.adaptiveSamplingVarianceThreshold;

		// Render adaptive sampling decision
		renderer.setRenderTarget( this.renderTarget );
		this.fsQuad.render( renderer );

		// Validate the output - debug logging if needed
		if ( this.material.uniforms.frameNumber.value % 60 === 0 && ! hasASVGFColor && ! this.material.uniforms.hasNormalDepth.value ) {

			console.warn( 'AdaptiveSamplingPass: No ASVGF or G-buffer data available, using fallback sampling' );

		}

		// Update visualization if enabled
		if ( this.showAdaptiveSamplingHelper ) {

			this.heatmapMaterial.uniforms.samplingTexture.value = this.renderTarget.texture;
			this.heatmapMaterial.uniforms.minSamples.value = this.adaptiveSamplingMin;
			this.heatmapMaterial.uniforms.maxSamples.value = this.adaptiveSamplingMax;

			renderer.setRenderTarget( this.heatmapTarget );
			this.heatmapQuad.render( renderer );
			this.helper.update();

		}

		// Render to screen if final pass
		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );

		}

	}

	// Set input textures from MRT pipeline
	setTextures( currentColorTexture, normalDepthTexture ) {

		this.material.uniforms.currentColorTexture.value = currentColorTexture;
		this.material.uniforms.normalDepthTexture.value = normalDepthTexture;

		// Update boolean flags
		this.material.uniforms.hasCurrentColor.value = !! currentColorTexture;
		this.material.uniforms.hasNormalDepth.value = !! normalDepthTexture;

	}

	// Configure tile rendering mode
	setTileMode( enabled, tileBounds = null ) {

		this.material.uniforms.isTileMode.value = enabled;

		if ( enabled && tileBounds ) {

			// tileBounds: {x, y, width, height} in pixels
			this.material.uniforms.currentTileBounds.value.set(
				tileBounds.x,
				tileBounds.y,
				tileBounds.width,
				tileBounds.height
			);

		}

	}

	dispose() {

		this.renderTarget.dispose();
		this.heatmapTarget.dispose();
		this.material.dispose();
		this.heatmapMaterial.dispose();
		this.fsQuad.dispose();
		this.heatmapQuad.dispose();
		this.helper.dispose();

	}

}
