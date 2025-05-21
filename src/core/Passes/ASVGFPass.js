import {
	WebGLRenderTarget,
	FloatType,
	NearestFilter,
	RGBAFormat,
	ShaderMaterial,
	Vector2,
	Matrix4,
	LinearFilter,
	UnsignedByteType
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class ASVGFPass extends Pass {

	constructor( renderer, width, height ) {

		super();
		this.name = 'ASVGFPass';
		this.renderer = renderer;
		this.width = width;
		this.height = height;

		// ASVGF parameters
		this.enabled = false;
		this.iterations = 4; // A-trous wavelet iterations
		this.temporalWeight = 0.8; // Temporal accumulation factor
		this.spatialSigma = 1.0; // Spatial filter strength
		this.featureSigma = 0.5; // Feature filter strength
		this.useTemporal = true; // Use temporal accumulation
		this.debug = false;

		// Create a reusable Vector2(0,0) for copyFramebufferToTexture
		this.bufferPosition = new Vector2( 0, 0 );

		this.init();

	}

	init() {

		// Create render targets
		this.createRenderTargets();

		// Create shader materials
		this.createMaterials();

		// Create quads
		this.temporalQuad = new FullScreenQuad( this.temporalMaterial );
		this.varianceQuad = new FullScreenQuad( this.varianceMaterial );
		this.atrous1Quad = new FullScreenQuad( this.atrous1Material );
		this.atrous2Quad = new FullScreenQuad( this.atrous2Material );
		this.finalQuad = new FullScreenQuad( this.finalMaterial );

		this.frame = 0;

	}

	createRenderTargets() {

		const options = {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false
		};

		// Temporal accumulation targets
		this.historyTarget = new WebGLRenderTarget( this.width, this.height, options );
		this.currentTarget = new WebGLRenderTarget( this.width, this.height, options );

		// G-buffer targets (normals, depth)
		this.normalTarget = new WebGLRenderTarget( this.width, this.height, options );
		this.depthTarget = new WebGLRenderTarget( this.width, this.height, options );

		// Variance targets
		this.varianceTarget = new WebGLRenderTarget( this.width, this.height, options );

		// A-trous wavelet filter ping-pong targets
		this.atrousTargetA = new WebGLRenderTarget( this.width, this.height, options );
		this.atrousTargetB = new WebGLRenderTarget( this.width, this.height, options );

	}

	createMaterials() {

		// Temporal accumulation shader
		this.temporalMaterial = new ShaderMaterial( {
			uniforms: {
				tCurrent: { value: null },
				tHistory: { value: null },
				tNormal: { value: null },
				tDepth: { value: null },
				temporalWeight: { value: this.temporalWeight },
				resolution: { value: new Vector2( this.width, this.height ) },
				prevViewMatrix: { value: new Matrix4() },
				prevProjectionMatrix: { value: new Matrix4() },
				currentViewMatrix: { value: new Matrix4() },
				currentProjectionMatrix: { value: new Matrix4() },
				frame: { value: 0 }
			},
			vertexShader: /* glsl */`
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
			fragmentShader: /* glsl */`
                uniform sampler2D tCurrent;
                uniform sampler2D tHistory;
                uniform sampler2D tNormal;
                uniform sampler2D tDepth;
                uniform float temporalWeight;
                uniform vec2 resolution;
                uniform mat4 prevViewMatrix;
                uniform mat4 prevProjectionMatrix;
                uniform mat4 currentViewMatrix;
                uniform mat4 currentProjectionMatrix;
                uniform float frame;
                varying vec2 vUv;
                
                void main() {
                    // Get current pixel data
                    vec4 currentColor = texture2D(tCurrent, vUv);
                    vec3 normal = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
                    float depth = texture2D(tDepth, vUv).x;
                    
                    // Skip background or invalid pixels
                    if (depth >= 1.0) {
                        gl_FragColor = currentColor;
                        return;
                    }
                    
                    // Reconstruct world position
                    vec4 clipPos = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
                    vec4 viewPos = inverse(currentProjectionMatrix) * clipPos;
                    viewPos /= viewPos.w;
                    vec4 worldPos = inverse(currentViewMatrix) * viewPos;
                    
                    // Reproject to previous frame
                    vec4 prevClipPos = prevProjectionMatrix * prevViewMatrix * worldPos;
                    prevClipPos /= prevClipPos.w;
                    
                    // Convert to UVs
                    vec2 prevUv = prevClipPos.xy * 0.5 + 0.5;
                    
                    // Check if previous position is within texture bounds
                    bool validHistory = prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0;
                    
                    vec4 historyColor = vec4(0.0);
                    float weight = 0.0;
                    
                    if (validHistory && frame > 0.0) {
                        // Get history color
                        historyColor = texture2D(tHistory, prevUv);
                        
                        // Adjust temporal blending weight based on motion
                        float motionMagnitude = length(prevUv - vUv);
                        weight = max(0.0, temporalWeight * (1.0 - motionMagnitude * 5.0));
                        
                        // Color blending
                        gl_FragColor = mix(currentColor, historyColor, weight);
                    } else {
                        gl_FragColor = currentColor;
                    }
                }
            `
		} );

		// Variance estimation shader
		this.varianceMaterial = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tHistory: { value: null },
				resolution: { value: new Vector2( this.width, this.height ) }
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
                uniform sampler2D tHistory;
                uniform vec2 resolution;
                varying vec2 vUv;
                
                void main() {
                    // Get current and history colors
                    vec4 currentColor = texture2D(tColor, vUv);
                    vec4 historyColor = texture2D(tHistory, vUv);
                    
                    // Calculate luminance
                    float luminance = dot(currentColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                    float historyLuminance = dot(historyColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                    
                    // Calculate variance (difference squared)
                    float variance = abs(luminance - historyLuminance);
                    variance = max(0.0001, variance * variance);
                    
                    // Store variance in alpha channel, color in RGB
                    gl_FragColor = vec4(currentColor.rgb, variance);
                }
            `
		} );

		// A-trous wavelet filter - first pass
		this.atrous1Material = new ShaderMaterial( {
			uniforms: {
				tColor: { value: null },
				tNormal: { value: null },
				tDepth: { value: null },
				tVariance: { value: null },
				resolution: { value: new Vector2( this.width, this.height ) },
				stepSize: { value: 1 }, // Will be 1, 2, 4, 8 for iterations
				spatialSigma: { value: this.spatialSigma },
				featureSigma: { value: this.featureSigma }
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
                uniform sampler2D tNormal;
                uniform sampler2D tDepth;
                uniform sampler2D tVariance;
                uniform vec2 resolution;
                uniform int stepSize;
                uniform float spatialSigma;
                uniform float featureSigma;
                varying vec2 vUv;
                
                float gaussianWeight(float dist, float sigma) {
                    return exp(-(dist * dist) / (2.0 * sigma * sigma));
                }
                
                void main() {
                    vec4 centerColor = texture2D(tColor, vUv);
                    vec3 centerNormal = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
                    float centerDepth = texture2D(tDepth, vUv).x;
                    float variance = texture2D(tVariance, vUv).w;
                    
                    // Skip background pixels
                    if (centerDepth >= 1.0) {
                        gl_FragColor = centerColor;
                        return;
                    }
                    
                    // A-trous filter kernel (5x5)
                    float kernel[25] = float[25](
                        1.0/256.0, 4.0/256.0, 6.0/256.0, 4.0/256.0, 1.0/256.0,
                        4.0/256.0, 16.0/256.0, 24.0/256.0, 16.0/256.0, 4.0/256.0,
                        6.0/256.0, 24.0/256.0, 36.0/256.0, 24.0/256.0, 6.0/256.0,
                        4.0/256.0, 16.0/256.0, 24.0/256.0, 16.0/256.0, 4.0/256.0,
                        1.0/256.0, 4.0/256.0, 6.0/256.0, 4.0/256.0, 1.0/256.0
                    );
                    
                    vec4 filteredColor = vec4(0.0);
                    float totalWeight = 0.0;
                    float step = float(stepSize);
                    vec2 pixelSize = 1.0 / resolution;
                    
                    // Adjust sigma based on variance
                    float varianceScale = 1.0 + variance * 10.0;
                    float adaptiveSigma = spatialSigma * varianceScale;
                    
                    // Apply filter
                    for (int y = -2; y <= 2; y++) {
                        for (int x = -2; x <= 2; x++) {
                            vec2 offset = vec2(float(x), float(y)) * step * pixelSize;
                            vec2 sampleUv = vUv + offset;
                            
                            // Skip out of bounds samples
                            if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
                                continue;
                            }
                            
                            vec4 sampleColor = texture2D(tColor, sampleUv);
                            vec3 sampleNormal = texture2D(tNormal, sampleUv).xyz * 2.0 - 1.0;
                            float sampleDepth = texture2D(tDepth, sampleUv).x;
                            
                            // Skip background samples
                            if (sampleDepth >= 1.0) {
                                continue;
                            }
                            
                            // Calculate weights
                            int kernelIdx = (y+2)*5 + (x+2);
                            float kernelWeight = kernel[kernelIdx];
                            
                            // Spatial weight
                            float spatialDist = length(vec2(float(x), float(y)));
                            float spatialWeight = gaussianWeight(spatialDist, adaptiveSigma);
                            
                            // Normal weight
                            float normalDist = 1.0 - dot(centerNormal, sampleNormal);
                            float normalWeight = gaussianWeight(normalDist, featureSigma);
                            
                            // Depth weight
                            float depthDist = abs(centerDepth - sampleDepth);
                            float depthWeight = gaussianWeight(depthDist * 100.0, featureSigma);
                            
                            // Combine weights
                            float weight = kernelWeight * spatialWeight * normalWeight * depthWeight;
                            
                            filteredColor += sampleColor * weight;
                            totalWeight += weight;
                        }
                    }
                    
                    // Normalize
                    if (totalWeight > 0.0) {
                        filteredColor /= totalWeight;
                    } else {
                        filteredColor = centerColor;
                    }
                    
                    gl_FragColor = filteredColor;
                }
            `
		} );

		// A-trous wavelet filter - subsequent passes
		this.atrous2Material = this.atrous1Material.clone();

		// Final composition shader
		this.finalMaterial = new ShaderMaterial( {
			uniforms: {
				tFiltered: { value: null },
				tOriginal: { value: null },
				tVariance: { value: null },
				debug: { value: false }
			},
			vertexShader: /* glsl */`
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
			fragmentShader: /* glsl */`
                uniform sampler2D tFiltered;
                uniform sampler2D tOriginal;
                uniform sampler2D tVariance;
                uniform bool debug;
                varying vec2 vUv;
                
                void main() {
                    vec4 filtered = texture2D(tFiltered, vUv);
                    vec4 original = texture2D(tOriginal, vUv);
                    float variance = texture2D(tVariance, vUv).w;
                    
                    if (debug) {
                        // In debug mode, show the variance
                        gl_FragColor = vec4(vec3(variance * 100.0), 1.0);
                    } else {
                        gl_FragColor = filtered;
                    }
                }
            `
		} );

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		// Update render targets
		this.historyTarget.setSize( width, height );
		this.currentTarget.setSize( width, height );
		this.normalTarget.setSize( width, height );
		this.depthTarget.setSize( width, height );
		this.varianceTarget.setSize( width, height );
		this.atrousTargetA.setSize( width, height );
		this.atrousTargetB.setSize( width, height );

		// Update uniforms
		const resolution = new Vector2( width, height );
		this.temporalMaterial.uniforms.resolution.value = resolution;
		this.varianceMaterial.uniforms.resolution.value = resolution;
		this.atrous1Material.uniforms.resolution.value = resolution;
		this.atrous2Material.uniforms.resolution.value = resolution;

	}

	render( renderer, writeBuffer, readBuffer, gBuffer ) {

		if ( ! this.enabled ) {

			// Just pass through
			renderer.setRenderTarget( writeBuffer );
			this.finalMaterial.uniforms.tFiltered.value = readBuffer.texture;
			this.finalQuad.render( renderer );
			return;

		}

		const prevFrame = this.frame > 0;
		this.frame ++;

		// 1. Temporal accumulation
		if ( this.useTemporal && prevFrame ) {

			this.temporalMaterial.uniforms.tCurrent.value = readBuffer.texture;
			this.temporalMaterial.uniforms.tHistory.value = this.historyTarget.texture;

			// Set G-buffer textures if available
			if ( gBuffer ) {

				this.temporalMaterial.uniforms.tNormal.value = gBuffer.normals;
				this.temporalMaterial.uniforms.tDepth.value = gBuffer.depth;

			}

			this.temporalMaterial.uniforms.frame.value = this.frame;

			renderer.setRenderTarget( this.currentTarget );
			this.temporalQuad.render( renderer );

		} else {

			// First frame, just copy - corrected implementation
			// Instead of directly copying the framebuffer, render the readBuffer texture to our target
			this.finalMaterial.uniforms.tFiltered.value = readBuffer.texture;
			renderer.setRenderTarget( this.currentTarget );
			this.finalQuad.render( renderer );

		}

		// 2. Calculate variance
		this.varianceMaterial.uniforms.tColor.value = this.currentTarget.texture;
		this.varianceMaterial.uniforms.tHistory.value = this.historyTarget.texture;

		renderer.setRenderTarget( this.varianceTarget );
		this.varianceQuad.render( renderer );

		// 3. A-trous wavelet filtering
		// First iteration
		this.atrous1Material.uniforms.tColor.value = this.currentTarget.texture;
		this.atrous1Material.uniforms.tVariance.value = this.varianceTarget.texture;
		this.atrous1Material.uniforms.stepSize.value = 1;

		// Set G-buffer textures if available
		if ( gBuffer ) {

			this.atrous1Material.uniforms.tNormal.value = gBuffer.normals;
			this.atrous1Material.uniforms.tDepth.value = gBuffer.depth;

		}

		renderer.setRenderTarget( this.atrousTargetA );
		this.atrous1Quad.render( renderer );

		// Subsequent iterations with increasing step sizes
		let sourceTarget = this.atrousTargetA;
		let destTarget = this.atrousTargetB;

		for ( let i = 1; i < this.iterations; i ++ ) {

			this.atrous2Material.uniforms.tColor.value = sourceTarget.texture;
			this.atrous2Material.uniforms.tVariance.value = this.varianceTarget.texture;
			this.atrous2Material.uniforms.stepSize.value = Math.pow( 2, i );

			// Set G-buffer textures if available
			if ( gBuffer ) {

				this.atrous2Material.uniforms.tNormal.value = gBuffer.normals;
				this.atrous2Material.uniforms.tDepth.value = gBuffer.depth;

			}

			renderer.setRenderTarget( destTarget );
			this.atrous2Quad.render( renderer );

			// Swap targets for next iteration
			[ sourceTarget, destTarget ] = [ destTarget, sourceTarget ];

		}

		// 4. Final output
		this.finalMaterial.uniforms.tFiltered.value = sourceTarget.texture;
		this.finalMaterial.uniforms.tOriginal.value = readBuffer.texture;
		this.finalMaterial.uniforms.tVariance.value = this.varianceTarget.texture;
		this.finalMaterial.uniforms.debug.value = this.debug;

		renderer.setRenderTarget( writeBuffer );
		this.finalQuad.render( renderer );

		// Store current frame for next frame's temporal reprojection - corrected implementation
		renderer.setRenderTarget( this.historyTarget );
		this.finalMaterial.uniforms.tFiltered.value = this.currentTarget.texture;
		this.finalQuad.render( renderer );

	}

	reset() {

		this.frame = 0;
		// Clear history buffer
		this.renderer.setRenderTarget( this.historyTarget );
		this.renderer.clear();

	}

	dispose() {

		// Dispose render targets
		this.historyTarget.dispose();
		this.currentTarget.dispose();
		this.normalTarget.dispose();
		this.depthTarget.dispose();
		this.varianceTarget.dispose();
		this.atrousTargetA.dispose();
		this.atrousTargetB.dispose();

		// Dispose materials
		this.temporalMaterial.dispose();
		this.varianceMaterial.dispose();
		this.atrous1Material.dispose();
		this.atrous2Material.dispose();
		this.finalMaterial.dispose();

		// Dispose quads
		this.temporalQuad.dispose();
		this.varianceQuad.dispose();
		this.atrous1Quad.dispose();
		this.atrous2Quad.dispose();
		this.finalQuad.dispose();

	}

}
