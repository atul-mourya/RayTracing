// BVH Traversal - Ported from bvhtraverse.fs
// Stack-based BVH traversal for ray-triangle intersection

import {
	Fn,
	vec3,
	vec2,
	float,
	int,
	bool as tslBool,
	If,
	Loop,
	Break,
	select,
	abs,
	sign,
	min,
	max,
	dot,
	normalize,
	mix,
	vec4,
	notEqual,
	lessThan,
	mat3,
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
const BVH_STRIDE = 3;
const TRI_STRIDE = 8;
const HUGE_VAL = 1e8;

// ================================================================================
// STACK HELPERS (Pure TSL - no arrays)
// ================================================================================

const createStack = () => {

	return {
		s0: int( 0 ).toVar(),
		s1: int( 0 ).toVar(),
		s2: int( 0 ).toVar(),
		s3: int( 0 ).toVar(),
		s4: int( 0 ).toVar(),
		s5: int( 0 ).toVar(),
		s6: int( 0 ).toVar(),
		s7: int( 0 ).toVar(),
		s8: int( 0 ).toVar(),
		s9: int( 0 ).toVar(),
		s10: int( 0 ).toVar(),
		s11: int( 0 ).toVar(),
		s12: int( 0 ).toVar(),
		s13: int( 0 ).toVar(),
		s14: int( 0 ).toVar(),
		s15: int( 0 ).toVar(),
		s16: int( 0 ).toVar(),
		s17: int( 0 ).toVar(),
		s18: int( 0 ).toVar(),
		s19: int( 0 ).toVar(),
		s20: int( 0 ).toVar(),
		s21: int( 0 ).toVar(),
		s22: int( 0 ).toVar(),
		s23: int( 0 ).toVar(),
		s24: int( 0 ).toVar(),
		s25: int( 0 ).toVar(),
		s26: int( 0 ).toVar(),
		s27: int( 0 ).toVar(),
		s28: int( 0 ).toVar(),
		s29: int( 0 ).toVar(),
		s30: int( 0 ).toVar(),
		s31: int( 0 ).toVar()
	};

};

const stackRead = ( stack, index ) => {

	return select( index.lessThan( int( 16 ) ),
		select( index.lessThan( int( 8 ) ),
			select( index.lessThan( int( 4 ) ),
				select( index.lessThan( int( 2 ) ),
					select( index.equal( int( 0 ) ), stack.s0, stack.s1 ),
					select( index.equal( int( 2 ) ), stack.s2, stack.s3 )
				),
				select( index.lessThan( int( 6 ) ),
					select( index.equal( int( 4 ) ), stack.s4, stack.s5 ),
					select( index.equal( int( 6 ) ), stack.s6, stack.s7 )
				)
			),
			select( index.lessThan( int( 12 ) ),
				select( index.lessThan( int( 10 ) ),
					select( index.equal( int( 8 ) ), stack.s8, stack.s9 ),
					select( index.equal( int( 10 ) ), stack.s10, stack.s11 )
				),
				select( index.lessThan( int( 14 ) ),
					select( index.equal( int( 12 ) ), stack.s12, stack.s13 ),
					select( index.equal( int( 14 ) ), stack.s14, stack.s15 )
				)
			)
		),
		select( index.lessThan( int( 24 ) ),
			select( index.lessThan( int( 20 ) ),
				select( index.lessThan( int( 18 ) ),
					select( index.equal( int( 16 ) ), stack.s16, stack.s17 ),
					select( index.equal( int( 18 ) ), stack.s18, stack.s19 )
				),
				select( index.lessThan( int( 22 ) ),
					select( index.equal( int( 20 ) ), stack.s20, stack.s21 ),
					select( index.equal( int( 22 ) ), stack.s22, stack.s23 )
				)
			),
			select( index.lessThan( int( 28 ) ),
				select( index.lessThan( int( 26 ) ),
					select( index.equal( int( 24 ) ), stack.s24, stack.s25 ),
					select( index.equal( int( 26 ) ), stack.s26, stack.s27 )
				),
				select( index.lessThan( int( 30 ) ),
					select( index.equal( int( 28 ) ), stack.s28, stack.s29 ),
					select( index.equal( int( 30 ) ), stack.s30, stack.s31 )
				)
			)
		)
	);

};

const stackWrite = ( stack, index, value ) => {

	If( index.equal( int( 0 ) ), () => {

		stack.s0.assign( value );

	} );
	If( index.equal( int( 1 ) ), () => {

		stack.s1.assign( value );

	} );
	If( index.equal( int( 2 ) ), () => {

		stack.s2.assign( value );

	} );
	If( index.equal( int( 3 ) ), () => {

		stack.s3.assign( value );

	} );
	If( index.equal( int( 4 ) ), () => {

		stack.s4.assign( value );

	} );
	If( index.equal( int( 5 ) ), () => {

		stack.s5.assign( value );

	} );
	If( index.equal( int( 6 ) ), () => {

		stack.s6.assign( value );

	} );
	If( index.equal( int( 7 ) ), () => {

		stack.s7.assign( value );

	} );
	If( index.equal( int( 8 ) ), () => {

		stack.s8.assign( value );

	} );
	If( index.equal( int( 9 ) ), () => {

		stack.s9.assign( value );

	} );
	If( index.equal( int( 10 ) ), () => {

		stack.s10.assign( value );

	} );
	If( index.equal( int( 11 ) ), () => {

		stack.s11.assign( value );

	} );
	If( index.equal( int( 12 ) ), () => {

		stack.s12.assign( value );

	} );
	If( index.equal( int( 13 ) ), () => {

		stack.s13.assign( value );

	} );
	If( index.equal( int( 14 ) ), () => {

		stack.s14.assign( value );

	} );
	If( index.equal( int( 15 ) ), () => {

		stack.s15.assign( value );

	} );
	If( index.equal( int( 16 ) ), () => {

		stack.s16.assign( value );

	} );
	If( index.equal( int( 17 ) ), () => {

		stack.s17.assign( value );

	} );
	If( index.equal( int( 18 ) ), () => {

		stack.s18.assign( value );

	} );
	If( index.equal( int( 19 ) ), () => {

		stack.s19.assign( value );

	} );
	If( index.equal( int( 20 ) ), () => {

		stack.s20.assign( value );

	} );
	If( index.equal( int( 21 ) ), () => {

		stack.s21.assign( value );

	} );
	If( index.equal( int( 22 ) ), () => {

		stack.s22.assign( value );

	} );
	If( index.equal( int( 23 ) ), () => {

		stack.s23.assign( value );

	} );
	If( index.equal( int( 24 ) ), () => {

		stack.s24.assign( value );

	} );
	If( index.equal( int( 25 ) ), () => {

		stack.s25.assign( value );

	} );
	If( index.equal( int( 26 ) ), () => {

		stack.s26.assign( value );

	} );
	If( index.equal( int( 27 ) ), () => {

		stack.s27.assign( value );

	} );
	If( index.equal( int( 28 ) ), () => {

		stack.s28.assign( value );

	} );
	If( index.equal( int( 29 ) ), () => {

		stack.s29.assign( value );

	} );
	If( index.equal( int( 30 ) ), () => {

		stack.s30.assign( value );

	} );
	If( index.equal( int( 31 ) ), () => {

		stack.s31.assign( value );

	} );

};

// ================================================================================
// RAY INTERSECTION HELPERS (inlined for BVH traversal performance)
// ================================================================================

const RayTriangleGeometry = Fn( ( [ rayOrigin, rayDir, pA, pB, pC, closestHitDst ] ) => {

	// Returns vec4(t, u, v, hit) where hit > 0.5 means intersection
	const result = vec4( 1e20, 0.0, 0.0, 0.0 ).toVar();

	const edge1 = pB.sub( pA );
	const edge2 = pC.sub( pA );
	const h = rayDir.cross( edge2 );
	const a = dot( edge1, h );

	If( abs( a ).greaterThanEqual( 1e-8 ), () => {

		const f = float( 1.0 ).div( a );
		const s = rayOrigin.sub( pA );
		const u = f.mul( dot( s, h ) ).toVar();

		If( u.greaterThanEqual( 0.0 ).and( u.lessThanEqual( 1.0 ) ), () => {

			const q = s.cross( edge1 );
			const v = f.mul( dot( rayDir, q ) ).toVar();

			If( v.greaterThanEqual( 0.0 ).and( u.add( v ).lessThanEqual( 1.0 ) ), () => {

				const t = f.mul( dot( edge2, q ) ).toVar();

				If( t.greaterThan( 0.0 ).and( t.lessThan( closestHitDst ) ), () => {

					result.assign( vec4( t, u, v, 1.0 ) );

				} );

			} );

		} );

	} );

	return result;

} );

const fastRayAABBDst = Fn( ( [ rayOrigin, invDir, boxMin, boxMax ] ) => {

	const t1 = boxMin.sub( rayOrigin ).mul( invDir );
	const t2 = boxMax.sub( rayOrigin ).mul( invDir );

	const tmin = min( t1, t2 );
	const tmax = max( t1, t2 );

	const tNear = max( max( tmin.x, tmin.y ), tmin.z );
	const tFar = min( min( tmax.x, tmax.y ), tmax.z );

	const isHit = tNear.lessThanEqual( tFar ).and( tFar.greaterThan( 0.0 ) );
	return select( isHit, max( tNear, float( 0.0 ) ), float( 1e20 ) );

} );

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
export const isTriangleVisibleCached = Fn( ( [ materialIndex, materialBuffer ] ) => {

	const visData = getDatafromStorageBuffer( materialBuffer, materialIndex, int( 4 ), int( MATERIAL_SLOTS ) );
	return visData.g.greaterThan( 0.5 );

} );

// Complete visibility check with side culling
export const isMaterialVisibleOptimized = Fn( ( [ vis, rayDirection, normal ] ) => {

	const result = tslBool( false ).toVar();

	If( vis.visible, () => {

		const rayDotNormal = dot( rayDirection, normal );
		// DoubleSide (2) or FrontSide (0) facing or BackSide (1) facing
		const doubleSide = vis.side.equal( int( 2 ) );
		const frontSide = vis.side.equal( int( 0 ) ).and( rayDotNormal.lessThan( - 0.0001 ) );
		const backSide = vis.side.equal( int( 1 ) ).and( rayDotNormal.greaterThan( 0.0001 ) );
		result.assign( doubleSide.or( frontSide ).or( backSide ) );

	} );

	return result;

} );

// Single visibility check with combined data fetch
export const isMaterialVisible = Fn( ( [ materialIndex, rayDirection, normal, materialBuffer ] ) => {

	const vis = VisibilityData.wrap( getVisibilityData( materialIndex, materialBuffer ) );
	return isMaterialVisibleOptimized( vis, rayDirection, normal );

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

	// Stack
	const stack = createStack();
	const stackPtr = int( 1 ).toVar();
	stack.s0.assign( int( 0 ) ); // Root node

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

	Loop( stackPtr.greaterThan( int( 0 ) ).and( iterCount.lessThan( int( 256 ) ) ), () => {

		iterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const nodeIndex = stackRead( stack, stackPtr ).toVar();

		const nodeData0 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 0 ), int( BVH_STRIDE ) );
		const nodeData1 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 1 ), int( BVH_STRIDE ) );

		const leftChild = int( nodeData0.w ).toVar();
		const rightChild = int( nodeData1.w ).toVar();
		closestHit.boxTests.addAssign( 1 );

		If( leftChild.lessThan( int( 0 ) ), () => {

			// Leaf node
			const nodeData2 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const triStart = int( nodeData2.x ).toVar();
			const triCount = int( nodeData2.y ).toVar();

			// Process triangles in leaf
			Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

				closestHit.triTests.addAssign( 1 );
				const triIndex = triStart.add( i ).toVar();

				// Fetch geometry first (3 fetches from storage buffer)
				const pA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
				const pB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
				const pC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

				const triResult = RayTriangleGeometry( rayOrigin, rayDirection, pA, pB, pC, closestHit.dst );

				If( triResult.w.greaterThan( 0.5 ), () => {

					const t = triResult.x;
					const u = triResult.y;
					const v = triResult.z;

					// Only process further if this hit is closer
					If( t.lessThan( closestHit.dst ), () => {

						// Now fetch attributes necessary for shading/visibility (5 fetches from storage buffer)
						const nA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 3 ), int( TRI_STRIDE ) ).xyz;
						const nB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 4 ), int( TRI_STRIDE ) ).xyz;
						const nC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 5 ), int( TRI_STRIDE ) ).xyz;
						const uvData1 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 6 ), int( TRI_STRIDE ) );
						const uvData2 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 7 ), int( TRI_STRIDE ) );

						const matIdx = int( uvData2.z );
						const meshIdx = int( uvData2.w );

						// Early material rejection
						If( isTriangleVisibleCached( matIdx, materialBuffer ), () => {

							// Interpolate normal
							const w = float( 1.0 ).sub( u ).sub( v );
							const normal = normalize( nA.mul( w ).add( nB.mul( u ) ).add( nC.mul( v ) ) ).toVar();

							// Full material visibility check (culling etc)
							If( isMaterialVisible( matIdx, rayDirection, normal, materialBuffer ), () => {

								closestHit.didHit.assign( true );
								closestHit.dst.assign( t );
								closestHit.hitPoint.assign( ray.origin.add( ray.direction.mul( t ) ) );
								closestHit.normal.assign( normal );
								closestHit.uv.assign(
									uvData1.xy.mul( w ).add( uvData1.zw.mul( u ) ).add( uvData2.xy.mul( v ) )
								);
								closestHit.materialIndex.assign( matIdx );
								closestHit.meshIndex.assign( meshIdx );

							} );

						} );

					} );

				} );

			} );

			// If we found a very close hit, we can terminate early
			If( closestHit.didHit.and( closestHit.dst.lessThan( 0.001 ) ), () => {

				Break();

			} );

		} ).Else( () => {

			// Read child bounds efficiently
			const leftData0 = getDatafromStorageBuffer( bvhBuffer, leftChild, int( 0 ), int( BVH_STRIDE ) );
			const leftData1 = getDatafromStorageBuffer( bvhBuffer, leftChild, int( 1 ), int( BVH_STRIDE ) );
			const rightData0 = getDatafromStorageBuffer( bvhBuffer, rightChild, int( 0 ), int( BVH_STRIDE ) );
			const rightData1 = getDatafromStorageBuffer( bvhBuffer, rightChild, int( 1 ), int( BVH_STRIDE ) );

			const dstA = fastRayAABBDst( rayOrigin, invDir, leftData0.xyz, leftData1.xyz ).toVar();
			const dstB = fastRayAABBDst( rayOrigin, invDir, rightData0.xyz, rightData1.xyz ).toVar();

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

					stackWrite( stack, stackPtr, farChild );
					stackPtr.addAssign( 1 );

				} );

				// Push near child second (processed first)
				If( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ), () => {

					stackWrite( stack, stackPtr, nearChild );
					stackPtr.addAssign( 1 );

				} );

			} );

		} );

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
	stack.s0.assign( int( 0 ) );

	const dirSign = mix( vec3( 1.0 ), sign( ray.direction ), notEqual( ray.direction, vec3( 0.0 ) ) );
	const invDir = mix(
		vec3( 1.0 ).div( ray.direction ),
		vec3( HUGE_VAL ).mul( dirSign ),
		lessThan( abs( ray.direction ), vec3( 1e-8 ) )
	).toVar();

	const sIterCount = int( 0 ).toVar();

	Loop( stackPtr.greaterThan( int( 0 ) ).and( closestHit.didHit.not() ).and( sIterCount.lessThan( int( 256 ) ) ), () => {

		sIterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const nodeIndex = stackRead( stack, stackPtr ).toVar();

		const nodeData0 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 0 ), int( BVH_STRIDE ) );
		const nodeData1 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 1 ), int( BVH_STRIDE ) );

		const leftChild = int( nodeData0.w ).toVar();
		const rightChild = int( nodeData1.w ).toVar();

		If( leftChild.lessThan( int( 0 ) ), () => {

			const nodeData2 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const triStart = int( nodeData2.x ).toVar();
			const triCount = int( nodeData2.y ).toVar();

			Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

				const triIndex = triStart.add( i ).toVar();

				const pA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
				const pB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
				const pC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

				const triResult = RayTriangleGeometry( ray.origin, ray.direction, pA, pB, pC, closestHit.dst );

				If( triResult.w.greaterThan( 0.5 ), () => {

					const uvData2 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 7 ), int( TRI_STRIDE ) );
					const matIdx = int( uvData2.z );

					If( isTriangleVisibleCached( matIdx, materialBuffer ), () => {

						closestHit.didHit.assign( true );
						closestHit.dst.assign( triResult.x );
						closestHit.materialIndex.assign( matIdx );
						closestHit.meshIndex.assign( int( uvData2.w ) );

					} );

				} );

			} );

		} ).Else( () => {

			const leftData0 = getDatafromStorageBuffer( bvhBuffer, leftChild, int( 0 ), int( BVH_STRIDE ) );
			const leftData1 = getDatafromStorageBuffer( bvhBuffer, leftChild, int( 1 ), int( BVH_STRIDE ) );
			const rightData0 = getDatafromStorageBuffer( bvhBuffer, rightChild, int( 0 ), int( BVH_STRIDE ) );
			const rightData1 = getDatafromStorageBuffer( bvhBuffer, rightChild, int( 1 ), int( BVH_STRIDE ) );

			const dstA = fastRayAABBDst( ray.origin, invDir, leftData0.xyz, leftData1.xyz ).toVar();
			const dstB = fastRayAABBDst( ray.origin, invDir, rightData0.xyz, rightData1.xyz ).toVar();

			const minDst = min( dstA, dstB );
			If( minDst.lessThan( closestHit.dst ), () => {

				const aCloser = dstA.lessThan( dstB );
				const nearChild = select( aCloser, leftChild, rightChild ).toVar();
				const farChild = select( aCloser, rightChild, leftChild ).toVar();
				const farDst = select( aCloser, dstB, dstA ).toVar();

				If( farDst.lessThan( closestHit.dst ).and( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ) ), () => {

					stackWrite( stack, stackPtr, farChild );
					stackPtr.addAssign( 1 );

				} );

				If( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ), () => {

					stackWrite( stack, stackPtr, nearChild );
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
	enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale
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

		// Extract camera coordinate system directly from camera matrix
		const cameraRight = normalize( vec3( cameraWorldMatrix[ 0 ] ) );
		const cameraUp = normalize( vec3( cameraWorldMatrix[ 1 ] ) );

		// Apply aperture offset using camera's actual coordinate system
		const offset = cameraRight.mul( randomPoint.x ).add( cameraUp.mul( randomPoint.y ) ).mul( apertureRadius );

		// Calculate new ray from offset origin to focal point
		resultOrigin.assign( rayOriginWorld.add( offset ) );
		resultDirection.assign( normalize( focalPoint.sub( resultOrigin ) ) );

	} );

	return Ray( {
		origin: resultOrigin,
		direction: resultDirection,
	} );

} );
