
struct Ray {
	vec3 origin;
	vec3 direction;
};

struct RayTracingMaterial {
	vec4 color;
	vec3 emissive;
	float emissiveIntensity;
	float roughness;
	float metalness;
	float ior;  // Index of refraction
	float transmission;  // 0 = opaque, 1 = fully transparent
	float thickness;
	float clearcoat;
	float clearcoatRoughness;
	float opacity;
	bool transparent;
	vec3 attenuationColor;
	float attenuationDistance;
	float dispersion;
	float sheen;
	float sheenRoughness;
	vec3 sheenColor;
	float specularIntensity;
	vec3 specularColor;
	float alphaTest;
	int alphaMode;      // 0: OPAQUE, 1: MASK, 2: BLEND
	int side;
	int depthWrite;
	bool visible;
	int albedoMapIndex;
	int emissiveMapIndex;
	int normalMapIndex;
	int bumpMapIndex;
	int metalnessMapIndex;
	int roughnessMapIndex;
	vec2 normalScale;
	mat3 albedoTransform;
	mat3 emissiveTransform;
	mat3 normalTransform;
	mat3 bumpTransform;
	mat3 metalnessTransform;
	mat3 roughnessTransform;
	float iridescence;
	float iridescenceIOR;
	vec2 iridescenceThicknessRange;
};

struct Sphere {
	vec3 position;
	float radius;
	RayTracingMaterial material;
};

struct EquirectHdrInfo {

	sampler2D marginalWeights;
	sampler2D conditionalWeights;
	sampler2D map;

	float totalSum;

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
    float padding;
};

struct Pixel {
	vec4 color;
	int samples;
};

struct BRDFSample {
	vec3 direction;   // Sampled direction
	vec3 value;       // BRDF value
	float pdf;        // Probability density
};

struct BRDFWeights {
	float specular;
	float diffuse;
	float sheen;
	float clearcoat;
	float transmission;
	float iridescence;
};

struct DotProducts {
    float NoL; // Normal • Light
    float NoV; // Normal • View
    float NoH; // Normal • Half
    float VoH; // View • Half
    float LoH; // Light • Half
};
