struct RayTracingMaterial {
	vec4 color;
	vec3 emissive;
	float emissiveIntensity;
	float roughness;
	float metalness;
	float ior;  // Index of refraction
	float transmission;  // 0 = opaque, 1 = fully transparent
	float thickness;
	float clearCoat;
	float clearCoatRoughness;
	int albedoMapIndex;
	int emissiveMapIndex;
	int normalMapIndex;
	int bumpMapIndex;
	int metalnessMapIndex;
	int roughnessMapIndex;
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
	vec3 normalA, normalB, normalC;
	RayTracingMaterial material;
	int materialIndex;
};

struct Pixel {
	vec4 color;
	float variance;
	int samples;
};
