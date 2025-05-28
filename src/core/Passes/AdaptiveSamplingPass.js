import {
	ShaderMaterial,
	RedFormat,
	UnsignedByteType,
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

		// Temporal statistics reference (to be set from the outside)
		this.temporalStatsPass = null;

		// Create the render target to store adaptive sampling data
		this.renderTarget = new WebGLRenderTarget( width, height, {
			format: RedFormat, // Only need one channel
			type: UnsignedByteType, // 8-bit integer is sufficient for 0-255
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// material that uses both spatial and temporal variance
		this.material = new ShaderMaterial( {
			uniforms: {
				resolution: { value: new Vector2( width, height ) },
				previousFrameTexture: { value: null },
				accumulatedFrameTexture: { value: null },
				temporalVarianceTexture: { value: null }, // From TemporalStatisticsPass
				meanTexture: { value: null }, // From TemporalStatisticsPass
				adaptiveSamplingMin: { value: this.adaptiveSamplingMin },
				adaptiveSamplingMax: { value: this.adaptiveSamplingMax },
				adaptiveSamplingVarianceThreshold: { value: this.adaptiveSamplingVarianceThreshold },
				temporalWeight: { value: 0.7 }, // Weight for temporal vs spatial variance
				frameNumber: { value: 0 }, // Current frame number
				convergenceBoost: { value: 1.5 }, // Boost factor for converged pixels
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
				uniform sampler2D previousFrameTexture;
				uniform sampler2D accumulatedFrameTexture;
				uniform sampler2D temporalVarianceTexture;
				uniform sampler2D meanTexture;
				uniform int adaptiveSamplingMin;
				uniform int adaptiveSamplingMax;
				uniform float adaptiveSamplingVarianceThreshold;
				uniform float temporalWeight;
				uniform int frameNumber;
				uniform float convergenceBoost;
				
				// Optimized luminance calculation
				float getLuminance(vec3 color) {
					return dot(color, vec3(0.299, 0.587, 0.114)); // Use Rec.601 for better performance
				}
				
				void main() {
					vec2 texCoord = gl_FragCoord.xy / resolution;

					// Get temporal statistics
					vec4 temporalStats = texture(temporalVarianceTexture, texCoord);
					float temporalLuminanceVar = getLuminance(temporalStats.rgb);
					float errorEstimate = temporalStats.a;
					
					// Get sample count
					float n = texture(meanTexture, texCoord).a;
					
					// Early frames get default sampling
					if (frameNumber < 3) {
						float samples = float(adaptiveSamplingMin + adaptiveSamplingMax) * 0.5;
						gl_FragColor = vec4(samples / float(adaptiveSamplingMax), 0.0, 0.0, 1.0);
						return;
					}
					
					// Simple convergence check with more relaxed threshold
					bool isConverged = false;
					float convergenceThreshold = adaptiveSamplingVarianceThreshold;
					
					// Progressive convergence - relax threshold over time
					if (n > 50.0) {
						convergenceThreshold *= 2.0;
					} else if (n > 100.0) {
						convergenceThreshold *= 3.0;
					}
					
					if (n > 20.0 && errorEstimate < convergenceThreshold) {
						isConverged = true;
					}
					
					// Calculate sample allocation
					float sampleFactor;
					
					if (isConverged) {
						// Converged pixels get minimum samples
						sampleFactor = 0.0;
					} else {
						// Simple linear mapping based on error
						float normalizedError = errorEstimate / (adaptiveSamplingVarianceThreshold * 5.0);
						sampleFactor = clamp(normalizedError, 0.0, 1.0);
						
						// Boost samples for pixels that are close to convergence
						if (n > 10.0 && normalizedError < 0.5) {
							sampleFactor = max(sampleFactor, 0.3); // Ensure at least 30% samples
						}
					}
					
					// Convert to actual sample count with smooth interpolation
					float samples = mix(float(adaptiveSamplingMin), float(adaptiveSamplingMax), sampleFactor);
					
					// Round to nearest integer
					samples = floor(samples + 0.5);
					
					// Normalize for storage
					float normalizedSamples = samples / float(adaptiveSamplingMax);
					
					// Store results
					gl_FragColor = vec4(normalizedSamples, errorEstimate / adaptiveSamplingVarianceThreshold, isConverged ? 1.0 : 0.0, 1.0);
				}
			`,
		} );

		this.fsQuad = new FullScreenQuad( this.material );

		// render target for the variance heatmap visualization
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
				showConverged: { value: false } // Option to highlight converged pixels
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
				uniform bool showConverged;
				varying vec2 vUv;
			
				// Improved color mapping for better visibility
				vec3 getHeatmapColor(float value) {
					// Colors from cold to hot
					vec3 color0 = vec3(0.0, 0.0, 0.5);   // Dark blue - minimum samples
					vec3 color1 = vec3(0.0, 0.5, 1.0);   // Light blue
					vec3 color2 = vec3(0.0, 1.0, 0.5);   // Cyan-green
					vec3 color3 = vec3(1.0, 1.0, 0.0);   // Yellow
					vec3 color4 = vec3(1.0, 0.5, 0.0);   // Orange
					vec3 color5 = vec3(1.0, 0.0, 0.0);   // Red - maximum samples
					
					float t = clamp(value, 0.0, 1.0);
					
					if (t < 0.2) {
						return mix(color0, color1, t * 5.0);
					} else if (t < 0.4) {
						return mix(color1, color2, (t - 0.2) * 5.0);
					} else if (t < 0.6) {
						return mix(color2, color3, (t - 0.4) * 5.0);
					} else if (t < 0.8) {
						return mix(color3, color4, (t - 0.6) * 5.0);
					} else {
						return mix(color4, color5, (t - 0.8) * 5.0);
					}
				}
			
				void main() {
					vec4 samplingData = texture2D(samplingTexture, vUv);
					
					// Get normalized sample count and convergence status
					float normalizedSamples = samplingData.r;
					float variance = samplingData.g;
					bool isConverged = samplingData.b > 0.5;
					
					// Convert back to actual sample count for display
					float samples = normalizedSamples * maxSamples;
					float displayValue = (samples - minSamples) / (maxSamples - minSamples);
					
					vec3 color = getHeatmapColor(displayValue * heatmapIntensity);
					
					// Highlight converged pixels if enabled
					if (showConverged && isConverged) {
						// Add white outline or tint for converged pixels
						color = mix(color, vec3(1.0), 0.3);
					}
					
					// Add subtle grid pattern for better visibility
					vec2 grid = fract(gl_FragCoord.xy * 0.1);
					float gridLine = 1.0 - step(0.98, max(grid.x, grid.y)) * 0.1;
					color *= gridLine;
					
					gl_FragColor = vec4(color, 1.0);
				}
			`,
		} );
		this.heatmapQuad = new FullScreenQuad( this.heatmapMaterial );

		this.helper = RenderTargetHelper( this.renderer, this.heatmapTarget, {
			width: 250,
			height: 250,
			position: 'bottom-right',
			theme: 'dark',
			title: 'Adaptive Sampling',
			autoUpdate: false // We'll manually update when needed
		} );
		this.toggleHelper( this.showAdaptiveSamplingHelper );
		document.body.appendChild( this.helper );

	}

	// Set reference to the TemporalStatisticsPass
	setTemporalStatisticsPass( statsPass ) {

		this.temporalStatsPass = statsPass;

	}

	toggleHelper( signal ) {

		signal ? this.helper.show() : this.helper.hide();
		this.showAdaptiveSamplingHelper = signal;
		if ( this.heatmapMaterial ) {

			this.heatmapMaterial.uniforms.showConverged.value = signal;

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

	render( renderer ) {

		if ( ! this.enabled ) return;

		this.counter ++;
		if ( this.counter <= this.delayByFrames ) return;

		this.material.uniforms.frameNumber.value ++;

		if ( ! this.material.uniforms.previousFrameTexture.value || ! this.material.uniforms.accumulatedFrameTexture.value ) {

			console.warn( 'AdaptiveSamplingPass: Missing required textures' );
			return;

		}

		// Set temporal statistics textures if available
		if ( this.temporalStatsPass ) {

			this.material.uniforms.temporalVarianceTexture.value = this.temporalStatsPass.getVarianceTexture();
			this.material.uniforms.meanTexture.value = this.temporalStatsPass.getMeanTexture();

		}

		// Update adaptive sampling parameters
		this.material.uniforms.adaptiveSamplingMin.value = this.adaptiveSamplingMin;
		this.material.uniforms.adaptiveSamplingMax.value = this.adaptiveSamplingMax;
		this.material.uniforms.adaptiveSamplingVarianceThreshold.value = this.adaptiveSamplingVarianceThreshold;

		renderer.setRenderTarget( this.renderTarget );
		this.fsQuad.render( renderer );

		// Only render heatmap visualization when helper is visible
		if ( this.showAdaptiveSamplingHelper ) {

			this.heatmapMaterial.uniforms.samplingTexture.value = this.renderTarget.texture;
			this.heatmapMaterial.uniforms.minSamples.value = this.adaptiveSamplingMin;
			this.heatmapMaterial.uniforms.maxSamples.value = this.adaptiveSamplingMax;

			renderer.setRenderTarget( this.heatmapTarget );
			this.heatmapQuad.render( renderer );
			this.helper.update();

		}

		// If this is the final pass in the chain, render to screen
		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );

		}

	}

	// Set the input textures
	setTextures( previousFrame, accumulatedFrame ) {

		this.material.uniforms.previousFrameTexture.value = previousFrame;
		this.material.uniforms.accumulatedFrameTexture.value = accumulatedFrame;

	}

	// Update convergence boost
	setConvergenceBoost( value ) {

		this.material.uniforms.convergenceBoost.value = value;

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
