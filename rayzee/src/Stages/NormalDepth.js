import { Fn, vec3, vec4, float, int, uint, uvec2, uniform, normalize, mat3, storage, If,
	textureStore, workgroupId, localId } from 'three/tsl';
import { RenderTarget, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Matrix4 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { Ray, HitInfo } from '../TSL/Struct.js';
import { traverseBVH } from '../TSL/BVHTraversal.js';

/**
 * NormalDepth — primary-ray G-buffer for SVGF gates.
 *
 * RGB = geometric world normal · 0.5 + 0.5, A = linear ray distance (sky=1e6).
 * Geometric (not shading) normals because shading normals carry sub-pixel
 * jitter that breaks the temporal gate's same-pixel-across-frames comparison.
 * The path tracer's MRT already carries shading normals for OIDN; this stage
 * is a separate, cheap, jitter-free signal for the denoiser.
 *
 * Ping-pong RenderTargets hold current/prev. On a dispatch we swap so prev
 * is last frame's geometry. On a skipped dispatch (static camera) prev
 * aliases current — without that aliasing prev would point at older data
 * while this frame's motion vector reflects zero motion → false rejection.
 *
 * Publishes: pathtracer:normalDepth, pathtracer:prevNormalDepth
 */
export class NormalDepth extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'NormalDepth', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.pathTracer = options.pathTracer;

		this._dirty = true;

		this.cameraWorldMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4(), 'mat4' );
		this.resolutionWidth = uniform( options.width || 1 );
		this.resolutionHeight = uniform( options.height || 1 );

		const w = options.width || 1;
		const h = options.height || 1;

		this._outputStorageTex = new StorageTexture( w, h );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = NearestFilter;
		this._outputStorageTex.magFilter = NearestFilter;

		// Ping-pong RTs share format with the StorageTexture so copyTextureToTexture works.
		const rtOpts = {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		};
		this._rtA = new RenderTarget( w, h, rtOpts );
		this._rtB = new RenderTarget( w, h, rtOpts );
		this._currentIdx = 0;
		this._hasHistory = false;

		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._triStorageNode = null;
		this._bvhStorageNode = null;
		this._lastTriAttr = null;
		this._lastBvhAttr = null;
		this._computeNode = null;
		this._computeBuilt = false;

	}

	setupEventListeners() {

		this.on( 'camera:moved', () => {

			this._dirty = true;

		} );

		this.on( 'pipeline:reset', () => {

			this._dirty = true;
			this._hasHistory = false;

		} );

	}

	_syncStorageBuffers() {

		const pt = this.pathTracer;
		if ( ! pt ) return false;

		const triSwapped = pt.triangleStorageAttr && pt.triangleStorageAttr !== this._lastTriAttr;
		const bvhSwapped = pt.bvhStorageAttr && pt.bvhStorageAttr !== this._lastBvhAttr;

		if ( triSwapped || bvhSwapped ) {

			// Buffer identity changed → compute's bind group is stale; rebuild.
			this._computeNode?.dispose?.();
			this._computeNode = null;
			this._computeBuilt = false;
			this._triStorageNode = null;
			this._bvhStorageNode = null;
			this._dirty = true;

		}

		if ( pt.triangleStorageAttr && ! this._triStorageNode ) {

			this._triStorageNode = storage(
				pt.triangleStorageAttr, 'vec4', pt.triangleStorageAttr.count
			).toReadOnly();

		}

		if ( pt.bvhStorageAttr && ! this._bvhStorageNode ) {

			this._bvhStorageNode = storage(
				pt.bvhStorageAttr, 'vec4', pt.bvhStorageAttr.count
			).toReadOnly();

		}

		this._lastTriAttr = pt.triangleStorageAttr || this._lastTriAttr;
		this._lastBvhAttr = pt.bvhStorageAttr || this._lastBvhAttr;

		return !! ( this._triStorageNode && this._bvhStorageNode );

	}

	_buildCompute() {

		const triStorage = this._triStorageNode;
		const bvhStorage = this._bvhStorageNode;
		const camWorld = this.cameraWorldMatrix;
		const camProjInv = this.cameraProjectionMatrixInverse;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;
		const outputTex = this._outputStorageTex;

		const WG_SIZE = 8;

		// mat4 uniforms as Fn parameters so TSL emits bracket indexing
		// (closure captures don't get this).
		const computeFn = Fn( ( [ camWorldMat, camProjInvMat ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				// Pixel center → NDC, Y negated for Three.js WebGPU.
				const ndcX = float( gx ).add( 0.5 ).div( resW ).mul( 2.0 ).sub( 1.0 );
				const ndcY = float( gy ).add( 0.5 ).div( resH ).mul( 2.0 ).sub( 1.0 ).negate();
				const ndcPos = vec3( ndcX, ndcY, 1.0 );

				// No jitter — deterministic per-pixel ray so the temporal gate
				// sees stable per-pixel normals across frames.
				const rayDirCS = camProjInvMat.mul( vec4( ndcPos, 1.0 ) );
				const rayDirWorld = normalize(
					mat3(
						camWorldMat[ 0 ].xyz,
						camWorldMat[ 1 ].xyz,
						camWorldMat[ 2 ].xyz
					).mul( rayDirCS.xyz.div( rayDirCS.w ) )
				);
				const rayOrigin = vec3( camWorldMat[ 3 ] );

				const ray = Ray( { origin: rayOrigin, direction: rayDirWorld } );
				const hit = HitInfo.wrap( traverseBVH( ray, bvhStorage, triStorage ) );

				const encodedNormal = hit.normal.mul( 0.5 ).add( 0.5 );
				const depth = hit.dst;

				const result = hit.didHit.select(
					vec4( encodedNormal, depth ),
					vec4( 0.0, 0.0, 0.0, float( 1e6 ) )
				);

				textureStore(
					outputTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._computeNode = computeFn( camWorld, camProjInv ).compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

		this._computeBuilt = true;

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const buffersReady = this._syncStorageBuffers();
		if ( ! buffersReady ) return;

		if ( ! this._computeBuilt ) this._buildCompute();

		const pt = this.pathTracer;
		if ( pt ) {

			this.cameraWorldMatrix.value.copy( pt.uniforms.get( 'cameraWorldMatrix' ).value );
			this.cameraProjectionMatrixInverse.value.copy( pt.uniforms.get( 'cameraProjectionMatrixInverse' ).value );

		}

		// Static camera: republish current and alias prev to current. Without
		// the alias, prev would still hold older geometry while motion vector
		// reflects zero motion → false rejection at every pixel.
		if ( ! this._dirty && this._hasHistory ) {

			const currentRT = this._currentIdx === 0 ? this._rtA : this._rtB;
			context.setTexture( 'pathtracer:normalDepth', currentRT.texture );
			context.setTexture( 'pathtracer:prevNormalDepth', currentRT.texture );
			return;

		}

		const ptColor = context.getTexture( 'pathtracer:color' );
		if ( ptColor && ptColor.image ) {

			const img = ptColor.image;
			if ( img.width > 0 && img.height > 0 &&
				( img.width !== this._rtA.width || img.height !== this._rtA.height ) ) {

				this.setSize( img.width, img.height );

			}

		}

		// Swap roles: what was current becomes prev, write into the free slot.
		if ( this._hasHistory ) this._currentIdx = 1 - this._currentIdx;
		const writeRT = this._currentIdx === 0 ? this._rtA : this._rtB;
		const prevRT = this._currentIdx === 0 ? this._rtB : this._rtA;

		this.renderer.compute( this._computeNode );
		this.renderer.copyTextureToTexture( this._outputStorageTex, writeRT.texture );

		// First dispatch: seed prev from current so ASVGF doesn't see false
		// disocclusion on frame 1.
		if ( ! this._hasHistory ) {

			this.renderer.copyTextureToTexture( this._outputStorageTex, prevRT.texture );
			this._hasHistory = true;

		}

		context.setTexture( 'pathtracer:normalDepth', writeRT.texture );
		context.setTexture( 'pathtracer:prevNormalDepth', prevRT.texture );

		this._dirty = false;

	}

	reset() {

		this._dirty = true;
		this._hasHistory = false;

	}

	setSize( width, height ) {

		this._outputStorageTex.setSize( width, height );
		this._rtA.setSize( width, height );
		this._rtB.setSize( width, height );
		this._hasHistory = false;
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		if ( this._computeNode ) {

			this._computeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

		}

		this._dirty = true;

	}

	dispose() {

		this._computeNode?.dispose();
		this._outputStorageTex?.dispose();
		this._rtA?.dispose();
		this._rtB?.dispose();

	}

}
