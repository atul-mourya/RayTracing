import { Fn, float, vec2, vec3, int, If, dot, cross, abs, normalize, sqrt, min, max, select } from 'three/tsl';

import {
	Ray,
	HitInfo,
	Triangle,
	Sphere,
} from './Struct.js';

// Optimized Intersection with Geometry only (no attributes)
// Returns { hit, t, u, v }
export const RayTriangleGeometry = Fn( ( [ ray, posA, posB, posC ] ) => {

	const edge1 = posB.sub( posA );
	const edge2 = posC.sub( posA );
	const h = cross( ray.direction, edge2 );
	const a = dot( edge1, h ).toVar();

	const t = float( 0.0 ).toVar();
	const u = float( 0.0 ).toVar();
	const v = float( 0.0 ).toVar();
	const hit = int( 0 ).toVar();

	If( abs( a ).greaterThan( 1e-8 ), () => {

		const f = float( 1.0 ).div( a );
		const s = ray.origin.sub( posA );
		u.assign( f.mul( dot( s, h ) ) );

		If( u.greaterThanEqual( 0.0 ).and( u.lessThanEqual( 1.0 ) ), () => {

			const q = cross( s, edge1 );
			v.assign( f.mul( dot( ray.direction, q ) ) );

			If( v.greaterThanEqual( 0.0 ).and( u.add( v ).lessThanEqual( 1.0 ) ), () => {

				t.assign( f.mul( dot( edge2, q ) ) );

				If( t.greaterThan( 1e-8 ), () => {

					hit.assign( 1 );

				} );

			} );

		} );

	} );

	return hit;

} );

// Calculate the intersection of a ray with a triangle using Möller-Trumbore algorithm
export const RayTriangle = Fn( ( [ ray, tri ] ) => {

	const didHit = int( 0 ).toVar();
	const dst = float( 1.0e20 ).toVar();
	const hitPoint = vec3( 0.0 ).toVar();
	const normal = vec3( 0.0, 0.0, 1.0 ).toVar();
	const uv = vec2( 0.0 ).toVar();
	const material = int( - 1 ).toVar();

	const edge1 = tri.posB.sub( tri.posA );
	const edge2 = tri.posC.sub( tri.posA );
	const h = cross( ray.direction, edge2 );
	const a = dot( edge1, h ).toVar();

	If( abs( a ).greaterThan( 1e-8 ), () => {

		const f = float( 1.0 ).div( a );
		const s = ray.origin.sub( tri.posA );
		const u = f.mul( dot( s, h ) ).toVar();

		If( u.greaterThanEqual( 0.0 ).and( u.lessThanEqual( 1.0 ) ), () => {

			const q = cross( s, edge1 );
			const v = f.mul( dot( ray.direction, q ) ).toVar();

			If( v.greaterThanEqual( 0.0 ).and( u.add( v ).lessThanEqual( 1.0 ) ), () => {

				const t = f.mul( dot( edge2, q ) ).toVar();

				If( t.greaterThan( 1e-8 ).and( t.lessThan( dst ) ), () => {

					didHit.assign( 1 );
					dst.assign( t );
					hitPoint.assign( ray.origin.add( ray.direction.mul( t ) ) );

					// Interpolate normal using barycentric coordinates
					const w = float( 1.0 ).sub( u ).sub( v );
					normal.assign( normalize(
						tri.normalA.mul( w ).add( tri.normalB.mul( u ) ).add( tri.normalC.mul( v ) )
					) );

					// Interpolate UV coordinates
					uv.assign( tri.uvA.mul( w ).add( tri.uvB.mul( u ) ).add( tri.uvC.mul( v ) ) );

					// Set material index
					material.assign( tri.material );

				} );

			} );

		} );

	} );

	return HitInfo( { didHit, dst, hitPoint, normal, uv, materialIndex: material, meshIndex: int( - 1 ), boxTests: int( 0 ), triTests: int( 0 ) } );

} );

// Ray-sphere intersection
export const RaySphere = Fn( ( [ ray, sphere ] ) => {

	const didHit = int( 0 ).toVar();
	const dst = float( 1.0e20 ).toVar();
	const hitPoint = vec3( 0.0 ).toVar();
	const normal = vec3( 0.0, 0.0, 1.0 ).toVar();
	const material = int( - 1 ).toVar();

	const oc = ray.origin.sub( sphere.position );
	const a = dot( ray.direction, ray.direction );
	const b = float( 2.0 ).mul( dot( oc, ray.direction ) );
	const c = dot( oc, oc ).sub( sphere.radius.mul( sphere.radius ) );
	const discriminant = b.mul( b ).sub( float( 4.0 ).mul( a ).mul( c ) ).toVar();

	If( discriminant.greaterThan( 0.0 ), () => {

		const t = b.negate().sub( sqrt( discriminant ) ).div( float( 2.0 ).mul( a ) ).toVar();

		If( t.greaterThan( 0.0 ), () => {

			didHit.assign( 1 );
			dst.assign( t );
			hitPoint.assign( ray.origin.add( ray.direction.mul( t ) ) );
			normal.assign( normalize( hitPoint.sub( sphere.position ) ) );
			material.assign( sphere.material );

		} );

	} );

	return HitInfo( { didHit, dst, hitPoint, normal, uv: vec2( 0.0 ), materialIndex: material, meshIndex: int( - 1 ), boxTests: int( 0 ), triTests: int( 0 ) } );

} );

// Fast ray-AABB distance calculation with early exit optimization
export const fastRayAABBDst = Fn( ( [ ray, invDir, boxMin, boxMax ] ) => {

	const t1 = boxMin.sub( ray.origin ).mul( invDir );
	const t2 = boxMax.sub( ray.origin ).mul( invDir );

	const tMin = min( t1, t2 );
	const tMax = max( t1, t2 );

	const dstNear = max( max( tMin.x, tMin.y ), tMin.z );
	const dstFar = min( min( tMax.x, tMax.y ), tMax.z ).mul( 1.00000024 ); // Robust traversal: 2 ULP padding (Ize 2013)

	// Optimized early rejection
	return select( dstFar.greaterThanEqual( max( dstNear, 0.0 ) ), max( dstNear, 0.0 ), float( 1e20 ) );

} );
