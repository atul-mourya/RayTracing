struct RayTracingMaterial {
	vec3 color;
	vec3 emissive;
	float emissiveIntensity;
	float roughness;
	float metalness;
	int map;
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
	vec2 uv;
};

struct Triangle {
	vec3 posA, posB, posC;
	vec2 uvA, uvB, uvC;
	vec3 normal;
	RayTracingMaterial material;
	int materialIndex;
};