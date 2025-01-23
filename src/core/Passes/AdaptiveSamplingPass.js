import {
	ShaderMaterial,
	RGBAFormat,
	FloatType,
	RedFormat,
	WebGLRenderTarget,
	NearestFilter,
	Vector2,
	UnsignedByteType,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';
import { DEFAULT_STATE } from '../Processor/Constants.js';

export class AdaptiveSamplingPass extends Pass {

	constructor( renderer, width, height ) {

		super();

		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.name = 'AdaptiveSamplingPass';

		this.adaptiveSamplingMin = DEFAULT_STATE.adaptiveSamplingMin;
		this.adaptiveSamplingMax = DEFAULT_STATE.adaptiveSamplingMax;
		this.adaptiveSamplingVarianceThreshold = DEFAULT_STATE.adaptiveSamplingVarianceThreshold;

		// Create the render target to store adaptive sampling data
		this.renderTarget = new WebGLRenderTarget( width, height, {
			format: RedFormat, // Only need one channel
			type: UnsignedByteType, // 8-bit integer is sufficient for 0-255
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this.material = new ShaderMaterial( {
			uniforms: {
				resolution: { value: new Vector2( width, height ) },
				previousFrameTexture: { value: null },
				accumulatedFrameTexture: { value: null },
				adaptiveSamplingMin: { value: this.adaptiveSamplingMin },
				adaptiveSamplingMax: { value: this.adaptiveSamplingMax },
				adaptiveSamplingVarianceThreshold: { value: this.adaptiveSamplingVarianceThreshold },
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
				uniform int adaptiveSamplingMin;
				uniform int adaptiveSamplingMax;
				uniform float adaptiveSamplingVarianceThreshold;
				
				void main( ) {
					vec2 texCoord = gl_FragCoord.xy / resolution;  // Same as main function
    
					vec4 previousColor = texture2D(previousFrameTexture, texCoord);
					vec4 accumulatedColor = texture2D(accumulatedFrameTexture, texCoord);

					int samples = 0;
					float variance = 0.0;
					bool allNeighborsSame = true;
					vec4 firstNeighborColor = texture2D( accumulatedFrameTexture, texCoord + vec2( - 1, - 1 ) / resolution );

					for( int x = - 1; x <= 1; x ++ ) {
						for( int y = - 1; y <= 1; y ++ ) {
							vec2 offset = vec2( x, y ) / resolution;
							vec4 neighborColor = texture2D( accumulatedFrameTexture, texCoord + offset );
							variance += distance( accumulatedColor.rgb, neighborColor.rgb );
							if( distance( firstNeighborColor.rgb, neighborColor.rgb ) > 0.001 ) {
								allNeighborsSame = false;
							}
						}
					}
					variance /= 9.0;

					if( allNeighborsSame ) {
						samples = 0;
					} else if( variance > adaptiveSamplingVarianceThreshold ) {
						samples = adaptiveSamplingMax;
					} else if( variance < adaptiveSamplingVarianceThreshold * 0.5 ) {
						samples = adaptiveSamplingMin;
					} else {
						float t = ( variance - adaptiveSamplingVarianceThreshold * 0.5 ) / ( adaptiveSamplingVarianceThreshold * 0.5 );
						samples = int( mix( float( adaptiveSamplingMin ), float( adaptiveSamplingMax ), t ) );
					}
					gl_FragColor = vec4( samples, variance, 0.0, 1.0 );
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
				maxSamples: { value: this.adaptiveSamplingMax }
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
				varying vec2 vUv;
			
				// Convert value to RGB rainbow color
				vec3 getRainbowColor(float value) {
					float normalized = clamp(value, 0.0, 1.0);
					
					// Rainbow colors
					vec3 blue    = vec3(0.0, 0.0, 1.0);    // Lowest samples
					vec3 cyan    = vec3(0.0, 1.0, 1.0);
					vec3 green   = vec3(0.0, 1.0, 0.0);
					vec3 yellow  = vec3(1.0, 1.0, 0.0);
					vec3 red     = vec3(1.0, 0.0, 0.0);    // Highest samples
					
					if(normalized == 0.0) {
						return vec3(1.0);
					} else if(normalized < 0.5) {
						return mix(blue, cyan, normalized * 4.0);
					} else if(normalized < 0.5) {
						return mix(cyan, green, (normalized - 0.25) * 4.0);
					} else if(normalized < 0.75) {
						return mix(green, yellow, (normalized - 0.5) * 4.0);
					} else {
						return mix(yellow, red, (normalized - 0.75) * 4.0);
					}
				}
			
				void main() {
					vec4 samplingData = texture2D(samplingTexture, vUv);
					float samples = samplingData.r; // Get number of samples from r channel
					
					// Normalize samples to 0-1 range
					float normalizedSamples = (samples - minSamples) / (maxSamples - minSamples);
					
					// Apply intensity and get rainbow color
					vec3 heatmapColor = getRainbowColor(normalizedSamples * heatmapIntensity);
					
					gl_FragColor = vec4(heatmapColor, 1.0);
				}
			`,
		} );
		this.heatmapQuad = new FullScreenQuad( this.heatmapMaterial );

		this.helper = RenderTargetHelper( this.renderer, this.heatmapTarget );
		this.toggleHelper( false );
		document.body.appendChild( this.helper );

	}

	toggleHelper( signal ) {

		this.helper.style.display = signal ? 'flex' : 'none';

	}


	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.renderTarget.setSize( width, height );
		this.material.uniforms.resolution.value.set( width, height );

	}

	render( renderer ) {

		if ( ! this.enabled ) return;

		if ( ! this.material.uniforms.previousFrameTexture.value || ! this.material.uniforms.accumulatedFrameTexture.value ) {

			console.warn( 'AdaptiveSamplingPass: Missing required textures' );
			return;

		}

		renderer.setRenderTarget( this.renderTarget );
		this.fsQuad.render( renderer );

		// If heatmap visualization is enabled, render it
		// this.heatmapMaterial.uniforms.samplingTexture.value = this.renderTarget.texture;
		// renderer.setRenderTarget( this.heatmapTarget );
		// this.heatmapQuad.render( renderer );
		// this.helper.update();

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

	dispose() {

		this.renderTarget.dispose();
		this.material.dispose();
		this.fsQuad.dispose();

	}

}
