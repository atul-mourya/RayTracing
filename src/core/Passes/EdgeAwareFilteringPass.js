// SimplifiedAdvancedAccumulationPass.js - Focuses on edge-aware filtering rather than accumulation
import {
	ShaderMaterial,
	Vector2,
	WebGLRenderTarget,
	FloatType,
	NearestFilter,
	RGBAFormat,
	LinearSRGBColorSpace,
	ColorManagement,
	LinearToneMapping,
	ReinhardToneMapping,
	CineonToneMapping,
	AgXToneMapping,
	ACESFilmicToneMapping,
	NeutralToneMapping,
	SRGBTransfer
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export class EdgeAwareFilteringPass extends Pass {

	constructor( width, height, options = {} ) {

		super();

		this.name = 'EdgeAwareFilteringPass';
		this.width = width;
		this.height = height;

		// Configuration options - focused on filtering rather than accumulation
		this.pixelEdgeSharpness = options.pixelEdgeSharpness ?? 0.75;
		this.edgeSharpenSpeed = options.edgeSharpenSpeed ?? 0.05;
		this.useToneMapping = options.useToneMapping ?? false;
		this.edgeThreshold = options.edgeThreshold ?? 1.0;
		this.fireflyThreshold = options.fireflyThreshold ?? 10.0;
		this.filteringEnabled = options.filteringEnabled ?? true;

		// State tracking
		this.iteration = 0;
		this.timeElapsed = 0;
		this.lastResetTime = performance.now();

		// Single render target for output (no accumulation targets needed)
		const targetOptions = {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			type: FloatType,
			format: RGBAFormat,
			colorSpace: LinearSRGBColorSpace,
			depthBuffer: false,
		};

		this.outputTarget = new WebGLRenderTarget( width, height, targetOptions );

		// Edge-aware filtering shader
		this.filteringMaterial = new ShaderMaterial( {
			name: 'EdgeAwareFilteringShader',
			uniforms: {
				tInput: { value: null },
				uIteration: { value: 0.0 },
				uPixelEdgeSharpness: { value: this.pixelEdgeSharpness },
				uEdgeSharpenSpeed: { value: this.edgeSharpenSpeed },
				uEdgeThreshold: { value: this.edgeThreshold },
				uFireflyThreshold: { value: this.fireflyThreshold },
				uCameraIsMoving: { value: false },
				uSceneIsDynamic: { value: false },
				uResolution: { value: new Vector2( width, height ) },
				uTime: { value: 0.0 },
				uUseToneMapping: { value: this.useToneMapping },
				uFilteringEnabled: { value: this.filteringEnabled },
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
				precision highp sampler2D;

				uniform sampler2D tInput;
				uniform float uIteration;
				uniform float uPixelEdgeSharpness;
				uniform float uEdgeSharpenSpeed;
				uniform float uEdgeThreshold;
				uniform float uFireflyThreshold;
				uniform bool uCameraIsMoving;
				uniform bool uSceneIsDynamic;
				uniform vec2 uResolution;
				uniform float uTime;
				uniform bool uUseToneMapping;
				uniform bool uFilteringEnabled;

				#include <tonemapping_pars_fragment>

				varying vec2 vUv;

				#define TRUE 1
				#define FALSE 0

				// Additional firefly reduction for already accumulated data
				vec3 reduceFireflies(vec3 color, float threshold) {
					if (threshold <= 0.0) return color;
					
					float luminance = dot(color, vec3(0.299, 0.587, 0.114));
					if (luminance > threshold) {
						return color * (threshold / luminance);
					}
					return color;
				}

				void main() {
					vec4 inputColor = texture2D(tInput, vUv);
					
					// If filtering is disabled, just pass through (with optional firefly reduction)
					if (!uFilteringEnabled) {
						vec3 finalColor = inputColor.rgb;
						
						// Apply firefly reduction
						if (uFireflyThreshold > 0.0) {
							finalColor = reduceFireflies(finalColor, uFireflyThreshold);
						}
						
						gl_FragColor = vec4(finalColor, inputColor.a);
						return;
					}

					// 37-pixel kernel for edge-aware denoising (same as original)
					vec4 m37[37];
					
					vec2 texelSize = 1.0 / uResolution;
					vec2 coord = vUv;

					// Sample 37 pixels in roughly circular pattern
					m37[ 0] = texture2D(tInput, coord + vec2(-1, 3) * texelSize);
					m37[ 1] = texture2D(tInput, coord + vec2( 0, 3) * texelSize);
					m37[ 2] = texture2D(tInput, coord + vec2( 1, 3) * texelSize);
					m37[ 3] = texture2D(tInput, coord + vec2(-2, 2) * texelSize);
					m37[ 4] = texture2D(tInput, coord + vec2(-1, 2) * texelSize);
					m37[ 5] = texture2D(tInput, coord + vec2( 0, 2) * texelSize);
					m37[ 6] = texture2D(tInput, coord + vec2( 1, 2) * texelSize);
					m37[ 7] = texture2D(tInput, coord + vec2( 2, 2) * texelSize);
					m37[ 8] = texture2D(tInput, coord + vec2(-3, 1) * texelSize);
					m37[ 9] = texture2D(tInput, coord + vec2(-2, 1) * texelSize);
					m37[10] = texture2D(tInput, coord + vec2(-1, 1) * texelSize);
					m37[11] = texture2D(tInput, coord + vec2( 0, 1) * texelSize);
					m37[12] = texture2D(tInput, coord + vec2( 1, 1) * texelSize);
					m37[13] = texture2D(tInput, coord + vec2( 2, 1) * texelSize);
					m37[14] = texture2D(tInput, coord + vec2( 3, 1) * texelSize);
					m37[15] = texture2D(tInput, coord + vec2(-3, 0) * texelSize);
					m37[16] = texture2D(tInput, coord + vec2(-2, 0) * texelSize);
					m37[17] = texture2D(tInput, coord + vec2(-1, 0) * texelSize);
					m37[18] = texture2D(tInput, coord + vec2( 0, 0) * texelSize); // center
					m37[19] = texture2D(tInput, coord + vec2( 1, 0) * texelSize);
					m37[20] = texture2D(tInput, coord + vec2( 2, 0) * texelSize);
					m37[21] = texture2D(tInput, coord + vec2( 3, 0) * texelSize);
					m37[22] = texture2D(tInput, coord + vec2(-3,-1) * texelSize);
					m37[23] = texture2D(tInput, coord + vec2(-2,-1) * texelSize);
					m37[24] = texture2D(tInput, coord + vec2(-1,-1) * texelSize);
					m37[25] = texture2D(tInput, coord + vec2( 0,-1) * texelSize);
					m37[26] = texture2D(tInput, coord + vec2( 1,-1) * texelSize);
					m37[27] = texture2D(tInput, coord + vec2( 2,-1) * texelSize);
					m37[28] = texture2D(tInput, coord + vec2( 3,-1) * texelSize);
					m37[29] = texture2D(tInput, coord + vec2(-2,-2) * texelSize);
					m37[30] = texture2D(tInput, coord + vec2(-1,-2) * texelSize);
					m37[31] = texture2D(tInput, coord + vec2( 0,-2) * texelSize);
					m37[32] = texture2D(tInput, coord + vec2( 1,-2) * texelSize);
					m37[33] = texture2D(tInput, coord + vec2( 2,-2) * texelSize);
					m37[34] = texture2D(tInput, coord + vec2(-1,-3) * texelSize);
					m37[35] = texture2D(tInput, coord + vec2( 0,-3) * texelSize);
					m37[36] = texture2D(tInput, coord + vec2( 1,-3) * texelSize);

					vec4 centerPixel = m37[18];
					vec3 filteredPixelColor, edgePixelColor;
					float threshold = uEdgeThreshold;
					int count = 1;
					int nextToAnEdgePixel = FALSE;

					// Start with center pixel
					filteredPixelColor = centerPixel.rgb;

					// STAGE 1: Large Kernel Filtering with Directional Edge-Aware Walking
					
					// Search above
					if (m37[11].a < threshold) {
						filteredPixelColor += m37[11].rgb;
						count++; 
						if (m37[5].a < threshold) {
							filteredPixelColor += m37[5].rgb;
							count++;
							if (m37[1].a < threshold) {
								filteredPixelColor += m37[1].rgb;
								count++;
								if (m37[0].a < threshold) {
									filteredPixelColor += m37[0].rgb;
									count++; 
								}
								if (m37[2].a < threshold) {
									filteredPixelColor += m37[2].rgb;
									count++; 
								}
							}
						}		
					} else {
						nextToAnEdgePixel = TRUE;
					}

					// Search left
					if (m37[17].a < threshold) {
						filteredPixelColor += m37[17].rgb;
						count++; 
						if (m37[16].a < threshold) {
							filteredPixelColor += m37[16].rgb;
							count++;
							if (m37[15].a < threshold) {
								filteredPixelColor += m37[15].rgb;
								count++;
								if (m37[8].a < threshold) {
									filteredPixelColor += m37[8].rgb;
									count++; 
								}
								if (m37[22].a < threshold) {
									filteredPixelColor += m37[22].rgb;
									count++; 
								}
							}
						}	
					} else {
						nextToAnEdgePixel = TRUE;
					}

					// Search right
					if (m37[19].a < threshold) {
						filteredPixelColor += m37[19].rgb;
						count++; 
						if (m37[20].a < threshold) {
							filteredPixelColor += m37[20].rgb;
							count++;
							if (m37[21].a < threshold) {
								filteredPixelColor += m37[21].rgb;
								count++;
								if (m37[14].a < threshold) {
									filteredPixelColor += m37[14].rgb;
									count++; 
								}
								if (m37[28].a < threshold) {
									filteredPixelColor += m37[28].rgb;
									count++; 
								}
							}
						}		
					} else {
						nextToAnEdgePixel = TRUE;
					}

					// Search below
					if (m37[25].a < threshold) {
						filteredPixelColor += m37[25].rgb;
						count++; 
						if (m37[31].a < threshold) {
							filteredPixelColor += m37[31].rgb;
							count++;
							if (m37[35].a < threshold) {
								filteredPixelColor += m37[35].rgb;
								count++;
								if (m37[34].a < threshold) {
									filteredPixelColor += m37[34].rgb;
									count++; 
								}
								if (m37[36].a < threshold) {
									filteredPixelColor += m37[36].rgb;
									count++; 
								}
							}
						}		
					} else {
						nextToAnEdgePixel = TRUE;
					}

					// Diagonal searches (abbreviated for brevity - include all from original)
					if (m37[10].a < threshold) {
						filteredPixelColor += m37[10].rgb;
						count++; 
						if (m37[3].a < threshold) {
							filteredPixelColor += m37[3].rgb;
							count++;
						}		
						if (m37[4].a < threshold) {
							filteredPixelColor += m37[4].rgb;
							count++; 
						}
						if (m37[9].a < threshold) {
							filteredPixelColor += m37[9].rgb;
							count++; 
						}		
					}

					if (m37[12].a < threshold) {
						filteredPixelColor += m37[12].rgb;
						count++; 
						if (m37[6].a < threshold) {
							filteredPixelColor += m37[6].rgb;
							count++;
						}		
						if (m37[7].a < threshold) {
							filteredPixelColor += m37[7].rgb;
							count++; 
						}
						if (m37[13].a < threshold) {
							filteredPixelColor += m37[13].rgb;
							count++; 
						}		
					}

					if (m37[24].a < threshold) {
						filteredPixelColor += m37[24].rgb;
						count++; 
						if (m37[23].a < threshold) {
							filteredPixelColor += m37[23].rgb;
							count++;
						}		
						if (m37[29].a < threshold) {
							filteredPixelColor += m37[29].rgb;
							count++; 
						}
						if (m37[30].a < threshold) {
							filteredPixelColor += m37[30].rgb;
							count++; 
						}		
					}

					if (m37[26].a < threshold) {
						filteredPixelColor += m37[26].rgb;
						count++; 
						if (m37[27].a < threshold) {
							filteredPixelColor += m37[27].rgb;
							count++;
						}		
						if (m37[32].a < threshold) {
							filteredPixelColor += m37[32].rgb;
							count++; 
						}
						if (m37[33].a < threshold) {
							filteredPixelColor += m37[33].rgb;
							count++; 
						}		
					}

					// Average the accumulated colors from large kernel
					filteredPixelColor *= (1.0 / float(count));

					// STAGE 2: Small Kernel Edge Filtering (13 pixels for edges)
					edgePixelColor = 	       m37[ 5].rgb +
							 m37[10].rgb + m37[11].rgb + m37[12].rgb + 
					   m37[16].rgb + m37[17].rgb + m37[18].rgb + m37[19].rgb + m37[20].rgb +
							 m37[24].rgb + m37[25].rgb + m37[26].rgb +
								       m37[31].rgb;
					edgePixelColor *= 0.0769230769; // 1/13

					// Scene-Adaptive Behavior (adapted for pre-accumulated input)
					if (uSceneIsDynamic) {
						// Dynamic scenes: More aggressive real-time filtering
						if (uCameraIsMoving) {
							if (nextToAnEdgePixel == TRUE)
								filteredPixelColor = mix(edgePixelColor, centerPixel.rgb, 0.25);
						} else if (centerPixel.a == 1.0 || nextToAnEdgePixel == TRUE) {
							filteredPixelColor = mix(edgePixelColor, centerPixel.rgb, 0.5);
						}
					} else {
						// Static scenes: Progressive refinement
						if (uCameraIsMoving) {
							if (nextToAnEdgePixel == TRUE)
								filteredPixelColor = mix(edgePixelColor, centerPixel.rgb, 0.25);
						} else if (centerPixel.a == 1.0) {
							// Edge sharpening: Gradually increases edge sharpness
							float sharpeningFactor = clamp(uIteration * uEdgeSharpenSpeed, 0.0, 1.0);
							filteredPixelColor = mix(filteredPixelColor, centerPixel.rgb, sharpeningFactor);
						} else if (uIteration > 500.0 && nextToAnEdgePixel == TRUE) {
							// Advanced edge sharpening after 500+ samples
							filteredPixelColor = centerPixel.rgb;
						}
					}

					// Special handling for outdoor raymarching (alpha = 1.01)
					if (centerPixel.a == 1.01) {
						filteredPixelColor = centerPixel.rgb;
					}

					// Final Processing Pipeline
					vec3 finalColor = filteredPixelColor;

					// Apply additional firefly reduction to filtered result
					if (uFireflyThreshold > 0.0) {
						finalColor = reduceFireflies(finalColor, uFireflyThreshold);
					}

					// Apply tone mapping if enabled
					if (uUseToneMapping) {

						#ifdef LINEAR_TONE_MAPPING

							finalColor = LinearToneMapping( finalColor );

						#elif defined( REINHARD_TONE_MAPPING )

							finalColor = ReinhardToneMapping( finalColor );

						#elif defined( CINEON_TONE_MAPPING )

							finalColor = CineonToneMapping( finalColor );

						#elif defined( ACES_FILMIC_TONE_MAPPING )

							finalColor = ACESFilmicToneMapping( finalColor );

						#elif defined( AGX_TONE_MAPPING )

							finalColor = AgXToneMapping( finalColor );

						#elif defined( NEUTRAL_TONE_MAPPING )

							finalColor = NeutralToneMapping( finalColor );

						#endif

					}

					gl_FragColor = vec4(finalColor, centerPixel.a);

					// Color space conversion
					if (uUseToneMapping) {
						#ifdef SRGB_TRANSFER

							gl_FragColor = sRGBTransferOETF( gl_FragColor );

						#endif
					}
				}
			`
		} );

		this.filteringQuad = new FullScreenQuad( this.filteringMaterial );

	}

	reset( renderer ) {

		this.iteration = 0;
		this.timeElapsed = 0;
		this.lastResetTime = performance.now();

		// Clear output target
		renderer.setRenderTarget( this.outputTarget );
		renderer.clear();

		// Reset uniforms
		this.filteringMaterial.uniforms.uIteration.value = this.iteration;

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.filteringMaterial.uniforms.uResolution.value.set( width, height );
		this.outputTarget.setSize( width, height );

	}

	updateUniforms( params ) {

		const uniforms = this.filteringMaterial.uniforms;

		if ( params.cameraIsMoving !== undefined ) uniforms.uCameraIsMoving.value = params.cameraIsMoving;
		if ( params.sceneIsDynamic !== undefined ) uniforms.uSceneIsDynamic.value = params.sceneIsDynamic;
		if ( params.pixelEdgeSharpness !== undefined ) uniforms.uPixelEdgeSharpness.value = params.pixelEdgeSharpness;
		if ( params.edgeSharpenSpeed !== undefined ) uniforms.uEdgeSharpenSpeed.value = params.edgeSharpenSpeed;
		if ( params.edgeThreshold !== undefined ) uniforms.uEdgeThreshold.value = params.edgeThreshold;
		if ( params.fireflyThreshold !== undefined ) uniforms.uFireflyThreshold.value = params.fireflyThreshold;
		if ( params.time !== undefined ) uniforms.uTime.value = params.time;
		if ( params.useToneMapping !== undefined ) uniforms.uUseToneMapping.value = params.useToneMapping;
		if ( params.filteringEnabled !== undefined ) uniforms.uFilteringEnabled.value = params.filteringEnabled;

	}

	setFilteringEnabled( enabled ) {

		this.filteringEnabled = enabled;
		this.filteringMaterial.uniforms.uFilteringEnabled.value = enabled;

	}

	render( renderer, writeBuffer, readBuffer ) {

		if ( ! this.enabled ) {

			// Just copy input to output if disabled
			renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
			renderer.clear();
			return;

		}

		// Increment iteration counter for edge sharpening progression
		this.iteration ++;
		const currentTime = performance.now();
		this.timeElapsed = ( currentTime - this.lastResetTime ) / 1000;

		// Rebuild defines if required
		if ( this._outputColorSpace !== renderer.outputColorSpace || this._toneMapping !== renderer.toneMapping ) {

			this._outputColorSpace = renderer.outputColorSpace;
			this._toneMapping = renderer.toneMapping;

			this.filteringMaterial.defines = {};

			if ( ColorManagement.getTransfer( this._outputColorSpace ) === SRGBTransfer ) this.filteringMaterial.defines.SRGB_TRANSFER = '';

			if ( this._toneMapping === LinearToneMapping ) this.filteringMaterial.defines.LINEAR_TONE_MAPPING = '';
			else if ( this._toneMapping === ReinhardToneMapping ) this.filteringMaterial.defines.REINHARD_TONE_MAPPING = '';
			else if ( this._toneMapping === CineonToneMapping ) this.filteringMaterial.defines.CINEON_TONE_MAPPING = '';
			else if ( this._toneMapping === ACESFilmicToneMapping ) this.filteringMaterial.defines.ACES_FILMIC_TONE_MAPPING = '';
			else if ( this._toneMapping === AgXToneMapping ) this.filteringMaterial.defines.AGX_TONE_MAPPING = '';
			else if ( this._toneMapping === NeutralToneMapping ) this.filteringMaterial.defines.NEUTRAL_TONE_MAPPING = '';

			this.filteringMaterial.needsUpdate = true;

		}

		// Update uniforms
		this.filteringMaterial.uniforms.uIteration.value = this.iteration;
		this.filteringMaterial.uniforms.uTime.value = this.timeElapsed;
		this.filteringMaterial.uniforms.tInput.value = readBuffer.texture;

		// Apply edge-aware filtering
		renderer.setRenderTarget( this.renderToScreen ? null : writeBuffer );
		this.filteringQuad.render( renderer );

	}

	dispose() {

		this.filteringMaterial.dispose();
		this.filteringQuad.dispose();
		this.outputTarget.dispose();

	}

}
