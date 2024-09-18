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
        material.color *= vec4( sRGBToLinear(albedo.rgb), albedo.a);
        // if( material.color.r < 0.001 ) material.color.r += 0.01;
        // if( material.color.g < 0.001 ) material.color.g += 0.01;
        // if( material.color.b < 0.001 ) material.color.b += 0.01;
    }
    return material.color;
}

float sampleMetalnessMap(RayTracingMaterial material, vec2 uv) {
    if (material.metalnessMapIndex >= 0) {
        material.metalness *= sampleMap(metalnessMaps, material.metalnessMapIndex, uv).b;
    }
    return material.metalness;
}

float sampleRoughnessMap(RayTracingMaterial material, vec2 uv) {
    if (material.roughnessMapIndex >= 0) {
        material.roughness *= sampleMap(roughnessMaps, material.roughnessMapIndex, uv).g;
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

vec3 ImportanceSampleGGX(vec3 N, float roughness, vec2 Xi) {

    float alpha = roughness * roughness;
    float alpha2 = alpha * alpha;
	
    float phi = 2.0 * PI * Xi.x;
    float cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (alpha2 - 1.0) * Xi.y));
    float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
	
    // from spherical coordinates to cartesian coordinates
    vec3 H;
    H.x = cos(phi) * sinTheta;
    H.y = sin(phi) * sinTheta;
    H.z = cosTheta;
	
    // from tangent-space vector to world-space sample vector
    vec3 up        = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangent   = normalize(cross(up, N));
    vec3 bitangent = cross(N, tangent);
	
    vec3 sampleVec = tangent * H.x + bitangent * H.y + N * H.z;
    return normalize(sampleVec);
} 

vec3 fresnel(vec3 f0, float NoV, float roughness) {
    return f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - NoV, 5.0);
}

float fresnelSchlick(float cosTheta, float F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

vec3 fresnelSchlick3(float cosTheta, vec3 F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

float luminance( vec3 color ) {

	// https://en.wikipedia.org/wiki/Relative_luminance
	return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

}

float DistributionGGX(vec3 N, vec3 H, float roughness) {

    float alpha = roughness * roughness;
    float alpha2 = alpha * alpha;

    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH * NdotH;

    float nom   = alpha2;
    float denom = (NdotH2 * (alpha2 - 1.0) + 1.0);
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

vec3 evaluateBRDF(vec3 V, vec3 L, vec3 N, RayTracingMaterial material) {
    vec3 H = normalize(V + L);
    float NoL = max(dot(N, L), 0.001);
    float NoV = max(dot(N, V), 0.001);
    float NoH = max(dot(N, H), 0.001);
    float VoH = max(dot(V, H), 0.001);

    vec3 F0 = mix(vec3(0.04), material.color.rgb, material.metalness);

    // Specular BRDF
    float D = DistributionGGX(N, H, material.roughness);
    float G = GeometrySmith(N, V, L, material.roughness);
    vec3 F = fresnelSchlick3(VoH, F0);
    vec3 specular = (D * G * F) / (4.0 * NoV * NoL);

    // Diffuse BRDF
    vec3 diffuse = material.color.rgb * (1.0 - material.metalness) / PI;

    return diffuse + specular;
}