import { Fn, wgslFn, uv, uniform, texture, float, int, uint, ivec2, uvec2, If,
	textureLoad, textureStore, workgroupArray, workgroupBarrier, localId, workgroupId } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { NearestFilter, LinearFilter, RGBAFormat, HalfFloatType, FloatType } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import { DEFAULT_STATE } from '../../Constants.js';
import RenderTargetHelper from '../../lib/RenderTargetHelper.js';
import { luminance } from '../TSL/Common.js';

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Map variance to normalised sample count with convergence logic.
 *
 * Returns vec4f(normalizedSamples, varianceRatio, converged, 1.0).
 */
const computeSamplingGuidance = /*@__PURE__*/ wgslFn( `
	fn computeSamplingGuidance(
		variance: f32,
		threshold: f32,
		frame: i32,
		minFrames: i32,
		convThreshold: f32
	) -> vec4f {

		var baseReq = clamp( variance / threshold, 0.0, 1.0 );

		// Progressive convergence reduction after enough frames
		if ( frame > minFrames ) {

			let framesPast = f32( frame - minFrames );
			let convergenceWeight = clamp( framesPast / 100.0, 0.0, 0.7 );
			baseReq *= 1.0 - convergenceWeight;

		}

		// Early-frame boost
		if ( frame < 5 ) {

			baseReq = max( baseReq, 0.6 );

		}

		let normalizedSamples = clamp( baseReq, 0.0, 1.0 );

		var converged = 0.0;
		if ( variance < convThreshold && frame > minFrames ) {

			converged = 1.0;

		}

		return vec4f(
			normalizedSamples,
			clamp( variance / threshold, 0.0, 1.0 ),
			converged,
			1.0
		);

	}
` );

/**
 * 5-colour heatmap gradient with convergence desaturation.
 *
 * blue (t=0) → cyan → green → yellow → red (t=1)
 */
const heatmapGradient = /*@__PURE__*/ wgslFn( `
	fn heatmapGradient( t: f32, normalizedVariance: f32, converged: f32 ) -> vec4f {

		let r = clamp( ( t - 0.5 ) * 4.0, 0.0, 1.0 );
		let g = clamp( t * 4.0, 0.0, 1.0 ) - clamp( ( t - 0.75 ) * 4.0, 0.0, 1.0 );
		let b = 1.0 - clamp( ( t - 0.25 ) * 4.0, 0.0, 1.0 );

		var color = vec3f( r, g, b );

		// Convergence: desaturate converged pixels
		if ( converged > 0.5 ) {

			let gray = color.x * 0.299 + color.y * 0.587 + color.z * 0.114;
			color = mix( color, vec3f( gray ), 0.6 );

		}

		// Brightness modulation
		color *= 0.7 + normalizedVariance * 0.3;

		return vec4f( color, 1.0 );

	}
` );

/**
 * WebGPU Adaptive Sampling Stage (Compute Shader)
 *
 * Computes per-pixel variance from the path tracer colour output and
 * produces a guidance texture that tells the path tracer how many
 * samples each pixel needs.
 *
 * Uses compute shader with workgroup shared memory for the 3×3
 * neighbourhood variance computation. Each 8×8 workgroup loads a
 * 10×10 tile into shared memory (8×8 core + 1px border), eliminating
 * redundant texture reads across neighbouring pixels.
 *
 * Algorithm:
 *   1. Cooperative tile loading → shared memory (luminance from color)
 *   2. Barrier
 *   3. Spatial variance from 3×3 shared memory neighbourhood
 *   4. Map variance → normalised sample count with convergence logic
 *   5. Write (normalizedSamples, varianceRatio, converged, 1) to StorageTexture
 *
 * Output format (RGBA HalfFloat):
 *   R — normalizedSamples  (0-1, multiply by adaptiveSamplingMax)
 *   G — variance / threshold (debug / convergence weight)
 *   B — convergedFlag       (1.0 = pixel converged, skip sampling)
 *   A — 1.0
 *
 * The path tracer reads this via getRequiredSamples() in TSL/PathTracer.js.
 *
 * Execution: PER_CYCLE — only updates when a full tile cycle completes,
 * ensuring variance is computed from complete frame data.
 *
 * Textures published:  adaptiveSampling:output
 * Textures read:       pathtracer:color
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

		// Resolution uniforms (int for compute pixel coords)
		this.resolutionWidth = uniform( options.width || 1024 );
		this.resolutionHeight = uniform( options.height || 1024 );

		// Convergence parameters
		this.minConvergenceFrames = uniform( 50 );
		this.convergenceThreshold = uniform( 0.005 );

		// StorageTexture for compute output (replaces RenderTarget)
		const w = options.width || 1;
		const h = options.height || 1;

		// LinearFilter so fragment shaders (heatmap) can sample it without hitting
		// Three.js WGSL codegen bug (textureLoad without level for StorageTextures)
		this._outputStorageTex = new StorageTexture( w, h );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = LinearFilter;
		this._outputStorageTex.magFilter = LinearFilter;

		// Heatmap render target — FloatType for clean CPU readback via RenderTargetHelper
		this.heatmapTarget = new RenderTarget( w, h, {
			format: RGBAFormat,
			type: FloatType,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Dispatch dimensions
		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		// Input texture node — updated each frame from context
		// Use regular TextureNode (not StorageTexture) as compile-time placeholder so
		// textureLoad codegen includes the required level parameter for texture_2d
		this._colorTexNode = new TextureNode();

		// Build compute + heatmap shaders
		this._buildCompute();
		this._buildHeatmapMaterial();

		// Floating overlay for heatmap visualization
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

	/**
	 * Build compute shader for 3×3 neighbourhood variance.
	 *
	 * Workgroup: [8,8,1] — 64 threads per workgroup
	 * Shared memory: 10×10 = 100 floats (luminance tile)
	 *
	 * Tile loading: 64 threads cooperatively load 100 texels.
	 *   - Threads 0-63 each load position [linearIdx] in the 10×10 tile
	 *   - Threads 0-35 also load position [64+linearIdx] for remaining 36 texels
	 *
	 * After barrier, each thread reads its 3×3 neighbourhood from
	 * shared memory (center at localId + 1) — zero redundant texture reads.
	 */
	_buildCompute() {

		const colorTex = this._colorTexNode;
		const threshold = this.varianceThreshold;
		const frame = this.frameNumberUniform;
		const minFrames = this.minConvergenceFrames;
		const convThreshold = this.convergenceThreshold;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;
		const outputTex = this._outputStorageTex;

		const TILE_W = 10; // 8 + 2 border
		const TILE_TOTAL = TILE_W * TILE_W; // 100
		const WG_SIZE = 8;
		const WG_THREADS = WG_SIZE * WG_SIZE; // 64
		const EXTRA_LOAD = TILE_TOTAL - WG_THREADS; // 36

		const sharedLum = workgroupArray( 'float', TILE_TOTAL );

		const computeFn = Fn( () => {

			const lx = localId.x;
			const ly = localId.y;
			const linearIdx = ly.mul( WG_SIZE ).add( lx );

			// Tile origin in global image coords (1px border before the core)
			const tileOriginX = int( workgroupId.x ).mul( WG_SIZE ).sub( 1 );
			const tileOriginY = int( workgroupId.y ).mul( WG_SIZE ).sub( 1 );

			// ── Cooperative tile loading ─────────────────────

			// Load #1: all 64 threads load positions 0-63
			const sx1 = linearIdx.mod( TILE_W );
			const sy1 = linearIdx.div( TILE_W );
			const gx1 = tileOriginX.add( int( sx1 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
			const gy1 = tileOriginY.add( int( sy1 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );

			const sColor1 = textureLoad( colorTex, ivec2( gx1, gy1 ) ).xyz;
			sharedLum.element( linearIdx ).assign( luminance( sColor1 ) );

			// Load #2: threads 0-35 load positions 64-99
			If( linearIdx.lessThan( uint( EXTRA_LOAD ) ), () => {

				const idx2 = linearIdx.add( uint( WG_THREADS ) );
				const sx2 = idx2.mod( TILE_W );
				const sy2 = idx2.div( TILE_W );
				const gx2 = tileOriginX.add( int( sx2 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const gy2 = tileOriginY.add( int( sy2 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );

				const sColor2 = textureLoad( colorTex, ivec2( gx2, gy2 ) ).xyz;
				sharedLum.element( idx2 ).assign( luminance( sColor2 ) );

			} );

			workgroupBarrier();

			// ── 3×3 variance from shared memory ─────────────
			// Thread (lx, ly) → shared memory center at (lx+1, ly+1)

			const mean = float( 0.0 ).toVar();
			const meanSq = float( 0.0 ).toVar();

			for ( let dy = - 1; dy <= 1; dy ++ ) {

				for ( let dx = - 1; dx <= 1; dx ++ ) {

					const sharedIdx = ly.add( 1 + dy ).mul( TILE_W ).add( lx.add( 1 + dx ) );
					const val = sharedLum.element( sharedIdx );
					mean.addAssign( val );
					meanSq.addAssign( val.mul( val ) );

				}

			}

			mean.divAssign( 9.0 );
			meanSq.divAssign( 9.0 );

			// Variance = E[X^2] - E[X]^2
			const variance = meanSq.sub( mean.mul( mean ) ).max( 0.0 );

			// ── Bounds check and output ─────────────────────

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( lx ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( ly ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const result = computeSamplingGuidance(
					variance, threshold, int( frame ), int( minFrames ), convThreshold
				);

				textureStore(
					outputTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._computeNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	/**
	 * Build heatmap visualization material.
	 *
	 * Reads the sampling guidance StorageTexture and maps
	 * normalizedSamples to a smooth blue→cyan→green→yellow→red gradient.
	 * Converged pixels are desaturated, brightness is modulated by variance.
	 */
	_buildHeatmapMaterial() {

		const samplingTex = texture( this._outputStorageTex );

		const heatmapShader = Fn( () => {

			const data = samplingTex.sample( uv() );
			return heatmapGradient( data.x.clamp( 0.0, 1.0 ), data.y, data.z );

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

		// Auto-match storage texture size to path tracer output
		const img = colorTexture.image;
		if ( img && img.width > 0 && img.height > 0 &&
			( img.width !== this._outputStorageTex.image.width ||
			  img.height !== this._outputStorageTex.image.height ) ) {

			this.setSize( img.width, img.height );

		}

		// Update input texture (no shader recompile, just swap value)
		this._colorTexNode.value = colorTexture;

		// Compute dispatch — variance computation via shared memory
		this.renderer.compute( this._computeNode );

		// Publish guidance texture for PathTracingStage to consume
		// (StorageTexture extends Texture, works as regular texture for sampling)
		context.setTexture( 'adaptiveSampling:output', this._outputStorageTex );

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

		this._outputStorageTex.setSize( width, height );
		this.heatmapTarget.setSize( width, height );
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._computeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

	}

	setAdaptiveSamplingMax( value ) {

		this.adaptiveSamplingMax.value = value;

	}

	setVarianceThreshold( value ) {

		this.varianceThreshold.value = value;

	}

	dispose() {

		this._computeNode?.dispose();
		this.heatmapMaterial?.dispose();
		this._outputStorageTex?.dispose();
		this.heatmapTarget?.dispose();
		this.helper?.dispose();

	}

}
