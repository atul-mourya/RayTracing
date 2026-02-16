import { Fn, float, vec2, vec3, int, If, Loop, max, abs, normalize, cross, dot } from 'three/tsl';

import { HitInfo, Ray, Triangle, RayTracingMaterial } from './Struct.js';
import { getMaterial } from './Common.js';
import { sampleDisplacementMap } from './TextureSampling.js';
import { RayTriangle } from './RayIntersection.js';

// Configuration constants for displacement mapping
const MAX_DISPLACEMENT_STEPS = 64;
const MAX_BINARY_SEARCH_STEPS = 8;
const DISPLACEMENT_EPSILON = 0.0001;
const MIN_STEP_SIZE = 0.0005;

// Get surface height at point using displacement mapping
export const getDisplacedHeight = Fn( ( [ displacementMaps, point, normal, baseUV, material ] ) => {

	const result = float( 0.0 ).toVar( 'dispHeight' );

	If( material.displacementMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const heightSample = sampleDisplacementMap( displacementMaps, material.displacementMapIndex, baseUV, material.displacementTransform );
		result.assign( heightSample.mul( material.displacementScale ) );

	} );

	return result;

} );

// Calculate displaced position along surface normal
export const getDisplacedPosition = Fn( ( [ displacementMaps, basePoint, normal, uv, material ] ) => {

	const height = getDisplacedHeight( displacementMaps, basePoint, normal, uv, material );
	return basePoint.add( normal.mul( height ) );

} );

// Simplified displacement application for post-intersection processing
export const applyDisplacement = Fn( ( [ displacementMaps, basePoint, normal, uv, material ] ) => {

	const result = basePoint.toVar( 'dispResult' );

	If( material.displacementMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const height = getDisplacedHeight( displacementMaps, basePoint, normal, uv, material );
		result.assign( basePoint.add( normal.mul( height ) ) );

	} );

	return result;

} );

// Calculate normal for displaced surface using finite differences
export const calculateDisplacedNormal = Fn( ( [ displacementMaps, point, baseNormal, uv, material ] ) => {

	const result = baseNormal.toVar( 'dispNorm' );

	If( material.displacementMapIndex.greaterThanEqual( int( 0 ) ), () => {

		// Use larger offset for smoother normal variation - prevents overly sharp/glossy appearance
		const h = float( 0.01 );

		// Sample heights at nearby UV coordinates
		const heightCenter = getDisplacedHeight( displacementMaps, point, baseNormal, uv, material );
		const heightU = getDisplacedHeight( displacementMaps, point, baseNormal, uv.add( vec2( h, 0.0 ) ), material );
		const heightV = getDisplacedHeight( displacementMaps, point, baseNormal, uv.add( vec2( 0.0, h ) ), material );

		// Calculate partial derivatives with smoothing
		const dHdU = heightU.sub( heightCenter ).div( h ).mul( 0.5 ).toVar( 'dHdU' );
		const dHdV = heightV.sub( heightCenter ).div( h ).mul( 0.5 ).toVar( 'dHdV' );

		// Create tangent vectors (simplified - assumes UV corresponds to world space)
		const tangentU = normalize( cross( baseNormal, vec3( 0.0, 1.0, 0.0 ) ) ).toVar( 'tangU' );
		const tangentV = normalize( cross( baseNormal, tangentU ) ).toVar( 'tangV' );

		// Perturb normal based on height gradients with reduced strength
		const displacedNormal = baseNormal.sub( tangentU.mul( dHdU ) ).sub( tangentV.mul( dHdV ) );
		result.assign( normalize( displacedNormal ) );

	} );

	return result;

} );

// Ray marching function to find displaced surface intersection
export const RayTriangleDisplaced = Fn( ( [ ray, tri, triangleTexture, triangleTexSize, materialDataTexture, materialTexSize, displacementMaps ] ) => {

	// First, get the base triangle intersection
	const baseHit = RayTriangle( ray, tri, triangleTexture, triangleTexSize ).toVar( 'baseHit' );
	const result = baseHit.toVar( 'dispHitResult' );

	If( baseHit.didHit, () => {

		// Get material from material index
		const material = RayTracingMaterial.wrap( getMaterial( tri.materialIndex, materialDataTexture, materialTexSize ) );

		// If displacement is not enabled, return base hit
		If( material.displacementMapIndex.greaterThanEqual( int( 0 ) ).and( material.displacementScale.greaterThan( 0.0 ) ), () => {

			const rayDir = ray.direction;
			const rayOrigin = ray.origin;

			// Start marching from slightly before the base surface
			const marchStart = max( float( 0.0 ), baseHit.dst.sub( material.displacementScale ) ).toVar( 'marchStart' );
			const marchEnd = baseHit.dst.add( material.displacementScale ).toVar( 'marchEnd' );

			// Dynamic step size based on displacement scale
			const stepSize = max( material.displacementScale.div( 16.0 ), 0.001 ).toVar( 'stepSize' );

			const baseNormal = baseHit.normal;
			const baseUV = baseHit.uv;

			const t = marchStart.toVar( 't' );
			const found = int( 0 ).toVar( 'found' );

			Loop( t.lessThan( marchEnd ).and( found.equal( int( 0 ) ) ), () => {

				const marchPoint = rayOrigin.add( rayDir.mul( t ) ).toVar( 'marchPt' );

				// Project point onto base triangle to get UV coordinates
				const toPoint = marchPoint.sub( baseHit.hitPoint );

				// Use base UV for now (could be improved with proper UV interpolation)
				const currentUV = baseUV;

				// Get displacement at this point
				const heightSample = sampleDisplacementMap( displacementMaps, material.displacementMapIndex, currentUV, material.displacementTransform );
				const displacementHeight = heightSample.sub( 0.5 ).mul( material.displacementScale );
				const displacedSurface = baseHit.hitPoint.add( baseNormal.mul( displacementHeight ) ).toVar( 'dispSurf' );

				// Check if we're close to the displaced surface
				const distanceToSurface = dot( marchPoint.sub( displacedSurface ), baseNormal );

				If( abs( distanceToSurface ).lessThan( stepSize.mul( 0.5 ) ), () => {

					// Found intersection - create displaced hit info
					result.dst.assign( t );
					result.hitPoint.assign( marchPoint );
					result.uv.assign( currentUV );
					result.normal.assign( calculateDisplacedNormal( displacementMaps, displacedSurface, baseNormal, currentUV, material ) );
					found.assign( 1 );

				} );

				t.addAssign( stepSize );

			} );

		} );

	} );

	return result;

} );
