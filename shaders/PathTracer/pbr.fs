uniform sampler2DArray albedoMaps;
uniform sampler2DArray normalMaps;
uniform sampler2DArray bumpMaps;
uniform sampler2DArray metalnessMaps;
uniform sampler2DArray roughnessMaps;

vec4 sampleMap(sampler2DArray mapArray, int mapIndex, vec2 uv) {
    if (mapIndex >= 0) {
        return texture(mapArray, vec3(uv, float(mapIndex)));
    }
    return vec4(1.0);
}

vec4 sampleAlbedoTexture(RayTracingMaterial material, vec2 uv) {
    if (material.albedoMapIndex >= 0) {
        vec4 albedo = sampleMap(albedoMaps, material.albedoMapIndex, uv);
        return vec4(material.color * sRGBToLinear(albedo.rgb), albedo.a);
    }
    return vec4(material.color, 1.0);
}

float sampleMetalnessMap(RayTracingMaterial material, vec2 uv) {
    if (material.metalnessMapIndex >= 0) {
        return sampleMap(metalnessMaps, material.metalnessMapIndex, uv).r * material.metalness;
    }
    return material.metalness;
}

float sampleRoughnessMap(RayTracingMaterial material, vec2 uv) {
    if (material.roughnessMapIndex >= 0) {
        return sampleMap(roughnessMaps, material.roughnessMapIndex, uv).r * material.roughness;
    }
    return material.roughness;
}

vec3 perturbNormal(vec3 normal, vec3 tangent, vec3 bitangent, vec2 uv, RayTracingMaterial material) {
    vec3 resultNormal = normal;

    // Sample normal map
    if (material.normalMapIndex >= 0) {
        vec3 normalMap = sampleMap(normalMaps, material.normalMapIndex, uv).xyz * 2.0 - 1.0;
        mat3 TBN = mat3(tangent, bitangent, normal);
        resultNormal = normalize(TBN * normalMap);
    }
    
    // Apply bump mapping
    if (material.bumpMapIndex >= 0) {
        float bumpScale = 0.05; // Adjust this value to control the strength of the bump effect
        vec2 texelSize = 1.0 / vec2(textureSize(bumpMaps, 0).xy);
        
        float h0 = sampleMap(bumpMaps, material.bumpMapIndex, uv).r;
        float h1 = sampleMap(bumpMaps, material.bumpMapIndex, uv + vec2(texelSize.x, 0.0)).r;
        float h2 = sampleMap(bumpMaps, material.bumpMapIndex, uv + vec2(0.0, texelSize.y)).r;
        
        vec3 bumpNormal = normalize(vec3(h1 - h0, h2 - h0, bumpScale));
        resultNormal = normalize(resultNormal + bumpNormal);
    }
    
    return resultNormal;
}

vec3 sampleGGX(vec3 N, float roughness, vec2 Xi) {
    float a = roughness * roughness;
    float phi = 2.0 * PI * Xi.x;
    float cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (a*a - 1.0) * Xi.y));
    float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    
    vec3 H;
    H.x = sinTheta * cos(phi);
    H.y = sinTheta * sin(phi);
    H.z = cosTheta;
    
    vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangentX = normalize(cross(up, N));
    vec3 tangentY = cross(N, tangentX);
    
    return tangentX * H.x + tangentY * H.y + N * H.z;
}

vec3 fresnel(vec3 f0, float NoV, float roughness) {
    return f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - NoV, 5.0);
}

float luminance( vec3 color ) {

	// https://en.wikipedia.org/wiki/Relative_luminance
	return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

}

// Add these functions for BRDF calculations
float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a = roughness*roughness;
    float a2 = a*a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH*NdotH;

    float nom   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;

    return nom / denom;
}

float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r*r) / 8.0;

    float nom   = NdotV;
    float denom = NdotV * (1.0 - k) + k;

    return nom / denom;
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx2 = GeometrySchlickGGX(NdotV, roughness);
    float ggx1 = GeometrySchlickGGX(NdotL, roughness);

    return ggx1 * ggx2;
}