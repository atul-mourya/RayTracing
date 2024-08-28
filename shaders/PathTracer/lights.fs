
uniform vec3 directionalLightDirection;
uniform vec3 directionalLightColor;
uniform float directionalLightIntensity;


// Define a structure for directional lights
struct DirectionalLight {
    vec3 direction;
    vec3 color;
    float intensity;
};

// Function to get directional light data
vec3 calculateDirectLighting(HitInfo hitInfo, vec3 viewDirection, inout ivec2 stats) {
	if( directionalLightIntensity <= 0.0 ) return vec3(0.0);
    vec3 lightDir = normalize(-directionalLightDirection);
    float NdotL = max(dot(hitInfo.normal, lightDir), 0.0);
    
    // Check for shadows
    Ray shadowRay;
    shadowRay.origin = hitInfo.hitPoint + hitInfo.normal * 0.001; // Offset to avoid self-intersection
    shadowRay.direction = lightDir;
    HitInfo shadowHit = traverseBVH(shadowRay, stats);
    
    if (shadowHit.didHit) {
        return vec3(0.0); // Point is in shadow
    }
    
    // Calculate BRDF
    vec3 halfVector = normalize(lightDir + viewDirection);
    float NdotV = max(dot(hitInfo.normal, viewDirection), 0.0);
    
    vec3 F0 = mix(vec3(0.04), hitInfo.material.color, hitInfo.material.metalness);
    vec3 F = fresnel(F0, NdotV, hitInfo.material.roughness);
    
    float D = DistributionGGX(hitInfo.normal, halfVector, hitInfo.material.roughness);
    float G = GeometrySmith(hitInfo.normal, viewDirection, lightDir, hitInfo.material.roughness);
    
    vec3 numerator = D * G * F;
    float denominator = 4.0 * NdotV * NdotL + 0.0001;
    vec3 specular = numerator / denominator;
    
    vec3 kS = F;
    vec3 kD = vec3(1.0) - kS;
    kD *= 1.0 - hitInfo.material.metalness;
    
    vec3 diffuse = kD * hitInfo.material.color / PI;
    
    return (diffuse + specular) * directionalLightColor * directionalLightIntensity * NdotL;
}