import { Fn, vec3, vec4, float, int, uint, uvec2, uniform, normalize, mat3, storage, If,
	textureStore, workgroupId, localId } from 'three/tsl';
import { RenderTarget, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Matrix4 } from 'three';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';
import { Ray, HitInfo } from '../TSL/Struct.js';
import { traverseBVH } from '../TSL/BVHTraversal.js';

/**
 * NormalDepth Stage for WebGPU (Compute Shader)
 *
 * Produces a G-buffer containing surface normals and linear depth by casting
 * primary rays through the BVH. This is a lightweight pass (~1-2 ms) that
 * shares the same BVH / triangle / material storage buffers as the path tracer.
 *
 * The output is required by denoising stages (ASVGF, BilateralFiltering)
 * and by the MotionVectorStage.
 *
 * Architecture (copy approach — proven working in PathTracingStage):
 *   1. Compute shader writes to a StorageTexture via textureStore
 *   2. After dispatch, copyTextureToTexture transfers StorageTexture → RenderTarget
 *   3. RenderTarget texture is published to context (NOT StorageTexture —
 *      cross-dispatch reads from StorageTexture return zeros in Three.js WebGPU)
 *
 * Output format (RGBA Float):
 *   RGB — world-space normal encoded as (N * 0.5 + 0.5)
 *   A   — linear depth (distance along primary ray)
 *
 * Caching: Only re-renders when the camera moves or the scene is rebuilt.
 * During static accumulation the previous result is reused.
 *
 * Execution mode: ALWAYS (but internal dirty flag skips redundant work)
 *
 * Events listened:
 *   camera:moved   — mark dirty
 *   pipeline:reset  — mark dirty
 *
 * Textures published:
 *   pathtracer:normalDepth — RGBA Float G-buffer (from RenderTarget, not StorageTexture)
 */
export class NormalDepthStage extends PipelineStage {

	/**
	 * @param {WebGPURenderer} renderer
	 * @param {Object} options
	 * @param {Object} options.pathTracingStage — reference to PathTracingStage (for shared buffers)
	 */
	constructor( renderer, options = {} ) {

		super( 'NormalDepth', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.pathTracingStage = options.pathTracingStage;

		// Dirty flag — only re-render when true
		this._dirty = true;

		// Own camera uniforms (updated from PathTracingStage values each frame)
		this.cameraWorldMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4(), 'mat4' );

		// Resolution uniforms
		this.resolutionWidth = uniform( options.width || 1 );
		this.resolutionHeight = uniform( options.height || 1 );

		const w = options.width || 1;
		const h = options.height || 1;

		// Write-only StorageTexture (compute output)
		this._outputStorageTex = new StorageTexture( w, h );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = NearestFilter;
		this._outputStorageTex.magFilter = NearestFilter;

		// Readable RenderTarget (copy destination — published to context)
		this.renderTarget = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Dispatch dimensions (8x8 workgroups)
		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		// Own storage nodes — created lazily when data is available
		this._triStorageNode = null;
		this._bvhStorageNode = null;
		this._matStorageNode = null;

		// Compute node — built once when storage buffers are ready
		this._computeNode = null;
		this._computeBuilt = false;

	}

	// ──────────────────────────────────────────────────
	// Pipeline lifecycle
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'camera:moved', () => {

			this._dirty = true;

		} );

		this.on( 'pipeline:reset', () => {

			this._dirty = true;

		} );

	}

	// ──────────────────────────────────────────────────
	// Storage buffer synchronisation
	// ──────────────────────────────────────────────────

	/**
	 * Synchronise storage buffer nodes from PathTracingStage.
	 *
	 * Creates own `storage()` nodes pointing at the same underlying
	 * StorageInstancedBufferAttribute so the GPU buffer is shared,
	 * but each compute node has its own binding (avoids the module-scope
	 * TextureNode issue that breaks MRT).
	 */
	_syncStorageBuffers() {

		const pt = this.pathTracingStage;
		if ( ! pt ) return false;

		// Triangle storage
		if ( pt.triangleStorageAttr && ! this._triStorageNode ) {

			this._triStorageNode = storage(
				pt.triangleStorageAttr, 'vec4', pt.triangleStorageAttr.count
			).toReadOnly();

		} else if ( pt.triangleStorageAttr && this._triStorageNode ) {

			// Data changed (new model loaded) — update in-place
			this._triStorageNode.value = pt.triangleStorageAttr;
			this._triStorageNode.bufferCount = pt.triangleStorageAttr.count;

		}

		// BVH storage
		if ( pt.bvhStorageAttr && ! this._bvhStorageNode ) {

			this._bvhStorageNode = storage(
				pt.bvhStorageAttr, 'vec4', pt.bvhStorageAttr.count
			).toReadOnly();

		} else if ( pt.bvhStorageAttr && this._bvhStorageNode ) {

			this._bvhStorageNode.value = pt.bvhStorageAttr;
			this._bvhStorageNode.bufferCount = pt.bvhStorageAttr.count;

		}

		// Material storage
		const matStorageAttr = pt.materialData.materialStorageAttr;
		if ( matStorageAttr && ! this._matStorageNode ) {

			this._matStorageNode = storage(
				matStorageAttr, 'vec4', matStorageAttr.count
			).toReadOnly();

		} else if ( matStorageAttr && this._matStorageNode ) {

			this._matStorageNode.value = matStorageAttr;
			this._matStorageNode.bufferCount = matStorageAttr.count;

		}

		return !! ( this._triStorageNode && this._bvhStorageNode && this._matStorageNode );

	}

	// ──────────────────────────────────────────────────
	// Compute node (built once when buffers are ready)
	// ──────────────────────────────────────────────────

	_buildCompute() {

		const triStorage = this._triStorageNode;
		const bvhStorage = this._bvhStorageNode;
		const matStorage = this._matStorageNode;
		const camWorld = this.cameraWorldMatrix;
		const camProjInv = this.cameraProjectionMatrixInverse;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;
		const outputTex = this._outputStorageTex;

		const WG_SIZE = 8;

		// Pass mat4 uniforms as Fn parameters so TSL wraps them
		// with bracket-indexing support (closure captures don't get this)
		const computeFn = Fn( ( [ camWorldMat, camProjInvMat ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				// Pixel coordinate → NDC
				// Negate Y: in WebGPU, pixel Y=0 at top of screen
				const ndcX = float( gx ).add( 0.5 ).div( resW ).mul( 2.0 ).sub( 1.0 );
				const ndcY = float( gy ).add( 0.5 ).div( resH ).mul( 2.0 ).sub( 1.0 ).negate();
				const ndcPos = vec3( ndcX, ndcY, 1.0 );

				// Camera ray (no DOF)
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

				// BVH traversal (primary ray only) — wrap result for struct field access
				const hit = HitInfo.wrap( traverseBVH( ray, bvhStorage, triStorage, matStorage ) );

				// Encode: normal * 0.5 + 0.5 in RGB, linear depth in A
				const encodedNormal = hit.normal.mul( 0.5 ).add( 0.5 );
				const depth = hit.dst;

				// Sky / miss: zero normal, large depth
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

	// ──────────────────────────────────────────────────
	// Render
	// ──────────────────────────────────────────────────

	render( context ) {

		if ( ! this.enabled ) return;

		// Sync storage buffers from path tracer
		const buffersReady = this._syncStorageBuffers();
		if ( ! buffersReady ) return;

		// Build compute node on first call (deferred until buffers exist)
		if ( ! this._computeBuilt ) {

			this._buildCompute();

		}

		// Sync camera uniforms from PathTracingStage
		const pt = this.pathTracingStage;
		if ( pt ) {

			this.cameraWorldMatrix.value.copy( pt.uniforms.get( 'cameraWorldMatrix' ).value );
			this.cameraProjectionMatrixInverse.value.copy( pt.uniforms.get( 'cameraProjectionMatrixInverse' ).value );

		}

		// Skip if not dirty (camera hasn't moved, scene hasn't changed)
		if ( ! this._dirty && this.renderTarget.texture ) {

			// Still publish the cached texture
			context.setTexture( 'pathtracer:normalDepth', this.renderTarget.texture );
			return;

		}

		// Auto-match size to path tracer output
		const ptColor = context.getTexture( 'pathtracer:color' );
		if ( ptColor && ptColor.image ) {

			const img = ptColor.image;
			if ( img.width > 0 && img.height > 0 &&
				( img.width !== this.renderTarget.width || img.height !== this.renderTarget.height ) ) {

				this.setSize( img.width, img.height );

			}

		}

		// Dispatch compute shader
		this.renderer.compute( this._computeNode );

		// Copy StorageTexture → RenderTarget (cross-dispatch reads from
		// StorageTexture return zeros — must use RenderTarget for downstream stages)
		this.renderer.copyTextureToTexture( this._outputStorageTex, this.renderTarget.texture );

		// Publish RenderTarget texture to context
		context.setTexture( 'pathtracer:normalDepth', this.renderTarget.texture );

		// Clear dirty flag — next frame will reuse cached result
		this._dirty = false;

	}

	// ──────────────────────────────────────────────────
	// Lifecycle
	// ──────────────────────────────────────────────────

	reset() {

		this._dirty = true;

	}

	setSize( width, height ) {

		this._outputStorageTex.setSize( width, height );
		this.renderTarget.setSize( width, height );
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		if ( this._computeNode ) {

			this._computeNode.setCount( [ this._dispatchX, this._dispatchY, 1 ] );

		}

		this._dirty = true;

	}

	dispose() {

		this._computeNode?.dispose();
		this._outputStorageTex?.dispose();
		this.renderTarget?.dispose();

	}

}
