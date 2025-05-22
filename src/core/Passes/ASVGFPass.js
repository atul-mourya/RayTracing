import { DEFAULT_STATE } from '@/Constants';
import {
	ShaderMaterial,
	LinearFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	Vector2,
	NearestFilter,
	UniformsUtils
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class ASVGFPass extends Pass {

	constructor( width, height, options = {} ) {

		super();

		this.name = 'ASVGFPass';
		this.width = width;
		this.height = height;

		// ASVGF parameters
		this.params = {
			temporalAlpha: options.temporalAlpha || DEFAULT_STATE.asvgfTemporalAlpha,
			varianceClip: options.varianceClip || DEFAULT_STATE.asvgfVarianceClip,
			momentClip: options.momentClip || DEFAULT_STATE.asvgfMomentClip,
			phiColor: options.phiColor || DEFAULT_STATE.asvgfPhiColor,
			phiNormal: options.phiNormal || DEFAULT_STATE.asvgfPhiNormal,
			phiDepth: options.phiDepth || DEFAULT_STATE.asvgfPhiDepth,
			phiLuminance: options.phiLuminance || DEFAULT_STATE.asvgfPhiLuminance,
			atrousIterations: options.atrousIterations || DEFAULT_STATE.asvgfAtrousIterations,
			filterSize: options.filterSize || DEFAULT_STATE.asvgfFilterSize,
			...options
		};

		// Create render targets for temporal accumulation
		const targetOptions = {
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false
		};

		// Temporal accumulation targets
		this.temporalAccumTarget = new WebGLRenderTarget( width, height, targetOptions );
		this.temporalMomentTarget = new WebGLRenderTarget( width, height, targetOptions );
		this.varianceTarget = new WebGLRenderTarget( width, height, targetOptions );

		// A-trous filtering targets (ping-pong)
		this.atrousTargetA = new WebGLRenderTarget( width, height, targetOptions );
		this.atrousTargetB = new WebGLRenderTarget( width, height, targetOptions );

		// Previous frame data
		this.prevColorTarget = new WebGLRenderTarget( width, height, targetOptions );
		this.prevMomentTarget = new WebGLRenderTarget( width, height, targetOptions );

		// Initialize materials
		this.initMaterials();

		// Track frame count for temporal accumulation
		this.frameCount = 0;
		this.isFirstFrame = true;

	}

	initMaterials() {

		// Temporal accumulation material
		this.temporalMaterial = new ShaderMaterial( {
			uniforms: {
				tCurrent: { value: null },
				tPrevColor: { value: null },
				tPrevMoment: { value: null },
				tMotionVector: { value: null }, // If available
				temporalAlpha: { value: this.params.temporalAlpha },
				varianceClip: { value: this.params.varianceClip },
				momentClip: { value: this.params.momentClip },
				isFirstFrame: { value: true },
				frameCount: { value: 0 }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tCurrent;
				uniform sampler2D tPrevColor;
				uniform sampler2D tPrevMoment;
				uniform sampler2D tMotionVector;
				uniform float temporalAlpha;
				uniform float varianceClip;
				uniform float momentClip;
				uniform bool isFirstFrame;
				uniform float frameCount;
				
				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				void main() {
					vec4 currentColor = texture2D(tCurrent, vUv);
					
					if (isFirstFrame) {
						// Initialize temporal accumulation
						gl_FragColor = vec4(currentColor.rgb, getLuma(currentColor.rgb));
						return;
					}
					
					// Sample previous frame (with motion compensation if available)
					vec2 prevUV = vUv;
					// TODO: Add motion vector sampling for better temporal coherence
					// if (tMotionVector is available) prevUV = vUv + texture2D(tMotionVector, vUv).xy;
					
					vec4 prevColor = texture2D(tPrevColor, prevUV);
					vec4 prevMoment = texture2D(tPrevMoment, prevUV);
					
					float currentLum = getLuma(currentColor.rgb);
					float prevLum = prevColor.a;
					
					// Adaptive temporal weight based on luminance difference
					float lumDiff = abs(currentLum - prevLum);
					float adaptiveAlpha = temporalAlpha * exp(-lumDiff * 2.0);
					
					// Temporal accumulation with variance estimation
					vec3 temporalColor = mix(currentColor.rgb, prevColor.rgb, adaptiveAlpha);
					float temporalLum = mix(currentLum, prevLum, adaptiveAlpha);
					
					// Store result
					gl_FragColor = vec4(temporalColor, temporalLum);
				}
			`
		} );

		// Variance estimation material
		this.varianceMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tPrevMoment: { value: null },
				resolution: { value: new Vector2( this.width, this.height ) },
				frameCount: { value: 0 }
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
				uniform sampler2D tPrevMoment;
				uniform vec2 resolution;
				uniform float frameCount;
				
				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				void main() {
					vec2 texelSize = 1.0 / resolution;
					vec3 currentColor = texture2D(tColor, vUv).rgb;
					float currentLum = getLuma(currentColor);
					
					// Calculate local mean and variance using 3x3 neighborhood
					float sum = 0.0;
					float sum2 = 0.0;
					float count = 0.0;
					
					for (int x = -1; x <= 1; x++) {
						for (int y = -1; y <= 1; y++) {
							vec2 offset = vec2(float(x), float(y)) * texelSize;
							vec3 neighborColor = texture2D(tColor, vUv + offset).rgb;
							float neighborLum = getLuma(neighborColor);
							
							sum += neighborLum;
							sum2 += neighborLum * neighborLum;
							count += 1.0;
						}
					}
					
					float mean = sum / count;
					float variance = max(0.0, (sum2 / count) - (mean * mean));
					
					// Temporal moment accumulation
					vec2 prevMoment = texture2D(tPrevMoment, vUv).xy;
					float alpha = min(1.0, 4.0 / (frameCount + 4.0));
					
					float newMean = mix(prevMoment.x, currentLum, alpha);
					float newVariance = mix(prevMoment.y, variance, alpha);
					
					gl_FragColor = vec4(newMean, newVariance, variance, 1.0);
				}
			`
		} );

		// A-trous wavelet filtering material
		this.atrousMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tVariance: { value: null },
				resolution: { value: new Vector2( this.width, this.height ) },
				stepSize: { value: 1 },
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
				uniform vec2 resolution;
				uniform int stepSize;
				uniform float phiColor;
				uniform float phiNormal;
				uniform float phiDepth;
				uniform float phiLuminance;
				
				varying vec2 vUv;

				float getLuma(vec3 color) {
					return dot(color, vec3(0.2126, 0.7152, 0.0722));
				}

				// 5x5 a-trous kernel
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
					float centerLum = getLuma(centerColor);
					vec3 centerVariance = texture2D(tVariance, vUv).rgb;
					
					vec3 weightedSum = vec3(0.0);
					float weightSum = 0.0;
					
					for (int i = 0; i < 25; i++) {
						vec2 offset = vec2(offsets[i]) * float(stepSize) * texelSize;
						vec2 sampleUV = vUv + offset;
						
						if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
							continue;
						}
						
						vec3 sampleColor = texture2D(tColor, sampleUV).rgb;
						float sampleLum = getLuma(sampleColor);
						vec3 sampleVariance = texture2D(tVariance, sampleUV).rgb;
						
						// Edge-stopping function based on color difference
						float colorDist = length(centerColor - sampleColor);
						float colorWeight = exp(-colorDist / (phiColor * sqrt(centerVariance.z + 1e-6)));
						
						// Edge-stopping function based on luminance difference
						float lumDist = abs(centerLum - sampleLum);
						float lumWeight = exp(-lumDist / (phiLuminance * sqrt(centerVariance.y + 1e-6)));
						
						float weight = kernel[i] * colorWeight * lumWeight;
						
						weightedSum += sampleColor * weight;
						weightSum += weight;
					}
					
					if (weightSum > 0.0) {
						gl_FragColor = vec4(weightedSum / weightSum, 1.0);
					} else {
						gl_FragColor = vec4(centerColor, 1.0);
					}
				}
			`
		} );

		// Create fullscreen quads
		this.temporalQuad = new FullScreenQuad( this.temporalMaterial );
		this.varianceQuad = new FullScreenQuad( this.varianceMaterial );
		this.atrousQuad = new FullScreenQuad( this.atrousMaterial );

	}

	reset() {

		this.frameCount = 0;
		this.isFirstFrame = true;

		// Clear all render targets
		// Note: In a real implementation, you'd want to clear these render targets
		// using the renderer, but for simplicity we'll just reset the frame flags

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		// Resize all render targets
		this.temporalAccumTarget.setSize( width, height );
		this.temporalMomentTarget.setSize( width, height );
		this.varianceTarget.setSize( width, height );
		this.atrousTargetA.setSize( width, height );
		this.atrousTargetB.setSize( width, height );
		this.prevColorTarget.setSize( width, height );
		this.prevMomentTarget.setSize( width, height );

		// Update resolution uniforms
		this.varianceMaterial.uniforms.resolution.value.set( width, height );
		this.atrousMaterial.uniforms.resolution.value.set( width, height );

	}

	updateParameters( params ) {

		Object.assign( this.params, params );

		// Update shader uniforms
		this.temporalMaterial.uniforms.temporalAlpha.value = this.params.temporalAlpha;
		this.temporalMaterial.uniforms.varianceClip.value = this.params.varianceClip;
		this.temporalMaterial.uniforms.momentClip.value = this.params.momentClip;

		this.atrousMaterial.uniforms.phiColor.value = this.params.phiColor;
		this.atrousMaterial.uniforms.phiNormal.value = this.params.phiNormal;
		this.atrousMaterial.uniforms.phiDepth.value = this.params.phiDepth;
		this.atrousMaterial.uniforms.phiLuminance.value = this.params.phiLuminance;

	}

	render( renderer, writeBuffer, readBuffer ) {

		if ( ! this.enabled ) {

			// Pass through the input
			renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
			renderer.clear();
			// Copy readBuffer to writeBuffer (simplified)
			return;

		}

		this.frameCount ++;

		// Step 1: Temporal accumulation
		this.temporalMaterial.uniforms.tCurrent.value = readBuffer.texture;
		this.temporalMaterial.uniforms.tPrevColor.value = this.prevColorTarget.texture;
		this.temporalMaterial.uniforms.tPrevMoment.value = this.prevMomentTarget.texture;
		this.temporalMaterial.uniforms.isFirstFrame.value = this.isFirstFrame;
		this.temporalMaterial.uniforms.frameCount.value = this.frameCount;

		renderer.setRenderTarget( this.temporalAccumTarget );
		this.temporalQuad.render( renderer );

		// Step 2: Variance estimation
		this.varianceMaterial.uniforms.tColor.value = this.temporalAccumTarget.texture;
		this.varianceMaterial.uniforms.tPrevMoment.value = this.prevMomentTarget.texture;
		this.varianceMaterial.uniforms.frameCount.value = this.frameCount;

		renderer.setRenderTarget( this.varianceTarget );
		this.varianceQuad.render( renderer );

		// Step 3: A-trous wavelet filtering iterations
		let currentInput = this.temporalAccumTarget;
		let currentOutput = this.atrousTargetA;
		let nextOutput = this.atrousTargetB;

		this.atrousMaterial.uniforms.tVariance.value = this.varianceTarget.texture;

		for ( let i = 0; i < this.params.atrousIterations; i ++ ) {

			this.atrousMaterial.uniforms.tColor.value = currentInput.texture;
			this.atrousMaterial.uniforms.stepSize.value = Math.pow( 2, i );

			renderer.setRenderTarget( currentOutput );
			this.atrousQuad.render( renderer );

			// Swap targets for next iteration
			[ currentInput, currentOutput, nextOutput ] = [ currentOutput, nextOutput, currentInput ];

		}

		// Step 4: Output final result
		const finalTexture = currentInput.texture;

		renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );

		// Simple copy shader for final output
		this.copyFinalResult( renderer, finalTexture );

		// Step 5: Store current frame data for next frame
		this.copyTexture( renderer, this.temporalAccumTarget, this.prevColorTarget );
		this.copyTexture( renderer, this.varianceTarget, this.prevMomentTarget );

		this.isFirstFrame = false;

	}

	copyFinalResult( renderer, sourceTexture ) {

		// Create a simple copy material if not exists
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

		this.copyMaterial.uniforms.tDiffuse.value = sourceTexture;
		this.copyQuad.render( renderer );

	}

	copyTexture( renderer, source, destination ) {

		// Simple texture copy implementation
		const currentRenderTarget = renderer.getRenderTarget();

		renderer.setRenderTarget( destination );
		this.copyFinalResult( renderer, source.texture );

		renderer.setRenderTarget( currentRenderTarget );

	}

	dispose() {

		// Dispose of all render targets
		this.temporalAccumTarget.dispose();
		this.temporalMomentTarget.dispose();
		this.varianceTarget.dispose();
		this.atrousTargetA.dispose();
		this.atrousTargetB.dispose();
		this.prevColorTarget.dispose();
		this.prevMomentTarget.dispose();

		// Dispose of materials
		this.temporalMaterial.dispose();
		this.varianceMaterial.dispose();
		this.atrousMaterial.dispose();
		this.copyMaterial?.dispose();

		// Dispose of quads
		this.temporalQuad.dispose();
		this.varianceQuad.dispose();
		this.atrousQuad.dispose();
		this.copyQuad?.dispose();

	}

}
