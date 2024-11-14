uniform mat4 cameraWorldMatrix;
uniform mat4 cameraProjectionMatrixInverse;

uniform float focusDistance;
uniform float aperture;
uniform float focalLength;

struct Ray {
	vec3 origin;
	vec3 direction;
};

Ray generateRayFromCamera( vec2 screenPosition, inout uint rngState ) {
	vec4 rayStart = cameraProjectionMatrixInverse * vec4( screenPosition, - 1.0, 1.0 );
	vec4 rayEnd = cameraProjectionMatrixInverse * vec4( screenPosition, 1.0, 1.0 );

	rayStart /= rayStart.w;
	rayEnd /= rayEnd.w;

	vec4 worldStart = cameraWorldMatrix * rayStart;
	vec4 worldEnd = cameraWorldMatrix * rayEnd;

	vec3 rayOrigin = worldStart.xyz;
	vec3 rayDirection = normalize( worldEnd.xyz - worldStart.xyz );

	// Calculate the focal point
	vec3 focalPoint = rayOrigin + rayDirection * ( focusDistance * 1000.0 ); // Convert meters to mm

    // Calculate aperture diameter from focal length and f-number
	float apertureSize = focalLength / aperture;

	// Generate a random point on the lens
	vec3 lensOffset = RandomPointInCircle3( rngState ) * ( apertureSize * 0.5 );
	vec3 newRayOrigin = rayOrigin + ( cameraWorldMatrix * vec4( lensOffset, 0.0 ) ).xyz;

	// Calculate the new ray direction
	vec3 newRayDirection = normalize( focalPoint - newRayOrigin );

	Ray ray;
	ray.origin = newRayOrigin;
	ray.direction = newRayDirection;

	return ray;
}

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

HitInfo RayIntersectsBox( Ray ray, vec3 minBB, vec3 maxBB ) {
	HitInfo hitInfo;
	hitInfo.didHit = false;

	vec3 invDir = 1.0 / ray.direction;
	vec3 tMin = ( minBB - ray.origin ) * invDir;
	vec3 tMax = ( maxBB - ray.origin ) * invDir;
	vec3 t1 = min( tMin, tMax );
	vec3 t2 = max( tMin, tMax );
	float tNear = max( max( t1.x, t1.y ), t1.z );
	float tFar = min( min( t2.x, t2.y ), t2.z );

	if( tNear <= tFar && tFar > 0.0 ) {
		hitInfo.didHit = true;
		hitInfo.dst = tNear;
		hitInfo.hitPoint = ray.origin + tNear * ray.direction;
		hitInfo.normal = vec3( 0.0 ); // Box normals can be calculated as needed
	}

	return hitInfo;
}

// Thanks to https://gist.github.com/DomNomNom/46bb1ce47f68d255fd5d
bool RayBoundingBox( Ray ray, vec3 boxMin, vec3 boxMax ) {
	vec3 invDir = 1.0 / ray.direction;
	vec3 tMin = ( boxMin - ray.origin ) * invDir;
	vec3 tMax = ( boxMax - ray.origin ) * invDir;
	vec3 t1 = min( tMin, tMax );
	vec3 t2 = max( tMin, tMax );
	float tNear = max( max( t1.x, t1.y ), t1.z );
	float tFar = min( min( t2.x, t2.y ), t2.z );
	return tNear <= tFar;
}

float RayBoundingBoxDst( Ray ray, vec3 boxMin, vec3 boxMax ) {
	vec3 invDir = 1.0 / ray.direction;
	vec3 tMin = ( boxMin - ray.origin ) * invDir;
	vec3 tMax = ( boxMax - ray.origin ) * invDir;
	vec3 t1 = min( tMin, tMax );
	vec3 t2 = max( tMin, tMax );
	float dstNear = max( max( t1.x, t1.y ), t1.z );
	float dstFar = min( min( t2.x, t2.y ), t2.z );
	bool didHit = dstFar >= dstNear && dstFar > 0.0;
	return didHit ? dstNear : 1e20; // 1e20 is almost infinite
}

bool intersectAABB( Ray ray, vec3 boxMin, vec3 boxMax, out float tMin, out float tMax ) {
	vec3 invDir = 1.0 / ray.direction;
	vec3 t0 = ( boxMin - ray.origin ) * invDir;
	vec3 t1 = ( boxMax - ray.origin ) * invDir;
	vec3 tNear = min( t0, t1 );
	vec3 tFar = max( t0, t1 );
	tMin = max( max( tNear.x, tNear.y ), tNear.z );
	tMax = min( min( tFar.x, tFar.y ), tFar.z );
	return tMax > tMin && tMax > 0.0;
}