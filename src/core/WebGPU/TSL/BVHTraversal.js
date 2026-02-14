/**
 * BVHTraversal_v2.js - Pure TSL BVH (Bounding Volume Hierarchy) Traversal
 *
 * Ported from bvhtraverse.fs GLSL shader.
 * Implements efficient stack-based BVH traversal for ray-triangle intersection.
 *
 * BVH Node Layout (3 vec4s = 12 floats):
 * - vec4[0]: min bound (x, y, z), leftChild (w)
 * - vec4[1]: max bound (x, y, z), rightChild (w)
 * - vec4[2]: triStart (x), triCount (y), unused (z, w)
 * - Leaf detection: leftChild < 0
 *
 * Triangle Data Layout (8 vec4s = 32 floats):
 * - vec4[0-2]: positions (pA, pB, pC)
 * - vec4[3-5]: normals (nA, nB, nC)
 * - vec4[6]: uv0 (xy), uv1 (zw)
 * - vec4[7]: uv2 (xy), materialIndex (z), meshIndex (w)
 *
 * NO wgslFn() - Pure TSL using Fn(), Loop(), If(), .toVar(), .assign()
 */

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
	texture,
	select,
	abs,
	sign,
	min,
	max,
	dot,
	normalize,
	mix,
	struct,
	vec4,
	// eslint-disable-next-line no-unused-vars
	ivec2 // Used in JSDoc type annotations
} from 'three/tsl';

import {
	Ray,
} from './Struct.js';

// ================================================================================
// STRUCTS
// ================================================================================

export const BVHIntersectionResult = struct( {
	hit: 'bool',
	t: 'float',
	triangleIndex: 'int',
	u: 'float',
	v: 'float',
	w: 'float'
} );

/**
 * Triangle intersection result struct
 * Matches the return type of rayTriangleGeometry
 */
export const TriangleHitResult = struct( {
	hit: 'bool',
	t: 'float',
	u: 'float',
	v: 'float'
} );

/**
 * Visibility data struct - mirrors GLSL VisibilityData
 * Combined visibility information for material culling
 */
export const VisibilityData = struct( {
	visible: 'bool',
	side: 'int',
	transparent: 'bool',
	opacity: 'float'
} );

// ================================================================================
// CONSTANTS
// ================================================================================

// Reduced stack depth for pure TSL (individual variables)
const MAX_STACK_DEPTH = 24;
const BVH_STRIDE = 3; // 3 vec4s per BVH node
const TRI_STRIDE = 8; // 8 vec4s per triangle
const MATERIAL_SLOTS = 11; // Material texture stride
const HUGE_VAL = 1e8;

// ================================================================================
// STACK HELPERS (Pure TSL - no arrays)
// ================================================================================

/**
 * Stack structure using individual variables
 * TSL doesn't support local arrays, so we use individual vars with Switch access
 */
const createStack = () => {

	return {
		s0: int( 0 ).toVar( 's0' ),
		s1: int( 0 ).toVar( 's1' ),
		s2: int( 0 ).toVar( 's2' ),
		s3: int( 0 ).toVar( 's3' ),
		s4: int( 0 ).toVar( 's4' ),
		s5: int( 0 ).toVar( 's5' ),
		s6: int( 0 ).toVar( 's6' ),
		s7: int( 0 ).toVar( 's7' ),
		s8: int( 0 ).toVar( 's8' ),
		s9: int( 0 ).toVar( 's9' ),
		s10: int( 0 ).toVar( 's10' ),
		s11: int( 0 ).toVar( 's11' ),
		s12: int( 0 ).toVar( 's12' ),
		s13: int( 0 ).toVar( 's13' ),
		s14: int( 0 ).toVar( 's14' ),
		s15: int( 0 ).toVar( 's15' ),
		s16: int( 0 ).toVar( 's16' ),
		s17: int( 0 ).toVar( 's17' ),
		s18: int( 0 ).toVar( 's18' ),
		s19: int( 0 ).toVar( 's19' ),
		s20: int( 0 ).toVar( 's20' ),
		s21: int( 0 ).toVar( 's21' ),
		s22: int( 0 ).toVar( 's22' ),
		s23: int( 0 ).toVar( 's23' )
	};

};

/**
 * Read from stack at given index using nested select (TSL ternary)
 * More efficient than Switch for this use case
 */
const stackRead = ( stack, index ) => {

	// Use nested select for stack read - more TSL-friendly than Switch
	return select( index.lessThan( int( 12 ) ),
		select( index.lessThan( int( 6 ) ),
			select( index.lessThan( int( 3 ) ),
				select( index.equal( int( 0 ) ), stack.s0, select( index.equal( int( 1 ) ), stack.s1, stack.s2 ) ),
				select( index.equal( int( 3 ) ), stack.s3, select( index.equal( int( 4 ) ), stack.s4, stack.s5 ) )
			),
			select( index.lessThan( int( 9 ) ),
				select( index.equal( int( 6 ) ), stack.s6, select( index.equal( int( 7 ) ), stack.s7, stack.s8 ) ),
				select( index.equal( int( 9 ) ), stack.s9, select( index.equal( int( 10 ) ), stack.s10, stack.s11 ) )
			)
		),
		select( index.lessThan( int( 18 ) ),
			select( index.lessThan( int( 15 ) ),
				select( index.equal( int( 12 ) ), stack.s12, select( index.equal( int( 13 ) ), stack.s13, stack.s14 ) ),
				select( index.equal( int( 15 ) ), stack.s15, select( index.equal( int( 16 ) ), stack.s16, stack.s17 ) )
			),
			select( index.lessThan( int( 21 ) ),
				select( index.equal( int( 18 ) ), stack.s18, select( index.equal( int( 19 ) ), stack.s19, stack.s20 ) ),
				select( index.equal( int( 21 ) ), stack.s21, select( index.equal( int( 22 ) ), stack.s22, stack.s23 ) )
			)
		)
	);

};

/**
 * Write to stack at given index using If statements
 */
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

};

// ================================================================================
// TEXTURE DATA ACCESS
// ================================================================================

/**
 * Read vec4 from data texture at given index
 * Matches GLSL getDatafromDataTexture pattern
 */
const getDataFromTexture = Fn( ( [ tex, texSize, itemIndex, slotIndex, stride ] ) => {

	const baseIndex = itemIndex.mul( stride ).add( slotIndex );
	const x = baseIndex.mod( texSize.x );
	const y = baseIndex.div( texSize.x );
	const uv = vec2( x, y ).add( 0.5 ).div( vec2( texSize ) );

	return texture( tex, uv );

} );

// ================================================================================
// RAY-AABB INTERSECTION
// ================================================================================

/**
 * Fast ray-AABB intersection returning distance
 * Matches GLSL fastRayAABBDst function
 *
 * @returns {float} Distance to intersection, or HUGE_VAL if miss
 */
const fastRayAABBDst = Fn( ( [ rayOrigin, invDir, boxMin, boxMax ] ) => {

	const t1 = boxMin.sub( rayOrigin ).mul( invDir );
	const t2 = boxMax.sub( rayOrigin ).mul( invDir );

	const tmin = min( t1, t2 );
	const tmax = max( t1, t2 );

	const tNear = max( max( tmin.x, tmin.y ), tmin.z );
	const tFar = min( min( tmax.x, tmax.y ), tmax.z );

	// Return tNear if hit (and in front), HUGE_VAL if miss
	const isHit = tNear.lessThanEqual( tFar ).and( tFar.greaterThan( 0.0 ) );
	return select( isHit, max( tNear, float( 0.0 ) ), float( HUGE_VAL ) );

} );

// ================================================================================
// TRIANGLE INTERSECTION
// ================================================================================

/**
 * Ray-Triangle intersection using geometry data (Möller-Trumbore)
 * Matches GLSL RayTriangleGeometry function
 *
 * @returns {TriangleHitResult} Struct with { hit, t, u, v }
 */
const rayTriangleGeometry = Fn( ( [ rayOrigin, rayDir, pA, pB, pC, tMin, tMax ] ) => {

	// Create proper TSL struct instance
	const result = TriangleHitResult( {
		hit: tslBool( false ),
		t: float( HUGE_VAL ),
		u: float( 0.0 ),
		v: float( 0.0 )
	} ).toVar( 'triHitResult' );

	const edge1 = pB.sub( pA );
	const edge2 = pC.sub( pA );

	const h = rayDir.cross( edge2 );
	const a = dot( edge1, h );

	// Use conditional logic instead of early Return() to avoid WGSL void return issues
	// Check if ray is NOT parallel to triangle
	If( abs( a ).greaterThanEqual( 1e-8 ), () => {

		const f = float( 1.0 ).div( a );
		const s = rayOrigin.sub( pA );
		const u = f.mul( dot( s, h ) ).toVar( 'u' );

		// Check u bounds
		If( u.greaterThanEqual( 0.0 ).and( u.lessThanEqual( 1.0 ) ), () => {

			const q = s.cross( edge1 );
			const v = f.mul( dot( rayDir, q ) ).toVar( 'v' );

			// Check v bounds and u+v <= 1
			If( v.greaterThanEqual( 0.0 ).and( u.add( v ).lessThanEqual( 1.0 ) ), () => {

				const t = f.mul( dot( edge2, q ) ).toVar( 't' );

				// Check if intersection is valid (within tMin..tMax range)
				If( t.greaterThan( tMin ).and( t.lessThan( tMax ) ), () => {

					result.get( 'hit' ).assign( true );
					result.get( 't' ).assign( t );
					result.get( 'u' ).assign( u );
					result.get( 'v' ).assign( v );

				} );

			} );

		} );

	} );

	return result;

} );

// ================================================================================
// MAIN BVH TRAVERSAL (PathTracer.js compatible)
// ================================================================================

/**
 * Traverse BVH and find closest ray-triangle intersection
 *
 * This is the main traversal function used by PathTracer.js.
 * Returns basic intersection data (triangle index + barycentric coords).
 *
 * @param {vec3} rayOrigin - Ray origin (world space)
 * @param {vec3} rayDir - Ray direction (normalized)
 * @param {float} tMin - Minimum ray distance
 * @param {float} tMax - Maximum ray distance
 * @param {sampler2D} bvhTexture - BVH node texture
 * @param {ivec2} bvhTexSize - BVH texture dimensions
 * @param {sampler2D} triangleTexture - Triangle data texture
 * @param {ivec2} triTexSize - Triangle texture dimensions
 * @returns {BVHIntersectionStruct} { hit, t, triangleIndex, u, v, w }
 */
export const traverseBVH = Fn( ( [
	rayOrigin,
	rayDir,
	tMin,
	tMax,
	bvhTexture,
	bvhTexSize,
	triangleTexture,
	triTexSize
] ) => {

	// Result state
	const closestT = tMax.toVar( 'closestT' );
	const closestTriIndex = int( - 1 ).toVar( 'closestTriIndex' );
	const closestU = float( 0.0 ).toVar( 'closestU' );
	const closestV = float( 0.0 ).toVar( 'closestV' );
	const closestW = float( 0.0 ).toVar( 'closestW' );
	// Compute inverse ray direction with proper sign handling for axis-aligned rays
	const invDir = vec3(
		abs( rayDir.x ).lessThan( 1e-8 ).select(
			float( HUGE_VAL ).mul( rayDir.x.greaterThanEqual( 0.0 ).select( 1.0, - 1.0 ) ),
			float( 1.0 ).div( rayDir.x )
		),
		abs( rayDir.y ).lessThan( 1e-8 ).select(
			float( HUGE_VAL ).mul( rayDir.y.greaterThanEqual( 0.0 ).select( 1.0, - 1.0 ) ),
			float( 1.0 ).div( rayDir.y )
		),
		abs( rayDir.z ).lessThan( 1e-8 ).select(
			float( HUGE_VAL ).mul( rayDir.z.greaterThanEqual( 0.0 ).select( 1.0, - 1.0 ) ),
			float( 1.0 ).div( rayDir.z )
		)
	).toVar( 'invDir' );

	// Stack for iterative traversal (using individual variables - TSL has no local arrays)
	const stack = createStack();
	const stackPtr = int( 0 ).toVar( 'stackPtr' );
	const loopCounter = int( 0 ).toVar( 'loopCounter' );

	// Push root node (index 0)
	stack.s0.assign( int( 0 ) );
	stackPtr.assign( int( 1 ) );

	// Main traversal loop (while-style: continue while stack is not empty)
	Loop( stackPtr.greaterThan( int( 0 ) ).and( loopCounter.lessThan( int( 256 ) ) ), () => {

		loopCounter.addAssign( int( 1 ) );

		// Pop node from stack
		stackPtr.subAssign( int( 1 ) );
		const nodeIndex = stackRead( stack, stackPtr ).toVar( 'nodeIndex' );

		// Read BVH node data (first 2 vec4s)
		const nodeData0 = getDataFromTexture( bvhTexture, bvhTexSize, nodeIndex, int( 0 ), int( BVH_STRIDE ) );
		const nodeData1 = getDataFromTexture( bvhTexture, bvhTexSize, nodeIndex, int( 1 ), int( BVH_STRIDE ) );

		const leftChild = int( nodeData0.w ).toVar( 'leftChild' );
		const rightChild = int( nodeData1.w ).toVar( 'rightChild' );

		// Leaf node detection: leftChild < 0
		If( leftChild.lessThan( int( 0 ) ), () => {

			// Read third vec4 for triangle data (only for leaf nodes)
			const nodeData2 = getDataFromTexture( bvhTexture, bvhTexSize, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const triStart = int( nodeData2.x ).toVar( 'triStart' );
			const triCount = int( nodeData2.y ).toVar( 'triCount' );

			// Process triangles in leaf
			Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

				const triIndex = triStart.add( i ).toVar( 'triIndex' );

				// Fetch triangle positions
				const pA = getDataFromTexture( triangleTexture, triTexSize, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
				const pB = getDataFromTexture( triangleTexture, triTexSize, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
				const pC = getDataFromTexture( triangleTexture, triTexSize, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

				// Test ray-triangle intersection
				const triHit = rayTriangleGeometry( rayOrigin, rayDir, pA, pB, pC, tMin, closestT );

				If( triHit.get( 'hit' ), () => {

					closestT.assign( triHit.get( 't' ) );
					closestTriIndex.assign( triIndex );
					closestU.assign( triHit.get( 'u' ) );
					closestV.assign( triHit.get( 'v' ) );
					closestW.assign( float( 1.0 ).sub( triHit.get( 'u' ) ).sub( triHit.get( 'v' ) ) );

				} );

			} );

			// Early termination for very close hits
			If( closestTriIndex.greaterThanEqual( 0 ).and( closestT.lessThan( 0.001 ) ), () => {

				Break();

			} );

		} ).Else( () => {

			// Interior node - test child AABBs

			// Read child bounds
			const leftData0 = getDataFromTexture( bvhTexture, bvhTexSize, leftChild, int( 0 ), int( BVH_STRIDE ) );
			const leftData1 = getDataFromTexture( bvhTexture, bvhTexSize, leftChild, int( 1 ), int( BVH_STRIDE ) );
			const rightData0 = getDataFromTexture( bvhTexture, bvhTexSize, rightChild, int( 0 ), int( BVH_STRIDE ) );
			const rightData1 = getDataFromTexture( bvhTexture, bvhTexSize, rightChild, int( 1 ), int( BVH_STRIDE ) );

			const childA_boundsMin = leftData0.xyz;
			const childA_boundsMax = leftData1.xyz;
			const childB_boundsMin = rightData0.xyz;
			const childB_boundsMax = rightData1.xyz;

			// Test ray-AABB intersections
			const dstA = fastRayAABBDst( rayOrigin, invDir, childA_boundsMin, childA_boundsMax ).toVar( 'dstA' );
			const dstB = fastRayAABBDst( rayOrigin, invDir, childB_boundsMin, childB_boundsMax ).toVar( 'dstB' );

			// Early rejection if both children are farther than current closest hit
			const minDst = min( dstA, dstB );

			If( minDst.lessThan( closestT ), () => {

				// Distance-based child ordering: process closer child first
				const aCloser = dstA.lessThan( dstB );
				const nearChild = select( aCloser, leftChild, rightChild ).toVar( 'nearChild' );
				const farChild = select( aCloser, rightChild, leftChild ).toVar( 'farChild' );
				const nearDst = select( aCloser, dstA, dstB ).toVar( 'nearDst' );
				const farDst = select( aCloser, dstB, dstA ).toVar( 'farDst' );

				// Push far child first (processed last)
				If( farDst.lessThan( closestT ).and( stackPtr.lessThan( MAX_STACK_DEPTH - 1 ) ), () => {

					stackWrite( stack, stackPtr, farChild );
					stackPtr.addAssign( int( 1 ) );

				} );

				// Push near child second (processed first)
				If( nearDst.lessThan( closestT ).and( stackPtr.lessThan( MAX_STACK_DEPTH ) ), () => {

					stackWrite( stack, stackPtr, nearChild );
					stackPtr.addAssign( int( 1 ) );

				} );

			} );

		} );

	} );

	const hit = closestTriIndex.greaterThanEqual( 0 );

	return BVHIntersectionResult( {
		hit,
		t: closestT,
		triangleIndex: closestTriIndex,
		u: closestU,
		v: closestV,
		w: closestW
	} );

} );

// ================================================================================
// SHADOW RAY TRAVERSAL (OPTIMIZED)
// ================================================================================

/**
 * Test BVH for any intersection (shadow ray optimization)
 *
 * Early exits as soon as any intersection is found.
 * More efficient for shadow rays where we only need boolean visibility.
 *
 * @param {vec3} rayOrigin - Ray origin
 * @param {vec3} rayDir - Ray direction (normalized)
 * @param {float} tMin - Minimum ray distance
 * @param {float} maxDist - Maximum ray distance (typically distance to light)
 * @param {sampler2D} bvhTexture - BVH texture
 * @param {ivec2} bvhTexSize - BVH texture size
 * @param {sampler2D} triangleTexture - Triangle texture
 * @param {ivec2} triTexSize - Triangle texture size
 * @returns {bool} True if any intersection found (ray is occluded)
 */
export const traverseBVHShadow = Fn( ( [
	rayOrigin,
	rayDir,
	tMin,
	maxDist,
	bvhTexture,
	bvhTexSize,
	triangleTexture,
	triTexSize
] ) => {

	const occluded = tslBool( false ).toVar( 'occluded' );

	// Compute inverse ray direction
	const invDir = vec3(
		abs( rayDir.x ).lessThan( 1e-8 ).select( float( HUGE_VAL ), float( 1.0 ).div( rayDir.x ) ),
		abs( rayDir.y ).lessThan( 1e-8 ).select( float( HUGE_VAL ), float( 1.0 ).div( rayDir.y ) ),
		abs( rayDir.z ).lessThan( 1e-8 ).select( float( HUGE_VAL ), float( 1.0 ).div( rayDir.z ) )
	).toVar( 'invDir' );

	// Stack for traversal (using individual variables - TSL has no local arrays)
	const stack = createStack();
	const stackPtr = int( 0 ).toVar( 'stackPtr' );
	const loopCounter = int( 0 ).toVar( 'loopCounter' );

	stack.s0.assign( int( 0 ) );
	stackPtr.assign( int( 1 ) );

	const closestDst = maxDist.toVar( 'closestDst' );

	// Traversal loop with early exit condition (while-style)
	Loop( stackPtr.greaterThan( int( 0 ) ).and( occluded.not() ).and( loopCounter.lessThan( int( 256 ) ) ), () => {

		loopCounter.addAssign( int( 1 ) );

		stackPtr.subAssign( int( 1 ) );
		const nodeIndex = stackRead( stack, stackPtr ).toVar( 'nodeIndex' );

		const nodeData0 = getDataFromTexture( bvhTexture, bvhTexSize, nodeIndex, int( 0 ), int( BVH_STRIDE ) );
		const nodeData1 = getDataFromTexture( bvhTexture, bvhTexSize, nodeIndex, int( 1 ), int( BVH_STRIDE ) );

		const leftChild = int( nodeData0.w ).toVar( 'leftChild' );
		const rightChild = int( nodeData1.w ).toVar( 'rightChild' );

		If( leftChild.lessThan( int( 0 ) ), () => {

			// Leaf node
			const nodeData2 = getDataFromTexture( bvhTexture, bvhTexSize, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const triStart = int( nodeData2.x ).toVar( 'triStart' );
			const triCount = int( nodeData2.y ).toVar( 'triCount' );

			// Triangle loop with early exit on hit
			Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

				const triIndex = triStart.add( i ).toVar( 'triIndex' );

				const pA = getDataFromTexture( triangleTexture, triTexSize, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
				const pB = getDataFromTexture( triangleTexture, triTexSize, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
				const pC = getDataFromTexture( triangleTexture, triTexSize, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

				const triHit = rayTriangleGeometry( rayOrigin, rayDir, pA, pB, pC, tMin, closestDst );

				If( triHit.get( 'hit' ), () => {

					occluded.assign( true );
					Break();

				} );

			} );

		} ).Else( () => {

			// Interior node
			const leftData0 = getDataFromTexture( bvhTexture, bvhTexSize, leftChild, int( 0 ), int( BVH_STRIDE ) );
			const leftData1 = getDataFromTexture( bvhTexture, bvhTexSize, leftChild, int( 1 ), int( BVH_STRIDE ) );
			const rightData0 = getDataFromTexture( bvhTexture, bvhTexSize, rightChild, int( 0 ), int( BVH_STRIDE ) );
			const rightData1 = getDataFromTexture( bvhTexture, bvhTexSize, rightChild, int( 1 ), int( BVH_STRIDE ) );

			const dstA = fastRayAABBDst( rayOrigin, invDir, leftData0.xyz, leftData1.xyz ).toVar( 'dstA' );
			const dstB = fastRayAABBDst( rayOrigin, invDir, rightData0.xyz, rightData1.xyz ).toVar( 'dstB' );

			const minDst = min( dstA, dstB );

			If( minDst.lessThan( closestDst ), () => {

				// Push children (no ordering needed for shadow rays, any hit suffices)
				If( dstB.lessThan( closestDst ).and( stackPtr.lessThan( MAX_STACK_DEPTH - 1 ) ), () => {

					stackWrite( stack, stackPtr, rightChild );
					stackPtr.addAssign( int( 1 ) );

				} );

				If( dstA.lessThan( closestDst ).and( stackPtr.lessThan( MAX_STACK_DEPTH ) ), () => {

					stackWrite( stack, stackPtr, leftChild );
					stackPtr.addAssign( int( 1 ) );

				} );

			} );

		} );

	} );

	return occluded;

} );

/**
 * Generate ray from camera for a given screen position
 */
export const generateRayFromCamera = Fn( ( [ screenPosition, cameraWorldMatrix, cameraProjectionMatrixInverse, seed ] ) => {

	const ndc = screenPosition;
	const clipPos = vec4( ndc.x, ndc.y, float( - 1.0 ), float( 1.0 ) );

	// Transform from clip space to view space
	const viewPos = cameraProjectionMatrixInverse.mul( clipPos );
	const viewDir = viewPos.xyz.div( viewPos.w );

	// Transform from view space to world space
	const worldDirRaw = cameraWorldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz;
	const worldDir = worldDirRaw.normalize();

	// Get camera position from world matrix
	const worldOrigin = vec3(
		cameraWorldMatrix.element( 3 ).x,
		cameraWorldMatrix.element( 3 ).y,
		cameraWorldMatrix.element( 3 ).z
	);

	return Ray( {
		origin: worldOrigin,
		direction: worldDir
	} );

} );
