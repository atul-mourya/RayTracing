import { Fn, float, vec2, vec3, int, If, Loop, cross } from 'three/tsl';
import { sampleDisplacementMap } from './TextureSampling.js';

/**
 * Displacement Mapping for TSL/WGSL
 * Complete port of displacement.fs from GLSL to TSL/WGSL
 *
 * Implements tessellation-free displacement mapping using sphere tracing/ray marching
 * to find intersections with displaced surfaces. Provides functions for:
 * - Sampling displacement heights
 * - Calculating displaced positions
 * - Computing displaced normals using finite differences
 * - Ray marching to find displaced surface intersections
 *
 * Note: Requires material data structure and texture sampling functions.
 * Texture sampling is handled by TextureSampling.js module.
 */

// ================================================================================
// CONFIGURATION CONSTANTS (for reference - may be used in future optimizations)
// ================================================================================

// const MAX_DISPLACEMENT_STEPS = 64;
// const MAX_BINARY_SEARCH_STEPS = 8;
// const DISPLACEMENT_EPSILON = 0.0001;
// const MIN_STEP_SIZE = 0.0005;

// ================================================================================
// HEIGHT SAMPLING FUNCTIONS
// ================================================================================

/**
 * Get surface height at point using displacement mapping.
 * Samples displacement map and applies material scale.
 *
 * @param {TSLNode} _point - Surface point position (vec3) - reserved for future use
 * @param {TSLNode} _normal - Surface normal (vec3) - reserved for future use
 * @param {TSLNode} baseUV - Base UV coordinates (vec2)
 * @param {TSLNode} material - Material data structure
 * @param {TSLNode} displacementMaps - Displacement texture array
 * @returns {TSLNode} Height value (float)
 */
// eslint-disable-next-line no-unused-vars
export const getDisplacedHeight = Fn( ( [ _point, _normal, baseUV, material, displacementMaps ] ) => {

	const displacementMapIndex = material.element( 'displacementMapIndex' ).toVar();
	const displacementScale = material.element( 'displacementScale' ).toVar();
	const displacementTransform = material.element( 'displacementTransform' ).toVar();

	If( displacementMapIndex.lessThan( int( 0 ) ), () => {

		return float( 0.0 );

	} );

	const heightSample = sampleDisplacementMap(
		displacementMapIndex,
		baseUV,
		displacementTransform,
		displacementMaps
	).toVar();

	return heightSample.mul( displacementScale );

} ).setLayout( {
	name: 'getDisplacedHeight',
	type: 'float',
	inputs: [
		{ name: 'point', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'baseUV', type: 'vec2' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'displacementMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Calculate displaced position along surface normal.
 * Applies displacement height to base point.
 *
 * @param {TSLNode} basePoint - Base surface point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} uv - UV coordinates (vec2)
 * @param {TSLNode} material - Material data structure
 * @param {TSLNode} displacementMaps - Displacement texture array
 * @returns {TSLNode} Displaced position (vec3)
 */
export const getDisplacedPosition = Fn( ( [ basePoint, normal, uv, material, displacementMaps ] ) => {

	const height = getDisplacedHeight( basePoint, normal, uv, material, displacementMaps ).toVar();
	return basePoint.add( normal.mul( height ) );

} ).setLayout( {
	name: 'getDisplacedPosition',
	type: 'vec3',
	inputs: [
		{ name: 'basePoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'displacementMaps', type: 'sampler2DArray' }
	]
} );

/**
 * Simplified displacement application for post-intersection processing.
 * Returns displaced point or base point if displacement is disabled.
 *
 * @param {TSLNode} basePoint - Base surface point (vec3)
 * @param {TSLNode} normal - Surface normal (vec3)
 * @param {TSLNode} uv - UV coordinates (vec2)
 * @param {TSLNode} material - Material data structure
 * @param {TSLNode} displacementMaps - Displacement texture array
 * @returns {TSLNode} Displaced or base position (vec3)
 */
export const applyDisplacement = Fn( ( [ basePoint, normal, uv, material, displacementMaps ] ) => {

	const displacementMapIndex = material.element( 'displacementMapIndex' ).toVar();

	If( displacementMapIndex.lessThan( int( 0 ) ), () => {

		return basePoint;

	} );

	const height = getDisplacedHeight( basePoint, normal, uv, material, displacementMaps ).toVar();
	return basePoint.add( normal.mul( height ) );

} ).setLayout( {
	name: 'applyDisplacement',
	type: 'vec3',
	inputs: [
		{ name: 'basePoint', type: 'vec3' },
		{ name: 'normal', type: 'vec3' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'displacementMaps', type: 'sampler2DArray' }
	]
} );

// ================================================================================
// NORMAL CALCULATION
// ================================================================================

/**
 * Calculate normal for displaced surface using finite differences.
 * Uses larger offset for smoother normal variation to prevent overly sharp/glossy appearance.
 *
 * @param {TSLNode} point - Surface point (vec3)
 * @param {TSLNode} baseNormal - Base surface normal (vec3)
 * @param {TSLNode} uv - UV coordinates (vec2)
 * @param {TSLNode} material - Material data structure
 * @param {TSLNode} displacementMaps - Displacement texture array
 * @returns {TSLNode} Displaced normal (vec3)
 */
export const calculateDisplacedNormal = Fn( ( [ point, baseNormal, uv, material, displacementMaps ] ) => {

	const displacementMapIndex = material.element( 'displacementMapIndex' ).toVar();

	If( displacementMapIndex.lessThan( int( 0 ) ), () => {

		return baseNormal;

	} );

	// Use larger offset for smoother normal variation - prevents overly sharp/glossy appearance
	const h = float( 0.01 ).toVar(); // Increased from 0.001 for smoother results

	// Sample heights at nearby UV coordinates
	const heightCenter = getDisplacedHeight( point, baseNormal, uv, material, displacementMaps ).toVar();
	const heightU = getDisplacedHeight(
		point,
		baseNormal,
		uv.add( vec2( h, 0.0 ) ),
		material,
		displacementMaps
	).toVar();
	const heightV = getDisplacedHeight(
		point,
		baseNormal,
		uv.add( vec2( 0.0, h ) ),
		material,
		displacementMaps
	).toVar();

	// Calculate partial derivatives with smoothing
	const dHdU = heightU.sub( heightCenter ).div( h ).toVar();
	const dHdV = heightV.sub( heightCenter ).div( h ).toVar();

	// Scale down the gradient strength to avoid overly sharp normals
	const gradientStrength = float( 0.5 ).toVar(); // Reduce from 1.0 to make it less aggressive
	dHdU.mulAssign( gradientStrength );
	dHdV.mulAssign( gradientStrength );

	// Create tangent vectors (simplified - assumes UV corresponds to world space)
	const tangentU = cross( baseNormal, vec3( 0.0, 1.0, 0.0 ) ).normalize().toVar();
	const tangentV = cross( baseNormal, tangentU ).normalize().toVar();

	// Perturb normal based on height gradients with reduced strength
	const displacedNormal = baseNormal.sub( dHdU.mul( tangentU ) ).sub( dHdV.mul( tangentV ) ).toVar();

	return displacedNormal.normalize();

} ).setLayout( {
	name: 'calculateDisplacedNormal',
	type: 'vec3',
	inputs: [
		{ name: 'point', type: 'vec3' },
		{ name: 'baseNormal', type: 'vec3' },
		{ name: 'uv', type: 'vec2' },
		{ name: 'material', type: 'RayTracingMaterial' },
		{ name: 'displacementMaps', type: 'sampler2DArray' }
	]
} );

// ================================================================================
// RAY MARCHING FUNCTIONS
// ================================================================================

/**
 * Ray marching function to find displaced surface intersection.
 * Uses sphere tracing approach to locate intersection with displaced surface.
 *
 * This function expects HitInfo structure from RayTriangle intersection as input.
 * It then refines the intersection point to account for displacement mapping.
 *
 * Note: This is a factory function that returns a configured Fn.
 * The actual rayTriangleIntersect function should be passed in from RayTriangle.js.
 *
 * @param {Function} rayTriangleIntersect - Ray-triangle intersection function
 * @param {TSLNode} displacementMaps - Displacement texture array
 * @returns {Function} Configured ray-triangle-displaced intersection function
 */
export const createRayTriangleDisplaced = ( rayTriangleIntersect, displacementMaps ) => {

	return Fn( ( [ ray, triangle, material ] ) => {

		// First, get the base triangle intersection
		const baseHit = rayTriangleIntersect( ray, triangle ).toVar();

		const didHit = baseHit.element( 'didHit' ).toVar();

		If( didHit.not(), () => {

			return baseHit;

		} );

		// Check if displacement is enabled
		const displacementMapIndex = material.element( 'displacementMapIndex' ).toVar();
		const displacementScale = material.element( 'displacementScale' ).toVar();

		If( displacementMapIndex.lessThan( int( 0 ) ).or( displacementScale.lessThanEqual( float( 0.0 ) ) ), () => {

			return baseHit;

		} );

		// Ray march to find the actual displaced surface
		const rayDir = ray.element( 'direction' ).toVar();
		const rayOrigin = ray.element( 'origin' ).toVar();

		const baseDst = baseHit.element( 'dst' ).toVar();
		const baseHitPoint = baseHit.element( 'hitPoint' ).toVar();
		const baseNormal = baseHit.element( 'normal' ).toVar();
		const baseUV = baseHit.element( 'uv' ).toVar();

		// Start marching from slightly before the base surface
		const marchStart = baseDst.sub( displacementScale ).max( float( 0.0 ) ).toVar();
		const marchEnd = baseDst.add( displacementScale ).toVar();

		// Dynamic step size based on displacement scale
		const stepSize = displacementScale.div( float( 16.0 ) ).toVar(); // 16 steps across displacement range
		stepSize.assign( stepSize.max( float( 0.001 ) ) ); // Minimum step size

		// Ray marching loop
		const t = float( marchStart ).toVar();

		Loop( { type: 'float', start: marchStart, end: marchEnd, update: '+stepSize' }, ( { i } ) => {

			t.assign( i );

			If( t.greaterThanEqual( marchEnd ), () => {

				return;

			} );

			const marchPoint = rayOrigin.add( rayDir.mul( t ) ).toVar();

			// Project point onto base triangle to get UV coordinates
			// Note: toPoint calculation reserved for future UV interpolation improvements
			// eslint-disable-next-line no-unused-vars
			const toPoint = marchPoint.sub( baseHitPoint ).toVar();
			// const projected = baseHitPoint.add( toPoint.sub( baseNormal.mul( toPoint.dot( baseNormal ) ) ) ).toVar();

			// Use base UV for now (could be improved with proper UV interpolation)
			const currentUV = baseUV.toVar();

			// Get displacement at this point
			const heightSample = sampleDisplacementMap(
				displacementMapIndex,
				currentUV,
				material.element( 'displacementTransform' ),
				displacementMaps
			).toVar();

			const displacementHeight = heightSample.sub( float( 0.5 ) ).mul( displacementScale ).toVar();
			const displacedSurface = baseHitPoint.add( baseNormal.mul( displacementHeight ) ).toVar();

			// Check if we're close to the displaced surface
			const distanceToSurface = marchPoint.sub( displacedSurface ).dot( baseNormal ).toVar();

			If( distanceToSurface.abs().lessThan( stepSize.mul( float( 0.5 ) ) ), () => {

				// Found intersection - create displaced hit info
				const displacedHit = baseHit.toVar();

				displacedHit.element( 'dst' ).assign( t );
				displacedHit.element( 'hitPoint' ).assign( marchPoint );
				displacedHit.element( 'uv' ).assign( currentUV );
				displacedHit.element( 'normal' ).assign(
					calculateDisplacedNormal( displacedSurface, baseNormal, currentUV, material, displacementMaps )
				);

				return displacedHit;

			} );

		} );

		// If no displaced intersection found, return base hit
		return baseHit;

	} ).setLayout( {
		name: 'rayTriangleDisplaced',
		type: 'HitInfo',
		inputs: [
			{ name: 'ray', type: 'Ray' },
			{ name: 'triangle', type: 'Triangle' },
			{ name: 'material', type: 'RayTracingMaterial' }
		]
	} );

};
