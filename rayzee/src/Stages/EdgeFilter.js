import { Fn, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, dot, max, abs, mix, pow, step,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { REC709_LUMINANCE_COEFFICIENTS } from '../TSL/Common.js';

/**
 * WebGPU Edge-Aware Filtering Stage (Compute Shader).
 *
 * Geometry-guided bilateral filter (8-dir × 2-dist kernel). Edge weights
 * combine luminance, surface normal, and ray distance — see Dammertz 2010
 * "Edge-Avoiding À-Trous" for the structure. Strength decays over iterations
 * so the filter is strongest on early frames and fades as accumulation
 * converges. Single-pass; no temporal reuse.
 *
 * Reads:     pathtracer:color (or asvgf:output / bilateralFiltering:output)
 *            and pathtracer:normalDepth
 * Publishes: edgeFiltering:output
 * Mode:      PER_CYCLE
 */
export class EdgeFilter extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'EdgeAwareFiltering', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;

		// filterStrength: 0 = passthrough, 1 = fully filtered.
		// strengthDecaySpeed: per-iteration falloff toward passthrough.
		// edgeThreshold: luminance σ. phiNormal: dot(n,n) exponent. phiDepth: depth σ.
		this.filterStrength = uniform( options.filterStrength ?? 0.75 );
		this.strengthDecaySpeed = uniform( options.strengthDecaySpeed ?? 0.05 );
		this.edgeThreshold = uniform( options.edgeThreshold ?? 1.0 );
		this.phiNormal = uniform( options.phiNormal ?? 128.0 );
		this.phiDepth = uniform( options.phiDepth ?? 1.0 );
		this.iterationCount = uniform( 0.0 );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		this._iterations = 0;

		this._inputTexNode = new TextureNode();
		this._ndTexNode = new TextureNode();

		// Pre-allocate StorageTexture at max — defensive against three.js #33061
		// (TSL compute pipeline re-compile returns zeros after resize).
		const MAX_STORAGE_SIZE = 2048;
		const w = options.width || 1;
		const h = options.height || 1;

		this._outputStorageTex = new StorageTexture( MAX_STORAGE_SIZE, MAX_STORAGE_SIZE );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = NearestFilter;
		this._outputStorageTex.magFilter = NearestFilter;

		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		this.outputTarget = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._dispatchX = Math.ceil( w / 16 );
		this._dispatchY = Math.ceil( h / 16 );

		this._buildCompute();

	}

	_buildCompute() {

		const inputTex = this._inputTexNode;
		const ndTex = this._ndTexNode;
		const outputStorageTex = this._outputStorageTex;
		const filterStrength = this.filterStrength;
		const decaySpeed = this.strengthDecaySpeed;
		const threshold = this.edgeThreshold;
		const phiNormal = this.phiNormal;
		const phiDepth = this.phiDepth;
		const iterCount = this.iterationCount;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 16;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const center = textureLoad( inputTex, coord ).xyz;
				const centerLum = dot( center, REC709_LUMINANCE_COEFFICIENTS );

				// NormalDepth writes (0,0,0, 1e6) for miss rays. Decoded normal
				// (-1,-1,-1) is non-unit and explodes pow(dot, phi); use the depth
				// sentinel as a 0/1 hit flag and zero out cross-kind weights.
				const MISS_THRESHOLD = 1e5;
				const centerND = textureLoad( ndTex, coord );
				const centerNormal = centerND.xyz.mul( 2.0 ).sub( 1.0 );
				const centerDepth = centerND.w;
				const centerIsHit = step( float( MISS_THRESHOLD ), centerDepth ).oneMinus();

				const effectiveStrength = filterStrength.sub( iterCount.mul( decaySpeed ) ).clamp( 0.0, 1.0 );

				const colorSum = center.toVar();
				const weightSum = float( 1.0 ).toVar();

				const dirs = [
					[ 1, 0 ], [ 0, 1 ], [ - 1, 0 ], [ 0, - 1 ],
					[ 1, 1 ], [ - 1, 1 ], [ - 1, - 1 ], [ 1, - 1 ],
				];

				for ( const [ dx, dy ] of dirs ) {

					for ( const dist of [ 1, 2 ] ) {

						const sx = gx.add( dx * dist ).clamp( int( 0 ), int( resW ).sub( 1 ) );
						const sy = gy.add( dy * dist ).clamp( int( 0 ), int( resH ).sub( 1 ) );
						const sCoord = ivec2( sx, sy );

						const sColor = textureLoad( inputTex, sCoord ).xyz;
						const sLum = dot( sColor, REC709_LUMINANCE_COEFFICIENTS );

						const sND = textureLoad( ndTex, sCoord );
						const sNormal = sND.xyz.mul( 2.0 ).sub( 1.0 );
						const sDepth = sND.w;
						const sampleIsHit = step( float( MISS_THRESHOLD ), sDepth ).oneMinus();

						const lumW = abs( centerLum.sub( sLum ) ).div( max( threshold, float( 0.001 ) ) ).negate().exp();

						const bothHit = centerIsHit.mul( sampleIsHit );
						const bothMiss = centerIsHit.oneMinus().mul( sampleIsHit.oneMinus() );
						const sameKind = bothHit.add( bothMiss );

						// Clamp dot to [0,1] before pow — miss-ray normals decode to
						// non-unit (-1,-1,-1) with dot=3, which would saturate pow(.,phi)
						// to +inf and poison downstream via inf*0 = NaN.
						const cosTheta = dot( centerNormal, sNormal ).clamp( 0.0, 1.0 );
						const normW = pow( cosTheta, phiNormal );
						const depW = abs( centerDepth.sub( sDepth ) ).div( max( phiDepth, float( 0.001 ) ) ).negate().exp();

						// Geometric weights only meaningful for hit-vs-hit pairs.
						const geomW = mix( float( 1.0 ), normW.mul( depW ), bothHit );

						const distWeight = float( 1.0 ).div( float( dist ).add( 0.5 ) );
						const w = lumW.mul( geomW ).mul( sameKind ).mul( distWeight );

						colorSum.addAssign( sColor.mul( w ) );
						weightSum.addAssign( w );

					}

				}

				const filtered = colorSum.div( max( weightSum, float( 0.0001 ) ) );
				const finalColor = mix( center, filtered, effectiveStrength );

				// Firefly clamp on output luminance.
				const finalLum = dot( finalColor, REC709_LUMINANCE_COEFFICIENTS );
				const clampedColor = finalColor.toVar();
				If( finalLum.greaterThan( 10.0 ), () => {

					clampedColor.assign( finalColor.mul( float( 10.0 ).div( finalLum ) ) );

				} );

				textureStore(
					outputStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					vec4( clampedColor, 1.0 )
				).toWriteOnly();

			} );

		} );

		this._computeNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const inputTex = context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'bilateralFiltering:output' )
			|| context.getTexture( 'pathtracer:color' );

		const ndTex = context.getTexture( 'pathtracer:normalDepth' );

		// Without the G-buffer there's no edge guidance — pass input through
		// rather than producing a uniform blur.
		if ( ! inputTex || ! ndTex ) {

			if ( inputTex ) context.setTexture( 'edgeFiltering:output', inputTex );
			return;

		}

		if ( context.getState( 'interactionMode' ) ) {

			context.setTexture( 'edgeFiltering:output', inputTex );
			return;

		}

		const img = inputTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this.outputTarget.width ||
				img.height !== this.outputTarget.height ) {

				this.setSize( img.width, img.height );

			}

		}

		this._inputTexNode.value = inputTex;
		this._ndTexNode.value = ndTex;

		this._iterations ++;
		this.iterationCount.value = this._iterations;

		this.renderer.compute( this._computeNode );

		// Copy out of the over-allocated StorageTexture into the right-sized
		// RenderTarget; downstream stages can sample the latter.
		this._srcRegion.min.set( 0, 0 );
		this._srcRegion.max.set( this.outputTarget.width, this.outputTarget.height );
		this.renderer.copyTextureToTexture( this._outputStorageTex, this.outputTarget.texture, this._srcRegion );

		context.setTexture( 'edgeFiltering:output', this.outputTarget.texture );

	}

	setFilteringEnabled( enabled ) {

		this.enabled = enabled;

	}

	updateUniforms( params ) {

		if ( ! params ) return;
		if ( params.filterStrength !== undefined ) this.filterStrength.value = params.filterStrength;
		if ( params.strengthDecaySpeed !== undefined ) this.strengthDecaySpeed.value = params.strengthDecaySpeed;
		if ( params.edgeThreshold !== undefined ) this.edgeThreshold.value = params.edgeThreshold;
		if ( params.phiNormal !== undefined ) this.phiNormal.value = params.phiNormal;
		if ( params.phiDepth !== undefined ) this.phiDepth.value = params.phiDepth;

	}

	reset() {

		this._iterations = 0;
		this.iterationCount.value = 0;

	}

	setSize( width, height ) {

		// StorageTexture stays at its max allocation (see constructor).
		this.outputTarget.setSize( width, height );
		this.outputTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );
		this._computeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

	}

	dispose() {

		this._computeNode?.dispose();
		this._outputStorageTex?.dispose();
		this.outputTarget?.dispose();
		this._inputTexNode?.dispose();
		this._ndTexNode?.dispose();

	}

}
