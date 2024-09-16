uniform vec3 directionalLightDirection;
uniform vec3 directionalLightColor;
uniform float directionalLightIntensity;

struct DirectionalLight {
    vec3 direction;
    vec3 color;
    float intensity;
};

float powerHeuristic(float pdfA, float pdfB) {
    float a = pdfA * pdfA;
    float b = pdfB * pdfB;
    return a / (a + b);
}


// vec3 evaluateBRDF(vec3 V, vec3 L, vec3 N, RayTracingMaterial material) {
//     vec3 H = normalize(L + V);
//     float NdotV = max(dot(N, V), 0.0);
//     float NdotL = max(dot(N, L), 0.0);
//     float NdotH = max(dot(N, H), 0.0);
//     float HdotV = max(dot(H, V), 0.0);

//     vec3 F0 = mix(vec3(0.04), material.color.rgb, material.metalness);
//     vec3 F = fresnelSchlick3(HdotV, F0);

//     float D = DistributionGGX(N, H, material.roughness);
//     float G = GeometrySmith(N, V, L, material.roughness);

//     vec3 numerator = D * G * F;
//     float denominator = 4.0 * NdotV * NdotL + 0.0001;
//     vec3 specular = numerator / denominator;

//     vec3 kS = F;
//     vec3 kD = (1.0 - kS) * (1.0 - material.metalness);

//     vec3 diffuse = kD * material.color.rgb / PI;

//     return diffuse + specular;
// }

vec3 calculateDirectLightingMIS(HitInfo hitInfo, vec3 V, vec3 L, vec3 brdf, float brdfPdf, inout ivec2 stats) {
    if (directionalLightIntensity <= 0.0) return vec3(0.0);

    vec3 N = hitInfo.normal;
    vec3 lightDir = normalize(-directionalLightDirection);
    float NoL = max(dot(N, lightDir), 0.0);
    
    if (NoL <= 0.0) return vec3(0.0);

    // Check for shadows
    Ray shadowRay;
    shadowRay.origin = hitInfo.hitPoint + N * 0.001; // Offset to avoid self-intersection
    shadowRay.direction = lightDir;
    HitInfo shadowHit = traverseBVH(shadowRay, stats);
    
    if (shadowHit.didHit) {
        return vec3(0.0); // Point is in shadow
    }

    // Light sampling contribution
    vec3 lightContribution = directionalLightColor * directionalLightIntensity;
    float lightPdf = 1.0; // For directional light, PDF is always 1

    // Evaluate BRDF for the light direction
    vec3 brdfValue = evaluateBRDF(V, lightDir, N, hitInfo.material);

    // MIS weight for light sampling
    float misWeightLight = powerHeuristic(lightPdf, brdfPdf);

    vec3 lightSampleContribution = lightContribution * brdfValue * NoL * misWeightLight / lightPdf;

    // BRDF sampling contribution
    float NoL_brdf = max(dot(N, L), 0.0);
    vec3 brdfSampleContribution = vec3(0.0);

    if (NoL_brdf > 0.0 && brdfPdf > 0.0) {
        // Check if the BRDF sample direction hits the light
        float alignment = dot(L, lightDir);
        if (alignment > 0.99) { // Allow for some tolerance due to floating-point precision
            // MIS weight for BRDF sampling
            float misWeightBRDF = powerHeuristic(brdfPdf, lightPdf);
            brdfSampleContribution = lightContribution * brdf * NoL_brdf * misWeightBRDF / brdfPdf;
        }
    }

    return lightSampleContribution + brdfSampleContribution;
}