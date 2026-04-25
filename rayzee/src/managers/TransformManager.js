/**
 * TransformManager — Manages TransformControls for interactive object manipulation.
 *
 * Attaches a translate/rotate/scale gizmo to the selected object,
 * disables OrbitControls during drag, and triggers BVH refit on release.
 */

import { Matrix3, Scene, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EngineEvents } from '../EngineEvents.js';

export class TransformManager {

	constructor( { camera, canvas, orbitControls, app } ) {

		this._app = app;
		this._orbitControls = orbitControls;
		this._camera = camera;

		// Create TransformControls with its own scene for independent rendering
		this._controls = new TransformControls( camera, canvas );
		this._gizmoScene = new Scene();
		this._gizmoScene.add( this._controls.getHelper() );

		// State
		this._attached = null;
		this._isDragging = false;
		this._meshes = null;
		this._meshTriRanges = null;
		this._posBuffer = null;
		this._normalBuffer = null;
		this._skinnedCache = null;
		this._normalCache = null;
		this._tempVec = new Vector3();
		this._normalMatrix = new Matrix3();
		this._refitInFlight = false;
		this._baselineComputed = false;

		// Bind handlers
		this._onDraggingChanged = this._onDraggingChanged.bind( this );
		this._onObjectChange = this._onObjectChange.bind( this );

		this._controls.addEventListener( 'dragging-changed', this._onDraggingChanged );
		this._controls.addEventListener( 'objectChange', this._onObjectChange );

	}

	/**
	 * Provide mesh data from SceneProcessor after scene load.
	 * Required for position extraction during BVH refit.
	 */
	setMeshData( meshes, triangleCount ) {

		this._meshes = meshes;
		this._meshTriRanges = [];
		this._skinnedCache = [];
		this._normalCache = [];
		let offset = 0;

		for ( const mesh of meshes ) {

			const geometry = mesh.geometry;
			const positions = geometry.attributes.position;
			const indices = geometry.index ? geometry.index.array : null;
			const count = indices ? indices.length / 3 : positions.count / 3;
			const uniqueVerts = positions.count;

			this._meshTriRanges.push( { start: offset, count, uniqueVerts, indices } );
			this._skinnedCache.push( new Float32Array( uniqueVerts * 3 ) );
			this._normalCache.push( new Float32Array( uniqueVerts * 3 ) );
			offset += count;

		}

		this._posBuffer = new Float32Array( triangleCount * 9 );
		this._normalBuffer = new Float32Array( triangleCount * 9 );

	}

	/**
	 * Attach the gizmo to an object.
	 */
	attach( object ) {

		if ( this._attached === object ) return;

		this._controls.attach( object );
		this._attached = object;

	}

	/**
	 * Detach the gizmo from the current object.
	 */
	detach() {

		if ( ! this._attached ) return;

		this._controls.detach();
		this._attached = null;

	}

	/**
	 * Set transform mode: 'translate' | 'rotate' | 'scale'
	 */
	setMode( mode ) {

		this._controls.setMode( mode );
		this._app?.dispatchEvent( { type: EngineEvents.TRANSFORM_MODE_CHANGED, mode } );

	}

	/**
	 * Set transform space: 'world' | 'local'
	 */
	setSpace( space ) {

		this._controls.setSpace( space );

	}

	/**
	 * Whether gizmo is currently being dragged.
	 */
	get isDragging() {

		return this._isDragging;

	}

	/**
	 * The currently attached object (or null).
	 */
	get attachedObject() {

		return this._attached;

	}

	/**
	 * The underlying TransformControls instance.
	 */
	get controls() {

		return this._controls;

	}

	/**
	 * Render the transform gizmo overlay.
	 * Call after the main pipeline render, with depth cleared.
	 */
	render( renderer ) {

		if ( ! this._attached ) return;

		const prevAutoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.clearDepth();
		renderer.setRenderTarget( null );
		renderer.render( this._gizmoScene, this._camera );
		renderer.autoClear = prevAutoClear;

	}

	// ── Event Handlers ──

	_onDraggingChanged( event ) {

		this._isDragging = event.value;

		// Disable orbit controls during gizmo drag
		if ( this._orbitControls ) {

			this._orbitControls.enabled = ! event.value;

		}

		if ( event.value ) {

			// Drag started
			this._app.dispatchEvent( { type: EngineEvents.OBJECT_TRANSFORM_START } );

		} else {

			// Drag ended — trigger final refit
			this._recomputeAndRefit();
			this._app.dispatchEvent( { type: EngineEvents.OBJECT_TRANSFORM_END } );

		}

	}

	_onObjectChange() {

		// Keep render loop alive during drag so outline updates in real-time
		this._app.needsReset = true;
		this._app.wake();

	}

	// ── Position Extraction & BVH Refit ──

	/**
	 * Recompute world-space vertex positions for affected meshes and trigger BVH refit.
	 */
	_recomputeAndRefit() {

		if ( ! this._meshes || ! this._posBuffer || this._refitInFlight ) return;
		if ( ! this._attached ) return;

		// Update world matrices for the moved object subtree
		this._attached.updateMatrixWorld( true );

		// Find which meshes are affected (the attached object or its descendants)
		const affectedIndices = this._findAffectedMeshIndices( this._attached );

		if ( affectedIndices.length === 0 ) return;

		// On first transform or after scene reload, compute ALL positions as baseline
		if ( ! this._baselineComputed ) {

			this._computeAllPositions();
			this._baselineComputed = true;

		} else {

			// Recompute only affected meshes
			for ( const idx of affectedIndices ) {

				this._computeMeshPositions( idx );

			}

		}

		this._refitInFlight = true;

		try {

			// Use per-BLAS refit for affected meshes only (faster than full BVH refit)
			this._app.refitBLASes( affectedIndices, this._posBuffer, this._normalBuffer );

		} catch ( err ) {

			console.error( 'Transform refit error:', err );

		} finally {

			this._refitInFlight = false;

		}

	}

	/**
	 * Find indices in _meshes that are the attached object or descendants of it.
	 */
	_findAffectedMeshIndices( object ) {

		const indices = [];

		for ( let i = 0; i < this._meshes.length; i ++ ) {

			const mesh = this._meshes[ i ];
			if ( mesh === object || this._isDescendantOf( mesh, object ) ) {

				indices.push( i );

			}

		}

		return indices;

	}

	_isDescendantOf( child, parent ) {

		let current = child.parent;
		while ( current ) {

			if ( current === parent ) return true;
			current = current.parent;

		}

		return false;

	}

	/**
	 * Compute world-space positions for ALL meshes (baseline).
	 * Mirrors AnimationManager._computePositions().
	 */
	_computeAllPositions() {

		for ( let i = 0; i < this._meshes.length; i ++ ) {

			this._computeMeshPositions( i );

		}

	}

	/**
	 * Compute world-space positions and normals for a single mesh.
	 * Writes into _posBuffer and _normalBuffer at the mesh's triangle range.
	 */
	_computeMeshPositions( meshIndex ) {

		const mesh = this._meshes[ meshIndex ];
		const { start, count, uniqueVerts, indices } = this._meshTriRanges[ meshIndex ];
		const skinned = this._skinnedCache[ meshIndex ];
		const nrmCache = this._normalCache[ meshIndex ];
		const tempVec = this._tempVec;
		const output = this._posBuffer;
		const nrmOut = this._normalBuffer;

		mesh.updateMatrixWorld( true );
		const worldMatrix = mesh.matrixWorld;

		// Normal matrix = inverse transpose of upper 3x3 of worldMatrix
		this._normalMatrix.getNormalMatrix( worldMatrix );
		const ne = this._normalMatrix.elements;

		const normalAttr = mesh.geometry.attributes.normal;

		// Phase 1: Compute world-space positions and normals for all unique vertices
		for ( let v = 0; v < uniqueVerts; v ++ ) {

			mesh.getVertexPosition( v, tempVec );
			tempVec.applyMatrix4( worldMatrix );

			skinned[ v * 3 ] = tempVec.x;
			skinned[ v * 3 + 1 ] = tempVec.y;
			skinned[ v * 3 + 2 ] = tempVec.z;

			// Transform normal by normal matrix (handles non-uniform scale)
			if ( normalAttr ) {

				const nx = normalAttr.getX( v );
				const ny = normalAttr.getY( v );
				const nz = normalAttr.getZ( v );

				nrmCache[ v * 3 ] = ne[ 0 ] * nx + ne[ 3 ] * ny + ne[ 6 ] * nz;
				nrmCache[ v * 3 + 1 ] = ne[ 1 ] * nx + ne[ 4 ] * ny + ne[ 7 ] * nz;
				nrmCache[ v * 3 + 2 ] = ne[ 2 ] * nx + ne[ 5 ] * ny + ne[ 8 ] * nz;

			}

		}

		// Phase 2: Assemble triangles (positions + normals)
		if ( indices ) {

			for ( let t = 0; t < count; t ++ ) {

				const t3 = t * 3;
				const i0 = indices[ t3 ] * 3;
				const i1 = indices[ t3 + 1 ] * 3;
				const i2 = indices[ t3 + 2 ] * 3;
				const o = ( start + t ) * 9;

				output[ o ] = skinned[ i0 ];
				output[ o + 1 ] = skinned[ i0 + 1 ];
				output[ o + 2 ] = skinned[ i0 + 2 ];
				output[ o + 3 ] = skinned[ i1 ];
				output[ o + 4 ] = skinned[ i1 + 1 ];
				output[ o + 5 ] = skinned[ i1 + 2 ];
				output[ o + 6 ] = skinned[ i2 ];
				output[ o + 7 ] = skinned[ i2 + 1 ];
				output[ o + 8 ] = skinned[ i2 + 2 ];

				nrmOut[ o ] = nrmCache[ i0 ];
				nrmOut[ o + 1 ] = nrmCache[ i0 + 1 ];
				nrmOut[ o + 2 ] = nrmCache[ i0 + 2 ];
				nrmOut[ o + 3 ] = nrmCache[ i1 ];
				nrmOut[ o + 4 ] = nrmCache[ i1 + 1 ];
				nrmOut[ o + 5 ] = nrmCache[ i1 + 2 ];
				nrmOut[ o + 6 ] = nrmCache[ i2 ];
				nrmOut[ o + 7 ] = nrmCache[ i2 + 1 ];
				nrmOut[ o + 8 ] = nrmCache[ i2 + 2 ];

			}

		} else {

			// Non-indexed: vertices are sequential triplets
			for ( let t = 0; t < count; t ++ ) {

				const v0 = ( t * 3 ) * 3;
				const v1 = ( t * 3 + 1 ) * 3;
				const v2 = ( t * 3 + 2 ) * 3;
				const o = ( start + t ) * 9;

				output[ o ] = skinned[ v0 ];
				output[ o + 1 ] = skinned[ v0 + 1 ];
				output[ o + 2 ] = skinned[ v0 + 2 ];
				output[ o + 3 ] = skinned[ v1 ];
				output[ o + 4 ] = skinned[ v1 + 1 ];
				output[ o + 5 ] = skinned[ v1 + 2 ];
				output[ o + 6 ] = skinned[ v2 ];
				output[ o + 7 ] = skinned[ v2 + 1 ];
				output[ o + 8 ] = skinned[ v2 + 2 ];

				nrmOut[ o ] = nrmCache[ v0 ];
				nrmOut[ o + 1 ] = nrmCache[ v0 + 1 ];
				nrmOut[ o + 2 ] = nrmCache[ v0 + 2 ];
				nrmOut[ o + 3 ] = nrmCache[ v1 ];
				nrmOut[ o + 4 ] = nrmCache[ v1 + 1 ];
				nrmOut[ o + 5 ] = nrmCache[ v1 + 2 ];
				nrmOut[ o + 6 ] = nrmCache[ v2 ];
				nrmOut[ o + 7 ] = nrmCache[ v2 + 1 ];
				nrmOut[ o + 8 ] = nrmCache[ v2 + 2 ];

			}

		}

	}

	dispose() {

		this._controls.removeEventListener( 'dragging-changed', this._onDraggingChanged );
		this._controls.removeEventListener( 'objectChange', this._onObjectChange );
		this.detach();
		this._gizmoScene.remove( this._controls.getHelper() );
		this._controls.dispose();

		this._meshes = null;
		this._meshTriRanges = null;
		this._posBuffer = null;
		this._normalBuffer = null;
		this._skinnedCache = null;
		this._normalCache = null;
		this._baselineComputed = false;

		// Drop back-references to the owning app and shared resources so the
		// PathTracerApp graph can be GC'd. Without this, _app pinned the entire
		// engine (verified via heap snapshot retainer chain).
		this._app = null;
		this._orbitControls = null;
		this._camera = null;
		this._controls = null;
		this._gizmoScene = null;

	}

}
