import {
	ShaderMaterial,
	WebGLRenderTarget,
	NearestFilter,
	Vector2,
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

				// Enhanced edge detection with temporal adaptation
				float detectEdges(vec2 uv, float historyLength) {
					if (!hasNormalDepth) return 0.0;
					
					vec2 texelSize = 1.0 / resolution;
					
					// Sample normal variations
					vec3 n0 = texture2D(normalDepthTexture, uv).rgb * 2.0 - 1.0;
					vec3 n1 = texture2D(normalDepthTexture, uv + vec2(texelSize.x, 0.0)).rgb * 2.0 - 1.0;
					vec3 n2 = texture2D(normalDepthTexture, uv + vec2(0.0, texelSize.y)).rgb * 2.0 - 1.0;
					vec3 n3 = texture2D(normalDepthTexture, uv + vec2(-texelSize.x, 0.0)).rgb * 2.0 - 1.0;
					vec3 n4 = texture2D(normalDepthTexture, uv + vec2(0.0, -texelSize.y)).rgb * 2.0 - 1.0;
					
					float normalEdge = length(n0 - n1) + length(n0 - n2) + length(n0 - n3) + length(n0 - n4);
					
					// Sample depth variations
					float d0 = texture2D(normalDepthTexture, uv).a;
					float d1 = texture2D(normalDepthTexture, uv + vec2(texelSize.x, 0.0)).a;
					float d2 = texture2D(normalDepthTexture, uv + vec2(0.0, texelSize.y)).a;
					float d3 = texture2D(normalDepthTexture, uv + vec2(-texelSize.x, 0.0)).a;
					float d4 = texture2D(normalDepthTexture, uv + vec2(0.0, -texelSize.y)).a;
					
					float depthEdge = abs(d0 - d1) + abs(d0 - d2) + abs(d0 - d3) + abs(d0 - d4);
					
					float edgeStrength = (normalEdge + depthEdge * 15.0) * 1.5;
					
					// Gradual edge importance reduction over time
					if (historyLength > minConvergenceFrames) {
						float edgeDecay = pow(0.97, (historyLength - minConvergenceFrames) / 5.0);
						edgeStrength *= edgeDecay;
					}
					
					return clamp(edgeStrength, 0.0, 1.0);
				}

				// Progressive convergence function
				float calculateConvergenceWeight(float historyLength, float variance) {
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
					
					return convergenceCurve * varianceWeight;
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

					// Extract temporal data
					float historyLength = hasASVGFColor ? asvgfColor.a : 1.0;
					float variance = hasASVGFVariance ? asvgfVariance.a : 0.5;
					vec3 normal = hasNormalDepth ? normalDepth.rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
					float depth = hasNormalDepth ? normalDepth.a : 1.0;

					// Progressive convergence instead of binary
					float convergenceWeight = calculateConvergenceWeight(historyLength, variance);
					
					// Material analysis with temporal adaptation
					float materialComplexity = hasNormalDepth ? 
						classifyMaterial(normal, depth, asvgfColor.rgb, historyLength) : 1.0;
					
					// Edge detection with temporal adaptation
					float edgeStrength = detectEdges(texCoord, historyLength);

					// Base sample requirement with temporal evolution
					float baseRequirement;
					if (hasASVGFVariance) {
						// Use variance, but make it evolve over time
						float adaptedVariance = variance * pow(varianceDecayRate, historyLength / 20.0);
						baseRequirement = adaptedVariance / adaptiveSamplingVarianceThreshold;
					} else {
						// Fallback with temporal variation
						baseRequirement = 0.5 + sin(float(frameNumber) * 0.1) * 0.2;
					}
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
					
					// Convert to sample count with smoother transitions
					float sampleCount = mix(
						float(adaptiveSamplingMin), 
						float(adaptiveSamplingMax), 
						clamp(finalRequirement, 0.0, 1.0)
					);
					
					// Early frame boosting
					if (frameNumber < 10) {
						float earlyBoost = (10.0 - float(frameNumber)) / 10.0 * 0.3;
						sampleCount = max(sampleCount, float(adaptiveSamplingMax) * (0.5 + earlyBoost));
					}
					
					// Store normalized result
					float normalizedSamples = sampleCount / float(adaptiveSamplingMax);
					
					// Debug output showing temporal evolution
					if (debugMode) {
						gl_FragColor = vec4(
							normalizedSamples,
							hasASVGFColor ? convergenceWeight : 0.0, // Show convergence progress
							hasNormalDepth ? (historyLength / maxConvergenceFrames) : 0.0, // Show temporal progress
							materialComplexity / 2.5
						);
					} else {
						// Normal output
						gl_FragColor = vec4(
							normalizedSamples,
							variance / adaptiveSamplingVarianceThreshold, 
							convergenceWeight,
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

		// Update parameters
		this.material.uniforms.adaptiveSamplingMin.value = this.adaptiveSamplingMin;
		this.material.uniforms.adaptiveSamplingMax.value = this.adaptiveSamplingMax;
		this.material.uniforms.adaptiveSamplingVarianceThreshold.value = this.adaptiveSamplingVarianceThreshold;

		// Render adaptive sampling decision
		renderer.setRenderTarget( this.renderTarget );
		this.fsQuad.render( renderer );

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
