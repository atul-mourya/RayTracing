uniform mat4 cameraWorldMatrix;
uniform mat4 cameraProjectionMatrixInverse;

uniform float focusDistance;
uniform float aperture;
uniform float focalLength;
uniform float apertureScale;
uniform float sceneScale;

// Calculate the intersection of a ray with a triangle using Möller-Trumbore algorithm
// Thanks to https://stackoverflow.com/a/42752998
HitInfo RayTriangle( Ray ray, Triangle tri ) {
	HitInfo result;
	result.didHit = false;
	result.dst = 1.0e20;

	vec3 edge1 = tri.posB - tri.posA;
	vec3 edge2 = tri.posC - tri.posA;
	vec3 h = cross( ray.direction, edge2 );
	float a = dot( edge1, h );

	if( abs( a ) < 1e-8 )
		return result; // Ray is parallel to the triangle

	float f = 1.0 / a;
	vec3 s = ray.origin - tri.posA;
	float u = f * dot( s, h );

	if( u < 0.0 || u > 1.0 )
		return result;

	vec3 q = cross( s, edge1 );
	float v = f * dot( ray.direction, q );

	if( v < 0.0 || u + v > 1.0 )
		return result;

	float t = f * dot( edge2, q );

	if( t > 1e-8 && t < result.dst ) {
		result.didHit = true;
		result.dst = t;
		result.hitPoint = ray.origin + t * ray.direction;

		// Interpolate normal using barycentric coordinates
		float w = 1.0 - u - v;
		result.normal = normalize( w * tri.normalA + u * tri.normalB + v * tri.normalC );

		// Interpolate UV coordinates
		result.uv = w * tri.uvA + u * tri.uvB + v * tri.uvC;

		// Set material index
		result.material = tri.material;
	}

	return result;
}

#if MAX_SPHERE_COUNT > 0
uniform Sphere spheres[ MAX_SPHERE_COUNT ];
#else
Sphere spheres[ 1 ];
#endif

HitInfo RaySphere( Ray ray, Sphere sphere ) {
	HitInfo hitInfo;
	hitInfo.didHit = false;

	vec3 oc = ray.origin - sphere.position;
	float a = dot( ray.direction, ray.direction );
	float b = 2.0 * dot( oc, ray.direction );
	float c = dot( oc, oc ) - sphere.radius * sphere.radius;
	float discriminant = b * b - 4.0 * a * c;

	if( discriminant > 0.0 ) {
		float t = ( - b - sqrt( discriminant ) ) / ( 2.0 * a );
		if( t > 0.0 ) {
			hitInfo.didHit = true;
			hitInfo.dst = t;
			hitInfo.hitPoint = ray.origin + t * ray.direction;
			hitInfo.normal = normalize( hitInfo.hitPoint - sphere.position );
			hitInfo.material = sphere.material;
		}
	}

	return hitInfo;
}

// Fast ray-AABB distance calculation with early exit optimization
float fastRayAABBDst( Ray ray, vec3 invDir, vec3 boxMin, vec3 boxMax ) {
	vec3 t1 = ( boxMin - ray.origin ) * invDir;
	vec3 t2 = ( boxMax - ray.origin ) * invDir;

	vec3 tMin = min( t1, t2 );
	vec3 tMax = max( t1, t2 );

	float dstNear = max( max( tMin.x, tMin.y ), tMin.z );
	float dstFar = min( min( tMax.x, tMax.y ), tMax.z );

	// Optimized early rejection - no need to check dstNear if dstFar is invalid
	return ( dstFar >= max( dstNear, 0.0 ) ) ? max( dstNear, 0.0 ) : 1e20;
}
