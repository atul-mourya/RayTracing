// BVH Traversal - Ported from bvhtraverse.fs
// Stack-based BVH traversal for ray-triangle intersection

import {
	Fn,
	wgslFn,
	vec3,
	vec2,
	float,
	int,
	If,
	Loop,
	Break,
	select,
	abs,
	sign,
	min,
	normalize,
	cross,
	mix,
	vec4,
	notEqual,
	lessThan,
	mat3,
	array,
} from 'three/tsl';

import { struct } from './structProxy.js';
import { Ray, HitInfo } from './Struct.js';
import { getDatafromStorageBuffer, MATERIAL_SLOTS } from './Common.js';
import { RandomPointInCircle } from './Random.js';

// ================================================================================
// STRUCTS
// ================================================================================

// Combined visibility data structure
export const VisibilityData = struct( {
	visible: 'bool',
	side: 'int',
	transparent: 'bool',
	opacity: 'float'
} );

// ================================================================================
// CONSTANTS
// ================================================================================

const MAX_STACK_DEPTH = 32;
const MAX_BVH_ITERATIONS = 512;
const BVH_STRIDE = 4;
const TRI_STRIDE = 8;
const HUGE_VAL = 1e8;

// ================================================================================
// STACK HELPERS (Native WGSL array via TSL ArrayNode)
// ================================================================================

const createStack = () => array( 'int', MAX_STACK_DEPTH ).toVar();

// ================================================================================
// RAY INTERSECTION HELPERS (inlined for BVH traversal performance)
// ================================================================================

const RayTriangleGeometry = wgslFn( `
	fn RayTriangleGeometry( rayOrigin: vec3f, rayDir: vec3f, pA: vec3f, pB: vec3f, pC: vec3f, closestHitDst: f32 ) -> vec4f {

		// Returns vec4(t, u, v, hit) where hit > 0.5 means intersection
		var result = vec4f( 1e20f, 0.0f, 0.0f, 0.0f );

		let edge1 = pB - pA;
		let edge2 = pC - pA;
		let h = cross( rayDir, edge2 );
		let a = dot( edge1, h );

		if ( abs( a ) >= 1e-8f ) {

			let f = 1.0f / a;
			let s = rayOrigin - pA;
			let u = f * dot( s, h );

			if ( u >= 0.0f && u <= 1.0f ) {

				let q = cross( s, edge1 );
				let v = f * dot( rayDir, q );

				if ( v >= 0.0f && ( u + v ) <= 1.0f ) {

					let t = f * dot( edge2, q );

					if ( t > 0.0f && t < closestHitDst ) {

						result = vec4f( t, u, v, 1.0f );

					}

				}

			}

		}

		return result;

	}
` );

const fastRayAABBDst = wgslFn( `
	fn fastRayAABBDst( rayOrigin: vec3f, invDir: vec3f, boxMin: vec3f, boxMax: vec3f ) -> f32 {

		let t1 = ( boxMin - rayOrigin ) * invDir;
		let t2 = ( boxMax - rayOrigin ) * invDir;

		let tmin = min( t1, t2 );
		let tmax = max( t1, t2 );

		let tNear = max( max( tmin.x, tmin.y ), tmin.z );
		let tFar = min( min( tmax.x, tmax.y ), tmax.z );

		let isHit = tNear <= tFar && tFar > 0.0f;
		return select( 1e20f, max( tNear, 0.0f ), isHit );

	}
` );

// ================================================================================
// VISIBILITY FUNCTIONS
// ================================================================================

// Fetch all visibility data in 2 reads
export const getVisibilityData = Fn( ( [ materialIndex, materialBuffer ] ) => {

	// Read visibility flag from slot 4
	const visData = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 4 ), int( MATERIAL_SLOTS ) );
	// Read side and transparency data from slot 10
	const sideData = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 10 ), int( MATERIAL_SLOTS ) );

	return VisibilityData( {
		visible: visData.g.greaterThan( 0.5 ),
		opacity: sideData.r,
		side: int( sideData.g ),
		transparent: sideData.b.greaterThan( 0.5 ),
	} );

} );

// Fast visibility check using material texture
export const isTriangleVisible = Fn( ( [ materialIndex, materialBuffer ] ) => {

	const visData = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 4 ), int( MATERIAL_SLOTS ) );
	return visData.g.greaterThan( 0.5 );

} );

// Complete visibility check with side culling
export const isMaterialVisibleOptimized = wgslFn( `
	fn isMaterialVisibleOptimized( visible: bool, side: i32, rayDirection: vec3f, normal: vec3f ) -> bool {
		if ( !visible ) { return false; }
		let rayDotNormal = dot( rayDirection, normal );
		let doubleSide = side == 2;
		let frontSide  = side == 0 && rayDotNormal < -0.0001f;
		let backSide   = side == 1 && rayDotNormal > 0.0001f;
		return doubleSide || frontSide || backSide;
	}
` );

// Single visibility check with combined data fetch
export const isMaterialVisible = Fn( ( [ materialIndex, rayDirection, normal, materialBuffer ] ) => {

	const vis = VisibilityData.wrap( getVisibilityData( materialIndex, materialBuffer ) );
	return isMaterialVisibleOptimized( { visible: vis.visible, side: vis.side, rayDirection, normal } );

} );

// ================================================================================
// MAIN BVH TRAVERSAL
// ================================================================================

export const traverseBVH = Fn( ( [
	ray,
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
] ) => {

	const closestHit = HitInfo( {
		didHit: false,
		dst: float( 1e20 ),
		hitPoint: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		uv: vec2( 0.0 ),
		materialIndex: int( - 1 ),
		meshIndex: int( - 1 ),
		boxTests: int( 0 ),
		triTests: int( 0 ),
	} ).toVar();

	// Deferred attribute fetch: store closest triIndex + barycentrics during traversal,
	// compute hitPoint and UVs once after the loop
	const closestTriIdx = int( - 1 ).toVar();
	const closestU = float( 0.0 ).toVar();
	const closestV = float( 0.0 ).toVar();

	// Stack (native WGSL array — O(1) read/write)
	const stack = createStack();
	const stackPtr = int( 1 ).toVar();
	stack.element( int( 0 ) ).assign( int( 0 ) ); // Root node

	// Compact axis-aligned ray handling with correct sign preservation
	const dirSign = mix( vec3( 1.0 ), sign( ray.direction ), notEqual( ray.direction, vec3( 0.0 ) ) );
	const invDir = mix(
		vec3( 1.0 ).div( ray.direction ),
		vec3( HUGE_VAL ).mul( dirSign ),
		lessThan( abs( ray.direction ), vec3( 1e-8 ) )
	).toVar();

	const rayOrigin = ray.origin;
	const rayDirection = ray.direction;

	const iterCount = int( 0 ).toVar();

	Loop( stackPtr.greaterThan( int( 0 ) ).and( iterCount.lessThan( int( MAX_BVH_ITERATIONS ) ) ), () => {

		iterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const nodeIndex = stack.element( stackPtr ).toVar();

		// New layout: 4 vec4 per node
		// Leaf: vec4(0) = [triOffset, triCount, 0, -1]
		// Inner: vec4(0) = [leftMin.xyz, leftChild], vec4(1) = [leftMax.xyz, rightChild],
		//        vec4(2) = [rightMin.xyz, 0], vec4(3) = [rightMax.xyz, 0]
		const nodeData0 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 0 ), int( BVH_STRIDE ) );
		closestHit.boxTests.addAssign( 1 );

		If( nodeData0.w.lessThan( 0.0 ), () => {

			// Leaf node — triOffset and triCount packed in vec4(0).xy
			const triStart = int( nodeData0.x ).toVar();
			const triCount = int( nodeData0.y ).toVar();

			// Process triangles in leaf
			Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

				closestHit.triTests.addAssign( 1 );
				const triIndex = triStart.add( i ).toVar();

				// Fetch geometry first (3 fetches from storage buffer)
				const pA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
				const pB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
				const pC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

				const triResult = RayTriangleGeometry( { rayOrigin, rayDir: rayDirection, pA, pB, pC, closestHitDst: closestHit.dst } );

				// RayTriangleGeometry already guarantees t < closestHit.dst when w > 0.5
				If( triResult.w.greaterThan( 0.5 ), () => {

					const t = triResult.x;
					const u = triResult.y;
					const v = triResult.z;

					// Fetch normals + material data for visibility check (4 reads)
					const nA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 3 ), int( TRI_STRIDE ) ).xyz;
					const nB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 4 ), int( TRI_STRIDE ) ).xyz;
					const nC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 5 ), int( TRI_STRIDE ) ).xyz;
					const uvData2 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 7 ), int( TRI_STRIDE ) );

					const matIdx = int( uvData2.z );

					// Early material rejection
					If( isTriangleVisible( matIdx, materialBuffer ), () => {

						// Interpolate normal
						const w = float( 1.0 ).sub( u ).sub( v );
						const normal = normalize( nA.mul( w ).add( nB.mul( u ) ).add( nC.mul( v ) ) ).toVar();

						// Full material visibility check (culling etc)
						If( isMaterialVisible( matIdx, rayDirection, normal, materialBuffer ), () => {

							closestHit.didHit.assign( true );
							closestHit.dst.assign( t );
							closestHit.normal.assign( normal );
							closestHit.materialIndex.assign( matIdx );
							closestHit.meshIndex.assign( int( uvData2.w ) );

							// Defer hitPoint + UV computation to post-traversal
							closestTriIdx.assign( triIndex );
							closestU.assign( u );
							closestV.assign( v );

						} );

					} );

				} );

			} );

			// If we found a very close hit, we can terminate early
			If( closestHit.didHit.and( closestHit.dst.lessThan( 0.001 ) ), () => {

				Break();

			} );

		} ).Else( () => {

			// Inner node — child AABBs stored in this node (4 reads total, no child fetches)
			const nodeData1 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 1 ), int( BVH_STRIDE ) );
			const nodeData2 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const nodeData3 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 3 ), int( BVH_STRIDE ) );

			const leftChild = int( nodeData0.w ).toVar();
			const rightChild = int( nodeData1.w ).toVar();

			const dstA = fastRayAABBDst( { rayOrigin, invDir, boxMin: nodeData0.xyz, boxMax: nodeData1.xyz } ).toVar();
			const dstB = fastRayAABBDst( { rayOrigin, invDir, boxMin: nodeData2.xyz, boxMax: nodeData3.xyz } ).toVar();

			// Optimized early rejection
			const minDst = min( dstA, dstB );
			If( minDst.lessThan( closestHit.dst ), () => {

				// Improved node ordering with fewer conditionals
				const aCloser = dstA.lessThan( dstB );
				const nearChild = select( aCloser, leftChild, rightChild ).toVar();
				const farChild = select( aCloser, rightChild, leftChild ).toVar();
				const farDst = select( aCloser, dstB, dstA ).toVar();

				// Push far child first (processed last)
				If( farDst.lessThan( closestHit.dst ).and( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ) ), () => {

					stack.element( stackPtr ).assign( farChild );
					stackPtr.addAssign( 1 );

				} );

				// Push near child second (processed first)
				If( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ), () => {

					stack.element( stackPtr ).assign( nearChild );
					stackPtr.addAssign( 1 );

				} );

			} );

		} );

	} );

	// Deferred: compute hitPoint and UVs once for the final closest hit
	If( closestHit.didHit, () => {

		closestHit.hitPoint.assign( ray.origin.add( ray.direction.mul( closestHit.dst ) ) );

		const w = float( 1.0 ).sub( closestU ).sub( closestV );
		const uvData1 = getDatafromStorageBuffer( triangleBuffer, closestTriIdx, int( 6 ), int( TRI_STRIDE ) );
		const uvData2 = getDatafromStorageBuffer( triangleBuffer, closestTriIdx, int( 7 ), int( TRI_STRIDE ) );
		closestHit.uv.assign(
			uvData1.xy.mul( w ).add( uvData1.zw.mul( closestU ) ).add( uvData2.xy.mul( closestV ) )
		);
		closestHit.triangleIndex.assign( closestTriIdx );

	} );

	return closestHit;

} );

// ================================================================================
// SHADOW RAY TRAVERSAL (OPTIMIZED - early exit on any hit)
// ================================================================================

export const traverseBVHShadow = Fn( ( [
	ray,
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
] ) => {

	const closestHit = HitInfo( {
		didHit: false,
		dst: float( 1e20 ),
		hitPoint: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		uv: vec2( 0.0 ),
		materialIndex: int( - 1 ),
		meshIndex: int( - 1 ),
		boxTests: int( 0 ),
		triTests: int( 0 ),
	} ).toVar();

	const stack = createStack();
	const stackPtr = int( 1 ).toVar();
	stack.element( int( 0 ) ).assign( int( 0 ) );

	const dirSign = mix( vec3( 1.0 ), sign( ray.direction ), notEqual( ray.direction, vec3( 0.0 ) ) );
	const invDir = mix(
		vec3( 1.0 ).div( ray.direction ),
		vec3( HUGE_VAL ).mul( dirSign ),
		lessThan( abs( ray.direction ), vec3( 1e-8 ) )
	).toVar();

	const sIterCount = int( 0 ).toVar();

	Loop( stackPtr.greaterThan( int( 0 ) ).and( closestHit.didHit.not() ).and( sIterCount.lessThan( int( MAX_BVH_ITERATIONS ) ) ), () => {

		sIterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const nodeIndex = stack.element( stackPtr ).toVar();

		const nodeData0 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 0 ), int( BVH_STRIDE ) );

		If( nodeData0.w.lessThan( 0.0 ), () => {

			// Leaf node — triOffset and triCount packed in vec4(0).xy
			const triStart = int( nodeData0.x ).toVar();
			const triCount = int( nodeData0.y ).toVar();

			Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

				const triIndex = triStart.add( i ).toVar();

				const pA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
				const pB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
				const pC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

				const triResult = RayTriangleGeometry( { rayOrigin: ray.origin, rayDir: ray.direction, pA, pB, pC, closestHitDst: closestHit.dst } );

				If( triResult.w.greaterThan( 0.5 ), () => {

					const uvData2 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 7 ), int( TRI_STRIDE ) );
					const matIdx = int( uvData2.z );

					If( isTriangleVisible( matIdx, materialBuffer ), () => {

						closestHit.didHit.assign( true );
						closestHit.dst.assign( triResult.x );
						closestHit.materialIndex.assign( matIdx );
						closestHit.meshIndex.assign( int( uvData2.w ) );

						// Compute hit point and geometric normal -- required for transmissive
						// Fresnel in traceShadowRay (cosThetaI needs a real normal, not vec3(0))
						closestHit.hitPoint.assign( ray.origin.add( ray.direction.mul( triResult.x ) ) );
						closestHit.normal.assign( normalize( cross( pB.sub( pA ), pC.sub( pA ) ) ) );

						// Shadow ray only needs any hit — skip remaining triangles in leaf
						Break();

					} );

				} );

			} );

		} ).Else( () => {

			// Inner node — child AABBs stored in this node
			const nodeData1 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 1 ), int( BVH_STRIDE ) );
			const nodeData2 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const nodeData3 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 3 ), int( BVH_STRIDE ) );

			const leftChild = int( nodeData0.w ).toVar();
			const rightChild = int( nodeData1.w ).toVar();

			const dstA = fastRayAABBDst( { rayOrigin: ray.origin, invDir, boxMin: nodeData0.xyz, boxMax: nodeData1.xyz } ).toVar();
			const dstB = fastRayAABBDst( { rayOrigin: ray.origin, invDir, boxMin: nodeData2.xyz, boxMax: nodeData3.xyz } ).toVar();

			const minDst = min( dstA, dstB );
			If( minDst.lessThan( closestHit.dst ), () => {

				const aCloser = dstA.lessThan( dstB );
				const nearChild = select( aCloser, leftChild, rightChild ).toVar();
				const farChild = select( aCloser, rightChild, leftChild ).toVar();
				const farDst = select( aCloser, dstB, dstA ).toVar();

				If( farDst.lessThan( closestHit.dst ).and( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ) ), () => {

					stack.element( stackPtr ).assign( farChild );
					stackPtr.addAssign( 1 );

				} );

				If( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ), () => {

					stack.element( stackPtr ).assign( nearChild );
					stackPtr.addAssign( 1 );

				} );

			} );

		} );

	} );

	return closestHit;

} );

// ================================================================================
// CAMERA RAY GENERATION
// ================================================================================

export const generateRayFromCamera = Fn( ( [
	screenPosition, rngState,
	cameraWorldMatrix, cameraProjectionMatrixInverse,
	enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio
] ) => {

	// Convert screen position to NDC
	const ndcPos = vec3( screenPosition.xy, 1.0 );

	// Convert NDC to camera space
	const rayDirCS = cameraProjectionMatrixInverse.mul( vec4( ndcPos, 1.0 ) );

	// Convert to world space
	const rayDirectionWorld = normalize( mat3(
		cameraWorldMatrix[ 0 ].xyz,
		cameraWorldMatrix[ 1 ].xyz,
		cameraWorldMatrix[ 2 ].xyz
	).mul( rayDirCS.xyz.div( rayDirCS.w ) ) ).toVar();

	const rayOriginWorld = vec3( cameraWorldMatrix[ 3 ] ).toVar();

	const resultOrigin = rayOriginWorld.toVar();
	const resultDirection = rayDirectionWorld.toVar();

	// Check if DOF is disabled or conditions make it ineffective
	If( enableDOF.and( focalLength.greaterThan( 0.0 ) ).and( aperture.lessThan( 64.0 ) ).and( focusDistance.greaterThan( 0.001 ) ), () => {

		// Calculate focal point - where rays converge
		const focalPoint = rayOriginWorld.add( rayDirectionWorld.mul( focusDistance ) ).toVar();

		// Physical aperture calculation
		const effectiveAperture = focalLength.div( aperture );
		// Apply scene scale to maintain correct physical aperture size
		const apertureRadius = effectiveAperture.mul( 0.001 ).mul( sceneScale ).mul( apertureScale );

		// Generate random point on aperture disk
		const randomPoint = RandomPointInCircle( rngState );

		// Apply anamorphic squeeze — stretch horizontally for oval bokeh
		const lensX = randomPoint.x.mul( anamorphicRatio.max( 0.01 ) );
		const lensY = randomPoint.y;

		// Extract camera coordinate system directly from camera matrix
		const cameraRight = normalize( vec3( cameraWorldMatrix[ 0 ] ) );
		const cameraUp = normalize( vec3( cameraWorldMatrix[ 1 ] ) );

		// Apply aperture offset using camera's actual coordinate system
		const offset = cameraRight.mul( lensX ).add( cameraUp.mul( lensY ) ).mul( apertureRadius );

		// Calculate new ray from offset origin to focal point
		resultOrigin.assign( rayOriginWorld.add( offset ) );
		resultDirection.assign( normalize( focalPoint.sub( resultOrigin ) ) );

	} );

	return Ray( {
		origin: resultOrigin,
		direction: resultDirection,
	} );

} );
