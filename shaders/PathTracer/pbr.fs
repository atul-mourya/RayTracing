uniform sampler2DArray diffuseTextures;

vec3 sampleAlbedoTexture(RayTracingMaterial material, vec2 uv) {
    int textureIndex = material.map;
    if (textureIndex >= 0) {
        return sRGBToLinear(texture(diffuseTextures, vec3(uv, float(textureIndex))).rgb);
    }
    return material.color;
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