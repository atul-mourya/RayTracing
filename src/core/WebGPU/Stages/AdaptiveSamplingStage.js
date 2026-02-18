import { Fn, vec3, vec4, uv, uniform, texture, float, int, If } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu';
import { NearestFilter, RGBAFormat, HalfFloatType, FloatType } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';
import { DEFAULT_STATE } from '../../../Constants.js';
import RenderTargetHelper from '../../../lib/RenderTargetHelper.js';

/**
 * WebGPU Adaptive Sampling Stage
 *
 * Computes per-pixel variance from the path tracer colour output and
 * produces a guidance texture that tells the path tracer how many
 * samples each pixel needs.
 *
 * Output format (RGBA):
 *   R — normalizedSamples  (0-1, multiply by adaptiveSamplingMax)
 *   G — variance / threshold (debug / convergence weight)
 *   B — convergedFlag       (1.0 = pixel converged, skip sampling)
 *   A — 1.0
 *
 * The path tracer reads this via getRequiredSamples() in TSL/PathTracer.js.
 *
 * Execution: PER_CYCLE — only updates when a full tile cycle completes,
 * ensuring variance is computed from complete frame data.
 */
export class AdaptiveSamplingStage extends PipelineStage {

	constructor( renderer, options = {} ) {

		super( 'AdaptiveSampling', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;
		this.frameNumber = 0;
		this.delayByFrames = options.delayByFrames ?? 2;
		this.showAdaptiveSamplingHelper = false;

		// Sampling parameters
		this.adaptiveSamplingMax = uniform( options.adaptiveSamplingMax ?? DEFAULT_STATE.adaptiveSamplingMax ?? 32, 'int' );
		this.varianceThreshold = uniform( options.varianceThreshold ?? DEFAULT_STATE.adaptiveSamplingVarianceThreshold ?? 0.01 );
		this.frameNumberUniform = uniform( 0, 'int' );

		// Resolution uniforms for dynamic texel size computation
		this.resolutionWidth = uniform( options.width || 1024 );
		this.resolutionHeight = uniform( options.height || 1024 );

		// Convergence parameters
		this.minConvergenceFrames = uniform( 50 );
		this.convergenceThreshold = uniform( 0.005 );

		// Render target for guidance texture (HalfFloat — GPU-only, no CPU readback)
		this.renderTarget = new RenderTarget(
			options.width || 1,
			options.height || 1,
			{
				format: RGBAFormat,
				type: HalfFloatType,
				minFilter: NearestFilter,
				magFilter: NearestFilter,
				depthBuffer: false,
				stencilBuffer: false
			}
		);

		// Heatmap render target — FloatType for clean CPU readback via RenderTargetHelper
		this.heatmapTarget = new RenderTarget(
			options.width || 1,
			options.height || 1,
			{
				format: RGBAFormat,
				type: FloatType,
				minFilter: NearestFilter,
				magFilter: NearestFilter,
				depthBuffer: false,
				stencilBuffer: false
			}
		);

		// Input texture node — updated each frame from context
		this._colorTexNode = texture( this.renderTarget.texture ); // placeholder, swapped in render()

		// Build TSL shaders
		this._buildMaterial();
		this._buildHeatmapMaterial();

		// Floating overlay for heatmap visualization (matches WebGL pattern)
		this.helper = RenderTargetHelper( this.renderer, this.heatmapTarget, {
			width: 400,
			height: 400,
			position: 'bottom-right',
			theme: 'dark',
			title: 'Adaptive Sampling',
			autoUpdate: false
		} );
		this.helper.hide();
		document.body.appendChild( this.helper );

	}

	_buildMaterial() {

		const colorTex = this._colorTexNode;
		const threshold = this.varianceThreshold;
		const frame = this.frameNumberUniform;
		const minFrames = this.minConvergenceFrames;
		const convThreshold = this.convergenceThreshold;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;

		const shader = Fn( () => {

			const coord = uv();

			// Per-axis texel size from actual resolution uniforms
			const texelSizeX = float( 1.0 ).div( resW );
			const texelSizeY = float( 1.0 ).div( resH );

			// Accumulate mean and variance from 3x3 neighbourhood (luminance-based)
			const mean = float( 0.0 ).toVar();
			const meanSq = float( 0.0 ).toVar();
			const count = float( 0.0 ).toVar();

			// Unrolled 3x3 loop (TSL Loop is cumbersome for small fixed iterations)
			const offsets = [
				[ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ],
				[ - 1, 0 ], [ 0, 0 ], [ 1, 0 ],
				[ - 1, 1 ], [ 0, 1 ], [ 1, 1 ],
			];

			for ( const [ dx, dy ] of offsets ) {

				const offsetUV = vec4(
					coord.x.add( texelSizeX.mul( dx ) ),
					coord.y.add( texelSizeY.mul( dy ) ),
					0, 0
				);
				const sampleColor = colorTex.sample( offsetUV.xy ).xyz;
				const sLum = sampleColor.x.mul( 0.2126 )
					.add( sampleColor.y.mul( 0.7152 ) )
					.add( sampleColor.z.mul( 0.0722 ) );

				mean.addAssign( sLum );
				meanSq.addAssign( sLum.mul( sLum ) );
				count.addAssign( 1.0 );

			}

			mean.divAssign( count );
			meanSq.divAssign( count );

			// Variance = E[X^2] - E[X]^2
			const variance = meanSq.sub( mean.mul( mean ) ).max( 0.0 ).toVar();

			// Map variance to normalised sample count
			const baseRequirement = variance.div( threshold ).clamp( 0.0, 1.0 ).toVar();

			// Progressive convergence reduction after enough frames
			const convergenceWeight = float( 0.0 ).toVar();
			If( int( frame ).greaterThan( int( minFrames ) ), () => {

				// Ramp down over time
				const framesPast = float( frame ).sub( float( minFrames ) );
				convergenceWeight.assign( framesPast.div( 100.0 ).clamp( 0.0, 0.7 ) );
				baseRequirement.mulAssign( float( 1.0 ).sub( convergenceWeight ) );

			} );

			// Early-frame boost — ensure sufficient samples in first few frames
			If( int( frame ).lessThan( 5 ), () => {

				baseRequirement.assign( baseRequirement.max( 0.6 ) );

			} );

			const normalizedSamples = baseRequirement.clamp( 0.0, 1.0 );

			// Convergence detection: mark pixel as converged if variance is very low
			// and we have accumulated enough frames
			const converged = float( 0.0 ).toVar();
			If(
				variance.lessThan( convThreshold )
					.and( int( frame ).greaterThan( int( minFrames ) ) ),
				() => {

					converged.assign( 1.0 );

				}
			);

			return vec4(
				normalizedSamples,
				variance.div( threshold ).clamp( 0.0, 1.0 ), // debug: normalized variance
				converged,
				float( 1.0 )
			);

		} );

		this.material = new MeshBasicNodeMaterial();
		this.material.colorNode = shader();
		this.material.toneMapped = false;

		this.quad = new QuadMesh( this.material );

	}

	/**
	 * Build heatmap visualization material.
	 *
	 * Reads the sampling guidance texture (this.renderTarget) and maps
	 * normalizedSamples to a smooth blue→cyan→green→yellow→red gradient.
	 * Converged pixels are desaturated, brightness is modulated by variance.
	 */
	_buildHeatmapMaterial() {

		const samplingTex = texture( this.renderTarget.texture );

		const heatmapShader = Fn( () => {

			const data = samplingTex.sample( uv() );
			const t = data.x.clamp( 0.0, 1.0 ); // normalizedSamples
			const normalizedVariance = data.y;
			const converged = data.z;

			// Smooth 5-color gradient: blue → cyan → green → yellow → red
			// Per-channel linear interpolation across 4 segments:
			//   t=0.00 → (0,0,1) blue
			//   t=0.25 → (0,1,1) cyan
			//   t=0.50 → (0,1,0) green
			//   t=0.75 → (1,1,0) yellow
			//   t=1.00 → (1,0,0) red
			const r = t.sub( 0.5 ).mul( 4.0 ).clamp( 0.0, 1.0 );
			const g = t.mul( 4.0 ).clamp( 0.0, 1.0 ).sub(
				t.sub( 0.75 ).mul( 4.0 ).clamp( 0.0, 1.0 )
			);
			const b = float( 1.0 ).sub( t.sub( 0.25 ).mul( 4.0 ).clamp( 0.0, 1.0 ) );

			const color = vec3( r, g, b ).toVar();

			// Convergence: desaturate converged pixels
			If( converged.greaterThan( 0.5 ), () => {

				const gray = color.x.mul( 0.299 )
					.add( color.y.mul( 0.587 ) )
					.add( color.z.mul( 0.114 ) );
				color.assign( color.mix( vec3( gray, gray, gray ), float( 0.6 ) ) );

			} );

			// Brightness modulation from normalized variance
			const brightness = float( 0.7 ).add( normalizedVariance.mul( 0.3 ) );
			color.mulAssign( brightness );

			return vec4( color, float( 1.0 ) );

		} );

		this.heatmapMaterial = new MeshBasicNodeMaterial();
		this.heatmapMaterial.colorNode = heatmapShader();
		this.heatmapMaterial.toneMapped = false;

		this.heatmapQuad = new QuadMesh( this.heatmapMaterial );

	}

	/**
	 * Toggle heatmap overlay visibility.
	 * @param {boolean} val — show/hide
	 */
	toggleHelper( val ) {

		this.showAdaptiveSamplingHelper = val;
		val ? this.helper.show() : this.helper.hide();

	}

	render( context ) {

		if ( ! this.enabled ) return;

		// Delay a few frames to let the path tracer accumulate
		this.frameNumber ++;
		if ( this.frameNumber <= this.delayByFrames ) return;

		this.frameNumberUniform.value = this.frameNumber;

		// Get path tracer colour output from context
		const colorTexture = context.getTexture( 'pathtracer:color' );
		if ( ! colorTexture ) return;

		// Auto-match render target size to path tracer output
		const img = colorTexture.image;
		if ( img && img.width > 0 && img.height > 0 &&
			( img.width !== this.renderTarget.width || img.height !== this.renderTarget.height ) ) {

			this.setSize( img.width, img.height );

		}

		// Update input texture (no shader recompile, just swap value)
		this._colorTexNode.value = colorTexture;

		// Render variance computation to offscreen target
		this.renderer.setRenderTarget( this.renderTarget );
		this.quad.render( this.renderer );

		// Publish guidance texture for PathTracingStage to consume
		context.setTexture( 'adaptiveSampling:output', this.renderTarget.texture );

		// Render heatmap + update helper overlay if visualization enabled
		if ( this.showAdaptiveSamplingHelper ) {

			this.renderer.setRenderTarget( this.heatmapTarget );
			this.heatmapQuad.render( this.renderer );
			this.helper.update();

		}

	}

	reset() {

		this.frameNumber = 0;
		this.frameNumberUniform.value = 0;

	}

	setSize( width, height ) {

		this.renderTarget.setSize( width, height );
		this.heatmapTarget.setSize( width, height );
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

	}

	setAdaptiveSamplingMax( value ) {

		this.adaptiveSamplingMax.value = value;

	}

	setVarianceThreshold( value ) {

		this.varianceThreshold.value = value;

	}

	dispose() {

		this.material?.dispose();
		this.heatmapMaterial?.dispose();
		this.renderTarget?.dispose();
		this.heatmapTarget?.dispose();
		this.helper?.dispose();

	}

}
