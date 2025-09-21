
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
	float bumpScale;
	float displacementScale;
	int metalnessMapIndex;
	int roughnessMapIndex;
	int displacementMapIndex;
	vec2 normalScale;
	mat3 albedoTransform;
	mat3 emissiveTransform;
	mat3 normalTransform;
	mat3 bumpTransform;
	mat3 metalnessTransform;
	mat3 roughnessTransform;
	mat3 displacementTransform;
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
	int materialIndex;
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

struct DirectionSample {
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


struct ImportanceSamplingInfo {
	float diffuseImportance;
	float specularImportance;
	float transmissionImportance;
	float clearcoatImportance;
	float envmapImportance;
};

struct DotProducts {
    float NoL; // Normal • Light
    float NoV; // Normal • View
    float NoH; // Normal • Half
    float VoH; // View • Half
    float LoH; // Light • Half
	float VoN; // View • Normal
};

struct MaterialSamples {
    vec4 albedo;
    vec3 emissive;
    float metalness;
    float roughness;
    vec3 normal;
    bool hasTextures;
};

struct MaterialClassification {
    bool isMetallic;        // metalness > 0.7
    bool isRough;          // roughness > 0.8  
    bool isSmooth;         // roughness < 0.3
    bool isTransmissive;   // transmission > 0.5
    bool hasClearcoat;     // clearcoat > 0.5
    bool isEmissive;       // has emissive contribution
    float complexityScore; // 0-1 score for material complexity
};

struct UVCache {
	vec2 albedoUV;
	vec2 normalUV;
	vec2 metalnessUV;
	vec2 emissiveUV;
	vec2 bumpUV;
	vec2 roughnessUV;

	// Redundancy flags
	bool normalBumpSameUV;
	bool metalRoughSameUV;
	bool albedoEmissiveSameUV;
	bool allSameUV;
};

// Enhanced material cache
struct MaterialCache {
    vec3 F0;                    // Base reflectance
    float NoV;                  // Normal dot View
    vec3 diffuseColor;          // Precomputed diffuse color
    vec3 specularColor;         // Precomputed specular color
    bool isMetallic;            // metalness > 0.7
    bool isPurelyDiffuse;       // Optimized path flag
    bool hasSpecialFeatures;    // Has transmission, clearcoat, etc.
    float alpha;                // roughness squared
    float k;                    // Geometry term constant
    float alpha2;               // roughness to the fourth power
    MaterialSamples texSamples; // Texture samples

    // BRDF optimization: precomputed shared values
    float invRoughness;         // 1.0 - roughness
    float metalFactor;          // 0.5 + 0.5 * metalness
    float iorFactor;            // min(2.0 / ior, 1.0)
    float maxSheenColor;        // max component of sheen color
};

// Update PathState to include texture samples
struct PathState {
    BRDFWeights brdfWeights;              // Cached BRDF weights
	ImportanceSamplingInfo samplingInfo;   // Cached importance sampling info
	MaterialCache materialCache;           // Cached material properties
	MaterialClassification materialClass;  // Cached material classification
	bool weightsComputed;                  // Flag to track if weights are computed
	bool texturesLoaded;                   // Flag to track if textures are loaded
	bool classificationCached;             // Flag for material classification
	bool materialCacheCached;              // Flag for material cache creation
	float pathImportance;                  // Cached path importance estimate
	int lastMaterialIndex;                 // Track material changes to preserve cache
};

struct SamplingStrategyWeights {
    float envWeight;
    float specularWeight;
    float diffuseWeight;
    float transmissionWeight;
    float clearcoatWeight;
    float totalWeight;

    bool useEnv;
    bool useSpecular;
    bool useDiffuse;
    bool useTransmission;
    bool useClearcoat;
};
