import {
	ShaderMaterial,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	NearestFilter,
	Vector2,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DEFAULT_STATE } from '../../Constants.js';

/**
 * TemporalStatisticsPass implements Welford's online algorithm for computing
 * running mean and variance of path-traced samples over time.
 *
 * This allows for true variance-guided adaptive sampling, resulting in more
 * efficient noise reduction where it's most needed.
 */
export class TemporalStatisticsPass extends Pass {

	constructor( renderer, width, height ) {

		super();

		this.renderer = renderer;
		this.width = width;
		this.height = height;
		this.name = 'TemporalStatisticsPass';
		this.enabled = true;

		// Initialize floating-point buffers to store statistics
		const params = {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			generateMipmaps: false
		};

		// Buffer A: RGB = mean color, A = sample count
		this.meanBuffer = new WebGLRenderTarget( width, height, params );
		this.meanBufferTemp = this.meanBuffer.clone();

		// Buffer B: RGB = M2 (sum of squared differences), A = convergence status or flags
		this.m2Buffer = new WebGLRenderTarget( width, height, params );
		this.m2BufferTemp = this.m2Buffer.clone();

		// The variance buffer is computed from M2 and used by the adaptive sampling pass
		this.varianceBuffer = new WebGLRenderTarget( width, height, params );

		// Create the mean update shader material
		this.meanUpdateMaterial = new ShaderMaterial( {
			uniforms: {
				resolution: { value: new Vector2( width, height ) },
				meanBuffer: { value: null },
				m2Buffer: { value: null },
				newSampleBuffer: { value: null },
				resetStatistics: { value: 0 },
				convergenceThreshold: { value: 0.001 },
				enableEarlyTermination: { value: DEFAULT_STATE.enableEarlyTermination }
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
                uniform sampler2D meanBuffer;    // RGB = mean, A = sample count
                uniform sampler2D m2Buffer;      // RGB = M2, A = flags
                uniform sampler2D newSampleBuffer; // New path-traced sample
                uniform int resetStatistics;
                uniform float convergenceThreshold;
                uniform bool enableEarlyTermination;
                
                varying vec2 vUv;
                
                void main() {
                    // Get current pixel statistics
                    vec4 meanData = texture2D(meanBuffer, vUv);
                    vec4 m2Data = texture2D(m2Buffer, vUv);
                    
                    vec3 mean = meanData.rgb;
                    float n = meanData.a;
                    vec3 m2 = m2Data.rgb;
                    float converged = m2Data.a;
                    
                    // Get new sample
                    vec3 newSample = texture2D(newSampleBuffer, vUv).rgb;
                    
                    // Reset statistics if requested
                    if (resetStatistics == 1) {
                        mean = newSample;
                        n = 1.0;
                        converged = 0.0;
                    } 
                    // Apply Welford's online algorithm for updating mean
                    else {
                        // Skip update if pixel is marked as converged AND early termination is enabled
                        if (!(enableEarlyTermination && converged > 0.5)) {
                            n += 1.0;
                            vec3 delta = newSample - mean;
                            mean = mean + delta / n;
                        }
                    }
                    
                    // Store updated mean and sample count
                    gl_FragColor = vec4(mean, n);
                }
            `
		} );

		// Create the M2 update shader material
		this.m2UpdateMaterial = new ShaderMaterial( {
			uniforms: {
				resolution: { value: new Vector2( width, height ) },
				meanBuffer: { value: null },
				m2Buffer: { value: null },
				newSampleBuffer: { value: null },
				resetStatistics: { value: 0 },
				convergenceThreshold: { value: 0.001 },
				enableEarlyTermination: { value: DEFAULT_STATE.enableEarlyTermination }
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
                uniform sampler2D meanBuffer;    // RGB = mean, A = sample count
                uniform sampler2D m2Buffer;      // RGB = M2, A = flags
                uniform sampler2D newSampleBuffer; // New path-traced sample
                uniform int resetStatistics;
                uniform float convergenceThreshold;
                uniform bool enableEarlyTermination;
                
                varying vec2 vUv;
                
                void main() {
                    // Get current pixel statistics
                    vec4 meanData = texture2D(meanBuffer, vUv);
                    vec4 m2Data = texture2D(m2Buffer, vUv);
                    
                    vec3 mean = meanData.rgb;
                    float n = meanData.a;
                    vec3 m2 = m2Data.rgb;
                    float converged = m2Data.a;
                    
                    // Get new sample
                    vec3 newSample = texture2D(newSampleBuffer, vUv).rgb;
                    
                    // Reset statistics if requested
                    if (resetStatistics == 1) {
                        m2 = vec3(0.0);
                        converged = 0.0;
                    } 
                    // Apply Welford's online algorithm for updating M2
                    else {
                        // Skip update if pixel is marked as converged AND early termination is enabled
                        if (!(enableEarlyTermination && converged > 0.5)) {
                            vec3 delta = newSample - mean;
                            m2 = m2 + delta * (newSample - mean);
                            
                            // Check for convergence (only if early termination is enabled)
                            if (enableEarlyTermination && n > 10.0) {
                                vec3 variance = m2 / max(n - 1.0, 1.0);
                                float luminanceVar = dot(variance, vec3(0.2126, 0.7152, 0.0722));
                                if (luminanceVar / n < convergenceThreshold) {
                                    converged = 1.0;
                                }
                            }
                        }
                    }
                    
                    // Store updated M2 and convergence flag
                    gl_FragColor = vec4(m2, converged);
                }
            `
		} );

		// Create the variance computation shader
		this.varianceComputeMaterial = new ShaderMaterial( {
			uniforms: {
				resolution: { value: new Vector2( width, height ) },
				meanBuffer: { value: null },
				m2Buffer: { value: null },
				minVariance: { value: 0.00001 },
				enableEarlyTermination: { value: false }
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
                uniform sampler2D meanBuffer;
                uniform sampler2D m2Buffer;
                uniform float minVariance;
                uniform bool enableEarlyTermination;
                
                varying vec2 vUv;
                
                void main() {
                    vec4 meanData = texture2D(meanBuffer, vUv);
                    vec4 m2Data = texture2D(m2Buffer, vUv);
                    
                    float n = max(meanData.a, 1.0);
                    vec3 m2 = m2Data.rgb;
                    float converged = m2Data.a;
                    
                    // Compute variance using Welford's formula
                    vec3 variance = m2 / max(n - 1.0, 1.0);
                    
                    // Ensure minimum variance to avoid division by zero issues
                    variance = max(variance, vec3(minVariance));
                    
                    // Convert to luminance variance for sampling decisions
                    float luminanceVar = dot(variance, vec3(0.2126, 0.7152, 0.0722));
                    
                    // Compute error estimate
                    float error = sqrt(luminanceVar / n);
                    
                    // If pixel is converged and early termination is enabled, mark it in the alpha channel
                    if (enableEarlyTermination && converged > 0.5) {
                        error = 0.0; // Signal that this pixel is converged
                    }
                    
                    // Store computed variance and error information
                    gl_FragColor = vec4(variance, error);
                }
            `
		} );

		this.meanUpdateQuad = new FullScreenQuad( this.meanUpdateMaterial );
		this.m2UpdateQuad = new FullScreenQuad( this.m2UpdateMaterial );
		this.varianceQuad = new FullScreenQuad( this.varianceComputeMaterial );

		this.resetNeeded = true;

	}

	reset() {

		this.resetNeeded = true;

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.meanBuffer.setSize( width, height );
		this.meanBufferTemp.setSize( width, height );
		this.m2Buffer.setSize( width, height );
		this.m2BufferTemp.setSize( width, height );
		this.varianceBuffer.setSize( width, height );

		this.meanUpdateMaterial.uniforms.resolution.value.set( width, height );
		this.m2UpdateMaterial.uniforms.resolution.value.set( width, height );
		this.varianceComputeMaterial.uniforms.resolution.value.set( width, height );

	}

	// Update statistics with a new sample frame
	update( newSampleTexture ) {

		if ( ! this.enabled ) return;

		const resetValue = this.resetNeeded ? 1 : 0;

		// Step 1: Update mean buffer
		this.meanUpdateMaterial.uniforms.meanBuffer.value = this.meanBuffer.texture;
		this.meanUpdateMaterial.uniforms.m2Buffer.value = this.m2Buffer.texture;
		this.meanUpdateMaterial.uniforms.newSampleBuffer.value = newSampleTexture;
		this.meanUpdateMaterial.uniforms.resetStatistics.value = resetValue;

		this.renderer.setRenderTarget( this.meanBufferTemp );
		this.meanUpdateQuad.render( this.renderer );

		// Swap mean buffers
		[ this.meanBuffer, this.meanBufferTemp ] = [ this.meanBufferTemp, this.meanBuffer ];

		// Step 2: Update M2 buffer (using the updated mean)
		this.m2UpdateMaterial.uniforms.meanBuffer.value = this.meanBuffer.texture;
		this.m2UpdateMaterial.uniforms.m2Buffer.value = this.m2Buffer.texture;
		this.m2UpdateMaterial.uniforms.newSampleBuffer.value = newSampleTexture;
		this.m2UpdateMaterial.uniforms.resetStatistics.value = resetValue;

		this.renderer.setRenderTarget( this.m2BufferTemp );
		this.m2UpdateQuad.render( this.renderer );

		// Swap M2 buffers
		[ this.m2Buffer, this.m2BufferTemp ] = [ this.m2BufferTemp, this.m2Buffer ];

		// Reset flag is consumed
		this.resetNeeded = false;

		// Compute variance for adaptive sampling
		this.computeVariance();

	}

	// Compute variance from mean and M2 values
	computeVariance() {

		this.varianceComputeMaterial.uniforms.meanBuffer.value = this.meanBuffer.texture;
		this.varianceComputeMaterial.uniforms.m2Buffer.value = this.m2Buffer.texture;

		this.renderer.setRenderTarget( this.varianceBuffer );
		this.varianceQuad.render( this.renderer );

	}

	// Set early termination flag
	setEnableEarlyTermination( enabled ) {

		this.meanUpdateMaterial.uniforms.enableEarlyTermination.value = enabled;
		this.m2UpdateMaterial.uniforms.enableEarlyTermination.value = enabled;
		this.varianceComputeMaterial.uniforms.enableEarlyTermination.value = enabled;

	}

	// Get mean color texture (for final output)
	getMeanTexture() {

		return this.meanBuffer.texture;

	}

	// Get variance texture (for adaptive sampling)
	getVarianceTexture() {

		return this.varianceBuffer.texture;

	}

	// Set convergence threshold for early termination
	setConvergenceThreshold( threshold ) {

		this.meanUpdateMaterial.uniforms.convergenceThreshold.value = threshold;
		this.m2UpdateMaterial.uniforms.convergenceThreshold.value = threshold;

	}

	dispose() {

		this.meanBuffer.dispose();
		this.meanBufferTemp.dispose();
		this.m2Buffer.dispose();
		this.m2BufferTemp.dispose();
		this.varianceBuffer.dispose();

		this.meanUpdateMaterial.dispose();
		this.m2UpdateMaterial.dispose();
		this.varianceComputeMaterial.dispose();
		this.meanUpdateQuad.dispose();
		this.m2UpdateQuad.dispose();
		this.varianceQuad.dispose();

	}

}
