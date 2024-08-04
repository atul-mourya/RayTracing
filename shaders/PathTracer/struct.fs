struct RayTracingMaterial {
	vec3 color;
	vec3 emissive;
	float emissiveIntensity;
	float roughness;
	float metalness;
};

struct Sphere {
	vec3 position;
	float radius;
	RayTracingMaterial material;
};

struct HitInfo {
	bool didHit;
	float dst;
	vec3 hitPoint;
	vec3 normal;
	RayTracingMaterial material;
};

struct Triangle {
	vec3 posA, posB, posC;
	vec3 normal;
	RayTracingMaterial material;
};

struct MeshInfo {
	int firstTriangleIndex;
	int numTriangles;
	RayTracingMaterial material;
	vec3 boundsMin;
	vec3 boundsMax;
};