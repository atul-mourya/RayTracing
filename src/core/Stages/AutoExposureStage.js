import {
	ShaderMaterial,
	NearestFilter,
	RGBAFormat,
	FloatType,
	WebGLRenderTarget,
	Vector2,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import { DEFAULT_STATE } from '../../Constants.js';

/**
 * AutoExposureStage - GPU-based automatic exposure control
 *
 * Computes geometric mean (log-average) luminance using hierarchical
 * GPU reduction, then applies asymmetric temporal smoothing for
 * natural camera-like adaptation.
 *
 * Algorithm:
 * 1. Downsample input to 64x64, computing log(luminance) per block
 * 2. Hierarchical reduction: 64->32->16->8->4->2->1
 * 3. Compute geometric mean: exp(sum(log(L)) / N)
 * 4. Temporal smoothing with asymmetric speeds
 * 5. Calculate exposure: keyValue / avgLuminance
 *
 * Execution: ALWAYS - Runs every frame during interactive navigation
 *
 * Events listened to:
 * - pipeline:reset - Resets temporal history
 * - autoexposure:updateParameters - Updates adaptation parameters
 * - autoexposure:toggle - Enable/disable auto-exposure
 *
 * Textures read from context:
 * - edgeFiltering:output, asvgf:output, or pathtracer:color
 *
 * State published to context:
 * - autoexposure:value - Current computed exposure value
 * - autoexposure:avgLuminance - Current average luminance
 *
 * Events emitted:
 * - autoexposure:updated - Emitted when exposure changes { exposure, luminance }
 */
export class AutoExposureStage extends PipelineStage {

	constructor( options = {} ) {

		super( 'AutoExposure', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = options.renderer || null;
		this.width = options.width || 1920;
		this.height = options.height || 1080;

		// Auto-exposure parameters
		this.params = {
			enabled: options.enabled ?? DEFAULT_STATE.autoExposure,

			// Key value (target middle gray)
			keyValue: options.keyValue ?? DEFAULT_STATE.autoExposureKeyValue,

			// Exposure limits
			minExposure: options.minExposure ?? DEFAULT_STATE.autoExposureMinExposure,
			maxExposure: options.maxExposure ?? DEFAULT_STATE.autoExposureMaxExposure,

			// Temporal adaptation speeds (per second)
			adaptSpeedBright: options.adaptSpeedBright ?? DEFAULT_STATE.autoExposureAdaptSpeedBright,
			adaptSpeedDark: options.adaptSpeedDark ?? DEFAULT_STATE.autoExposureAdaptSpeedDark,

			// Epsilon to prevent log(0)
			epsilon: options.epsilon ?? 0.0001,

			// Initial exposure
			initialExposure: options.initialExposure ?? 1.0,
		};

		// Reduction target size (power of 2)
		this.reductionSize = 64;
		this.reductionLevels = Math.log2( this.reductionSize ); // 6 levels

		// State - current values applied this frame
		this.currentExposure = this.params.initialExposure;
		this.currentLuminance = 0.18;
		this.targetExposure = this.params.initialExposure;
		this.lastTime = performance.now();
		this.isFirstFrame = true;

		// Async readback state (frame-delayed for zero GPU stall)
		this.pendingReadback = false;
		this.readyExposure = this.params.initialExposure;
		this.readyLuminance = 0.18;
		this.readyTargetExposure = this.params.initialExposure;

		// Initialize render targets and materials
		this.initRenderTargets();
		this.initMaterials();

	}

	initRenderTargets() {

		const targetOptions = {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false
		};

		// Reduction chain: 64x64 -> 32x32 -> ... -> 1x1
		this.reductionTargets = [];
		let size = this.reductionSize;

		for ( let i = 0; i <= this.reductionLevels; i ++ ) {

			const target = new WebGLRenderTarget( size, size, targetOptions );
			target.texture.name = `AutoExposure_Reduction_${size}`;
			this.reductionTargets.push( target );
			size = Math.max( 1, size / 2 );

		}

		// Adaptation target (1x1) - stores temporal smoothed exposure
		this.adaptationTarget = new WebGLRenderTarget( 1, 1, targetOptions );
		this.adaptationTarget.texture.name = 'AutoExposure_Adaptation';

	}

	initMaterials() {

		// Downsample material (full res -> 64x64)
		// Computes log(luminance) for geometric mean calculation
		this.downsampleMaterial = new ShaderMaterial( {
			uniforms: {
				tInput: { value: null },
				resolution: { value: new Vector2( this.width, this.height ) },
				targetResolution: { value: new Vector2( this.reductionSize, this.reductionSize ) },
				epsilon: { value: this.params.epsilon }
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

				uniform sampler2D tInput;
				uniform vec2 resolution;
				uniform vec2 targetResolution;
				uniform float epsilon;

				varying vec2 vUv;

				// sRGB luminance weights
				const vec3 LUMINANCE_WEIGHTS = vec3( 0.2126, 0.7152, 0.0722 );

				void main() {
					// Calculate how many source pixels this output pixel covers
					vec2 blockSize = resolution / targetResolution;
					vec2 startUV = floor( vUv * targetResolution ) / targetResolution;

					float logLuminanceSum = 0.0;
					float validPixelCount = 0.0;

					// Sample a 4x4 grid within this block
					const int SAMPLES = 4;
					for ( int y = 0; y < SAMPLES; y++ ) {
						for ( int x = 0; x < SAMPLES; x++ ) {
							vec2 offset = vec2( float( x ) + 0.5, float( y ) + 0.5 ) / float( SAMPLES );
							vec2 sampleUV = startUV + offset * blockSize / resolution;
							sampleUV = clamp( sampleUV, 0.0, 1.0 );

							vec3 color = texture2D( tInput, sampleUV ).rgb;
							float luminance = dot( color, LUMINANCE_WEIGHTS );

							// Only count positive luminance pixels (avoid log(0))
							if ( luminance > epsilon ) {
								logLuminanceSum += log( luminance + epsilon );
								validPixelCount += 1.0;
							}
						}
					}

					// Store log luminance sum and count for later aggregation
					// R: sum of log luminances, G: count of valid pixels
					gl_FragColor = vec4( logLuminanceSum, validPixelCount, 0.0, 1.0 );
				}
			`
		} );

		// Reduction material (hierarchical 2x2 reduction)
		this.reductionMaterial = new ShaderMaterial( {
			uniforms: {
				tInput: { value: null },
				resolution: { value: new Vector2() },
				isFinalPass: { value: false }
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

				uniform sampler2D tInput;
				uniform vec2 resolution;
				uniform bool isFinalPass;

				varying vec2 vUv;

				void main() {
					vec2 texelSize = 1.0 / resolution;

					// Sample 2x2 neighborhood
					vec4 s00 = texture2D( tInput, vUv + vec2( -0.25, -0.25 ) * texelSize );
					vec4 s10 = texture2D( tInput, vUv + vec2(  0.25, -0.25 ) * texelSize );
					vec4 s01 = texture2D( tInput, vUv + vec2( -0.25,  0.25 ) * texelSize );
					vec4 s11 = texture2D( tInput, vUv + vec2(  0.25,  0.25 ) * texelSize );

					// Aggregate log luminance sums and counts
					float totalLogSum = s00.r + s10.r + s01.r + s11.r;
					float totalCount = s00.g + s10.g + s01.g + s11.g;

					if ( isFinalPass && totalCount > 0.0 ) {
						// Final pass: compute geometric mean
						float avgLogLuminance = totalLogSum / totalCount;
						float geometricMean = exp( avgLogLuminance );

						// Store geometric mean in R channel, count in G
						gl_FragColor = vec4( geometricMean, totalCount, avgLogLuminance, 1.0 );
					} else {
						gl_FragColor = vec4( totalLogSum, totalCount, 0.0, 1.0 );
					}
				}
			`
		} );

		// Adaptation material - applies temporal smoothing
		this.adaptationMaterial = new ShaderMaterial( {
			uniforms: {
				tCurrentLuminance: { value: null },
				previousExposure: { value: this.params.initialExposure },
				previousLuminance: { value: 0.18 },
				keyValue: { value: this.params.keyValue },
				minExposure: { value: this.params.minExposure },
				maxExposure: { value: this.params.maxExposure },
				adaptSpeedBright: { value: this.params.adaptSpeedBright },
				adaptSpeedDark: { value: this.params.adaptSpeedDark },
				deltaTime: { value: 0.016 },
				isFirstFrame: { value: true }
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

				uniform sampler2D tCurrentLuminance;
				uniform float previousExposure;
				uniform float previousLuminance;
				uniform float keyValue;
				uniform float minExposure;
				uniform float maxExposure;
				uniform float adaptSpeedBright;
				uniform float adaptSpeedDark;
				uniform float deltaTime;
				uniform bool isFirstFrame;

				varying vec2 vUv;

				void main() {
					// Read current geometric mean luminance
					vec4 lumData = texture2D( tCurrentLuminance, vec2( 0.5, 0.5 ) );
					float currentLuminance = lumData.r;

					// Calculate target exposure: exposure = keyValue / luminance
					// This maps the average scene luminance to middle gray
					float targetExposure = keyValue / max( currentLuminance, 0.001 );
					targetExposure = clamp( targetExposure, minExposure, maxExposure );

					float newExposure;

					if ( isFirstFrame ) {
						// First frame: use target directly (no smoothing)
						newExposure = targetExposure;
					} else {
						// Asymmetric temporal adaptation
						// Faster when going from dark to light (decreasing exposure)
						float adaptSpeed;
						if ( targetExposure < previousExposure ) {
							// Scene getting brighter -> decrease exposure faster
							adaptSpeed = adaptSpeedBright;
						} else {
							// Scene getting darker -> increase exposure slower
							adaptSpeed = adaptSpeedDark;
						}

						// Exponential smoothing
						float alpha = 1.0 - exp( -deltaTime * adaptSpeed );
						newExposure = mix( previousExposure, targetExposure, alpha );
					}

					// Output: R = exposure, G = luminance, B = target exposure, A = 1
					gl_FragColor = vec4( newExposure, currentLuminance, targetExposure, 1.0 );
				}
			`
		} );

		// Create fullscreen quads
		this.downsampleQuad = new FullScreenQuad( this.downsampleMaterial );
		this.reductionQuad = new FullScreenQuad( this.reductionMaterial );
		this.adaptationQuad = new FullScreenQuad( this.adaptationMaterial );

	}

	/**
	 * Setup event listeners
	 */
	setupEventListeners() {

		this.on( 'pipeline:reset', () => this.reset() );

		this.on( 'autoexposure:updateParameters', ( data ) => {

			if ( data ) this.updateParameters( data );

		} );

		this.on( 'autoexposure:toggle', ( enabled ) => {

			this.enabled = enabled;
			if ( ! enabled ) {

				// When disabled, let the manual exposure take over
				// The store will handle restoring manual exposure

			}

		} );

	}

	/**
	 * Update auto-exposure parameters
	 */
	updateParameters( params ) {

		Object.assign( this.params, params );

		// Update shader uniforms
		const adaptUniforms = this.adaptationMaterial.uniforms;
		adaptUniforms.keyValue.value = this.params.keyValue;
		adaptUniforms.minExposure.value = this.params.minExposure;
		adaptUniforms.maxExposure.value = this.params.maxExposure;
		adaptUniforms.adaptSpeedBright.value = this.params.adaptSpeedBright;
		adaptUniforms.adaptSpeedDark.value = this.params.adaptSpeedDark;

		this.downsampleMaterial.uniforms.epsilon.value = this.params.epsilon;

	}

	/**
	 * Reset temporal history
	 */
	reset() {

		this.isFirstFrame = true;
		this.currentExposure = this.params.initialExposure;
		this.currentLuminance = 0.18;
		this.targetExposure = this.params.initialExposure;
		this.lastTime = performance.now();

		// Reset async readback state
		this.pendingReadback = false;
		this.readyExposure = this.params.initialExposure;
		this.readyLuminance = 0.18;
		this.readyTargetExposure = this.params.initialExposure;

	}

	/**
	 * Set render size
	 */
	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.downsampleMaterial.uniforms.resolution.value.set( width, height );

	}

	/**
	 * Main render method
	 */
	render( context ) {

		if ( ! this.enabled ) return;

		const renderer = this.renderer || context.renderer;
		if ( ! renderer ) {

			return;

		}

		// Get input texture (prefer filtered output, fall back to raw)
		const inputTexture =
			context.getTexture( 'edgeFiltering:output' ) ||
			context.getTexture( 'asvgf:output' ) ||
			context.getTexture( 'pathtracer:color' );

		if ( ! inputTexture ) return;

		// Calculate delta time
		const currentTime = performance.now();
		const deltaTime = ( currentTime - this.lastTime ) / 1000;
		this.lastTime = currentTime;

		// Store current render target
		const currentRT = renderer.getRenderTarget();

		// Phase 1: Downsample to 64x64 with log(luminance) computation
		this.downsampleMaterial.uniforms.tInput.value = inputTexture;
		renderer.setRenderTarget( this.reductionTargets[ 0 ] );
		this.downsampleQuad.render( renderer );

		// Phase 2: Hierarchical reduction (64->32->16->8->4->2->1)
		for ( let i = 0; i < this.reductionLevels; i ++ ) {

			const sourceTarget = this.reductionTargets[ i ];
			const destTarget = this.reductionTargets[ i + 1 ];
			const isFinal = ( i === this.reductionLevels - 1 );

			this.reductionMaterial.uniforms.tInput.value = sourceTarget.texture;
			this.reductionMaterial.uniforms.resolution.value.set(
				sourceTarget.width, sourceTarget.height
			);
			this.reductionMaterial.uniforms.isFinalPass.value = isFinal;

			renderer.setRenderTarget( destTarget );
			this.reductionQuad.render( renderer );

		}

		// Phase 3: Temporal adaptation
		const finalReduction = this.reductionTargets[ this.reductionTargets.length - 1 ];

		this.adaptationMaterial.uniforms.tCurrentLuminance.value = finalReduction.texture;
		this.adaptationMaterial.uniforms.previousExposure.value = this.currentExposure;
		this.adaptationMaterial.uniforms.previousLuminance.value = this.currentLuminance;
		this.adaptationMaterial.uniforms.deltaTime.value = this.isFirstFrame ? 1.0 : deltaTime;
		this.adaptationMaterial.uniforms.isFirstFrame.value = this.isFirstFrame;

		renderer.setRenderTarget( this.adaptationTarget );
		this.adaptationQuad.render( renderer );

		// Restore render target before async operations
		renderer.setRenderTarget( currentRT );

		// Apply previous frame's ready values immediately (zero stall)
		this.currentExposure = this.readyExposure;
		this.currentLuminance = this.readyLuminance;
		this.targetExposure = this.readyTargetExposure;

		// Start async readback for next frame (non-blocking)
		this.readbackExposureAsync( renderer );

		// Publish to context
		context.setState( 'autoexposure:value', this.currentExposure );
		context.setState( 'autoexposure:avgLuminance', this.currentLuminance );

		// Apply exposure to renderer
		this.applyExposure();

		// Emit event for UI/other stages
		this.emit( 'autoexposure:updated', {
			exposure: this.currentExposure,
			luminance: this.currentLuminance,
			targetExposure: this.targetExposure
		} );

		this.isFirstFrame = false;

	}

	/**
	 * Async readback - starts non-blocking GPU read, updates ready values when complete
	 * This adds 1 frame of latency but eliminates GPU pipeline stalls
	 */
	readbackExposureAsync( renderer ) {

		// Skip if a readback is already in progress
		if ( this.pendingReadback ) return;

		this.pendingReadback = true;

		// Use Three.js async readback (returns a Promise)
		renderer.readRenderTargetPixelsAsync(
			this.adaptationTarget, 0, 0, 1, 1
		).then( buffer => {

			// Buffer is a Uint8Array or Float32Array depending on render target type
			// Our target uses FloatType, so we get Float32Array-compatible data
			const floatView = new Float32Array( buffer.buffer );

			let exposure = floatView[ 0 ];
			let luminance = floatView[ 1 ];
			let targetExp = floatView[ 2 ];

			// Validate values (prevent NaN/Infinity)
			if ( ! isFinite( exposure ) || isNaN( exposure ) ) {

				exposure = this.params.initialExposure;

			}

			if ( ! isFinite( luminance ) || isNaN( luminance ) ) {

				luminance = 0.18;

			}

			if ( ! isFinite( targetExp ) || isNaN( targetExp ) ) {

				targetExp = exposure;

			}

			// Update ready values for next frame
			this.readyExposure = exposure;
			this.readyLuminance = luminance;
			this.readyTargetExposure = targetExp;

			this.pendingReadback = false;

		} ).catch( () => {

			// On error, keep previous values and allow retry
			this.pendingReadback = false;

		} );

	}

	/**
	 * Apply computed exposure to renderer
	 */
	applyExposure() {

		if ( window.pathTracerApp ) {

			window.pathTracerApp.renderer.toneMappingExposure = this.currentExposure;

		}

	}

	/**
	 * Direct access for manual override
	 */
	setExposure( value ) {

		this.currentExposure = value;
		this.applyExposure();

	}

	/**
	 * Get current exposure value
	 */
	getExposure() {

		return this.currentExposure;

	}

	/**
	 * Get current average luminance
	 */
	getLuminance() {

		return this.currentLuminance;

	}

	/**
	 * Get target exposure (before temporal smoothing)
	 */
	getTargetExposure() {

		return this.targetExposure;

	}

	/**
	 * Dispose resources
	 */
	dispose() {

		// Dispose render targets
		this.reductionTargets.forEach( target => target.dispose() );
		this.adaptationTarget.dispose();

		// Dispose materials
		this.downsampleMaterial.dispose();
		this.reductionMaterial.dispose();
		this.adaptationMaterial.dispose();

		// Dispose quads
		this.downsampleQuad.dispose();
		this.reductionQuad.dispose();
		this.adaptationQuad.dispose();

	}

}
