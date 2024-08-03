uniform vec3 cameraPos;
uniform vec3 cameraDir;
uniform vec3 cameraRight;
uniform vec3 cameraUp;

struct Ray {
    vec3 origin;
    vec3 direction;
};

Ray generateRay(vec2 uv) {
	Ray ray;
	ray.origin = cameraPos;
	ray.direction = normalize(cameraDir + uv.x * cameraRight + uv.y * cameraUp);
	return ray;
}

// Calculate the intersection of a ray with a triangle using Möller-Trumbore algorithm
// Thanks to https://stackoverflow.com/a/42752998
HitInfo RayTriangle(Ray ray, Triangle tri) {
	vec3 edgeAB = tri.posB - tri.posA;
	vec3 edgeAC = tri.posC - tri.posA;
	vec3 normalVector = cross(edgeAB, edgeAC);
	vec3 ao = ray.origin - tri.posA;
	vec3 dao = cross(ao, ray.direction);

	float determinant = - dot(ray.direction, normalVector);
	float invDet = 1.0f / determinant;

    // Calculate distance to triangle & barycentric coordinates of intersection point
	float dst = dot(ao, normalVector) * invDet;
	float u = dot(edgeAC, dao) * invDet;
	float v = - dot(edgeAB, dao) * invDet;
	float w = 1.0f - u - v;

    // Initialize hit info
	HitInfo hitInfo;
	hitInfo.didHit = determinant >= 1E-6f && dst >= 0.0f && u >= 0.0f && v >= 0.0f && w >= 0.0f;
	hitInfo.hitPoint = ray.origin + ray.direction * dst;
	hitInfo.normal = normalize( tri.normal );
	hitInfo.dst = dst;
	hitInfo.material = tri.material;
	return hitInfo;
}

HitInfo RaySphere(Ray ray, Sphere sphere) {
	HitInfo hitInfo;
	hitInfo.didHit = false;

	vec3 oc = ray.origin - sphere.position;
	float a = dot(ray.direction, ray.direction);
	float b = 2.0f * dot(oc, ray.direction);
	float c = dot(oc, oc) - sphere.radius * sphere.radius;
	float discriminant = b * b - 4.0f * a * c;

	if(discriminant > 0.0f) {
		float t = (- b - sqrt(discriminant)) / (2.0f * a);
		if(t > 0.0f) {
			hitInfo.didHit = true;
			hitInfo.dst = t;
			hitInfo.hitPoint = ray.origin + t * ray.direction;
			hitInfo.normal = normalize(hitInfo.hitPoint - sphere.position);
			hitInfo.material = sphere.material;
		}
	}

	return hitInfo;
}


HitInfo RayIntersectsBox(Ray ray, vec3 minBB, vec3 maxBB) {
	HitInfo hitInfo;
	hitInfo.didHit = false;

	vec3 invDir = 1.0 / ray.direction;
	vec3 tMin = (minBB - ray.origin) * invDir;
	vec3 tMax = (maxBB - ray.origin) * invDir;
	vec3 t1 = min(tMin, tMax);
	vec3 t2 = max(tMin, tMax);
	float tNear = max(max(t1.x, t1.y), t1.z);
	float tFar = min(min(t2.x, t2.y), t2.z);

	if (tNear <= tFar && tFar > 0.0) {
		hitInfo.didHit = true;
		hitInfo.dst = tNear;
		hitInfo.hitPoint = ray.origin + tNear * ray.direction;
		hitInfo.normal = vec3(0.0); // Box normals can be calculated as needed
	}

	return hitInfo;
}

// Thanks to https://gist.github.com/DomNomNom/46bb1ce47f68d255fd5d
bool RayBoundingBox(Ray ray, vec3 boxMin, vec3 boxMax) {
	vec3 invDir = 1.0 / ray.direction;
	vec3 tMin = (boxMin - ray.origin) * invDir;
	vec3 tMax = (boxMax - ray.origin) * invDir;
	vec3 t1 = min(tMin, tMax);
	vec3 t2 = max(tMin, tMax);
	float tNear = max(max(t1.x, t1.y), t1.z);
	float tFar = min(min(t2.x, t2.y), t2.z);
	return tNear <= tFar;
}