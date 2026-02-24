import { Fn, vec3, vec4, float, uv, uniform, normalize, mat3, storage } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, StorageInstancedBufferAttribute } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Matrix4 } from 'three';
import { PipelineStage, StageExecutionMode } from '../../Pipeline/PipelineStage.js';
import { Ray, HitInfo } from '../TSL/Struct.js';
import { traverseBVH } from '../TSL/BVHTraversal.js';

/**
 * NormalDepth Stage for WebGPU
 *
 * Produces a G-buffer containing surface normals and linear depth by casting
 * primary rays through the BVH. This is a lightweight pass (~1-2 ms) that
 * shares the same BVH / triangle / material storage buffers as the path tracer.
 *
 * The output is required by denoising stages (ASVGF, BilateralFiltering)
 * and by the MotionVectorStage.
 *
 * Output format (RGBA HalfFloat):
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
 *   pathtracer:normalDepth — RGBA HalfFloat G-buffer
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

		// Render target
		this.renderTarget = new RenderTarget(
			options.width || 1,
			options.height || 1,
			{
				type: HalfFloatType,
				format: RGBAFormat,
				minFilter: NearestFilter,
				magFilter: NearestFilter,
				depthBuffer: false,
				stencilBuffer: false
			}
		);

		// Own storage nodes — created lazily when data is available
		this._triStorageNode = null;
		this._bvhStorageNode = null;
		this._matStorageNode = null;

		// Material + quad — built once when storage buffers are ready
		this.material = null;
		this.quad = null;
		this._materialBuilt = false;

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
	 * but each material has its own binding (avoids the module-scope
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
		if ( pt.materialStorageAttr && ! this._matStorageNode ) {

			this._matStorageNode = storage(
				pt.materialStorageAttr, 'vec4', pt.materialStorageAttr.count
			).toReadOnly();

		} else if ( pt.materialStorageAttr && this._matStorageNode ) {

			this._matStorageNode.value = pt.materialStorageAttr;
			this._matStorageNode.bufferCount = pt.materialStorageAttr.count;

		}

		return !! ( this._triStorageNode && this._bvhStorageNode && this._matStorageNode );

	}

	// ──────────────────────────────────────────────────
	// Material (built once when buffers are ready)
	// ──────────────────────────────────────────────────

	_buildMaterial() {

		const triStorage = this._triStorageNode;
		const bvhStorage = this._bvhStorageNode;
		const matStorage = this._matStorageNode;
		const camWorld = this.cameraWorldMatrix;
		const camProjInv = this.cameraProjectionMatrixInverse;

		// Pass mat4 uniforms as Fn parameters so TSL wraps them
		// with bracket-indexing support (closure captures don't get this)
		const shader = Fn( ( [ camWorldMat, camProjInvMat ] ) => {

			// Screen UV → NDC
			const coord = uv();
			const ndcX = coord.x.mul( 2.0 ).sub( 1.0 );
			// Negate Y: in WebGPU, QuadMesh uv().y=0 at the top of the screen,
			// so raw ndcY would be -1 at top (wrong). Negation matches
			// PathTracingStage's screenCoordinate-based Y negation.
			const ndcY = coord.y.mul( 2.0 ).sub( 1.0 ).negate();
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

			return result;

		} );

		this.material = new MeshBasicNodeMaterial();
		// Use outputNode to preserve .w (linear depth) — colorNode forces alpha=1.0
		this.material.outputNode = shader( camWorld, camProjInv );
		this.material.toneMapped = false;

		this.quad = new QuadMesh( this.material );
		this._materialBuilt = true;

	}

	// ──────────────────────────────────────────────────
	// Render
	// ──────────────────────────────────────────────────

	render( context ) {

		if ( ! this.enabled ) return;

		// Sync storage buffers from path tracer
		const buffersReady = this._syncStorageBuffers();
		if ( ! buffersReady ) return;

		// Build material on first call (deferred until buffers exist)
		if ( ! this._materialBuilt ) {

			this._buildMaterial();

		}

		// Sync camera uniforms from PathTracingStage
		const pt = this.pathTracingStage;
		if ( pt ) {

			this.cameraWorldMatrix.value.copy( pt.cameraWorldMatrix.value );
			this.cameraProjectionMatrixInverse.value.copy( pt.cameraProjectionMatrixInverse.value );

		}

		// Skip if not dirty (camera hasn't moved, scene hasn't changed)
		if ( ! this._dirty && this.renderTarget.texture ) {

			// Still publish the cached texture
			context.setTexture( 'pathtracer:normalDepth', this.renderTarget.texture );
			return;

		}

		// Auto-match render target size
		const ptColor = context.getTexture( 'pathtracer:color' );
		if ( ptColor && ptColor.image ) {

			const img = ptColor.image;
			if ( img.width > 0 && img.height > 0 &&
				( img.width !== this.renderTarget.width || img.height !== this.renderTarget.height ) ) {

				this.setSize( img.width, img.height );

			}

		}

		// Render primary ray G-buffer
		this.renderer.setRenderTarget( this.renderTarget );
		this.quad.render( this.renderer );

		// Publish to context
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

		this.renderTarget.setSize( width, height );
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;
		this._dirty = true;

	}

	dispose() {

		this.material?.dispose();
		this.renderTarget?.dispose();

	}

}
