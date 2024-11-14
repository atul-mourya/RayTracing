#if MAX_DIRECTIONAL_LIGHTS > 0
uniform float directionalLights[MAX_DIRECTIONAL_LIGHTS * 7]; // 7 values per light;
#else
uniform float directionalLights[1]; // Dummy array to avoid compilation error
#endif

struct AreaLight {
    vec3 position;
    vec3 u; // First axis of the rectangular light
    vec3 v; // Second axis of the rectangular light
    vec3 color;
    float intensity;
};

#if MAX_AREA_LIGHTS > 0
uniform float areaLights[MAX_AREA_LIGHTS * 13]; // 13 values per light;
#else
uniform float areaLights[1]; // Dummy array to avoid compilation error
#endif

struct DirectionalLight {
    vec3 direction;
    vec3 color;
    float intensity;
};

DirectionalLight getDirectionalLight(int index) {
    int baseIndex = index * 7;
    DirectionalLight light;
    light.direction = vec3(
        directionalLights[baseIndex],
        directionalLights[baseIndex + 1],
        directionalLights[baseIndex + 2]
    );
    light.color = vec3(
        directionalLights[baseIndex + 3],
        directionalLights[baseIndex + 4],
        directionalLights[baseIndex + 5]
    );
    light.intensity = directionalLights[baseIndex + 6];
    return light;
}

AreaLight getAreaLight(int index) {
    
    int baseIndex = index * 13;
    AreaLight light;
    light.position = vec3(
        areaLights[baseIndex],
        areaLights[baseIndex + 1],
        areaLights[baseIndex + 2]
    );
    light.u = vec3(
        areaLights[baseIndex + 3],
        areaLights[baseIndex + 4],
        areaLights[baseIndex + 5]
    );
    light.v = vec3(
        areaLights[baseIndex + 6],
        areaLights[baseIndex + 7],
        areaLights[baseIndex + 8]
    );
    light.color = vec3(
        areaLights[baseIndex + 9],
        areaLights[baseIndex + 10],
        areaLights[baseIndex + 11]
    );
    light.intensity = areaLights[baseIndex + 12];

    return light;
}

vec3 sampleAreaLight(AreaLight light, vec2 xi, out vec3 lightPos, out float pdf) {
    vec3 randomPos = light.position + light.u * (xi.x - 0.5) + light.v * (xi.y - 0.5);
    lightPos = randomPos;
    vec3 lightArea = cross(light.u, light.v);
    float area = length(lightArea);
    pdf = 1.0 / area;
    return normalize(lightPos);
}

vec3 evaluateAreaLight(AreaLight light, vec3 hitPoint, vec3 lightDir, float lightDistance) {
    float cosTheta = dot(lightDir, cross(light.u, light.v));
    if (cosTheta <= 0.0) return vec3(0.0);
    float falloff = 1.0 / (lightDistance * lightDistance);
    return light.color * light.intensity * falloff * cosTheta;
}

bool isPointInShadow( vec3 point, vec3 normal, vec3 lightDir, inout ivec2 stats ) {
	Ray shadowRay;
	shadowRay.origin = point + normal * 0.001; // shadow bais or Offset to avoid self-intersection
	shadowRay.direction = lightDir;
	HitInfo shadowHit = traverseBVH( shadowRay, stats );
	return shadowHit.didHit;
}

bool pointInRectangle(vec3 point, vec3 center, vec3 u, vec3 v) {
    vec3 d = point - center;
    float projU = dot(d, normalize(u));
    float projV = dot(d, normalize(v));
    return abs(projU) <= length(u) && abs(projV) <= length(v);
}

vec3 calculateDirectLightingMIS(HitInfo hitInfo, vec3 V, vec3 sampleDir, vec3 brdfValue, float brdfPdf, inout uint rngState, inout ivec2 stats) {
    vec3 totalLighting = vec3(0.0);
    vec3 N = hitInfo.normal;

    // Directional light calculations
    for (int i = 0; i < MAX_DIRECTIONAL_LIGHTS / 7; i++) {
        DirectionalLight light = getDirectionalLight(i);
        
        if (light.intensity <= 0.0) continue;

        vec3 L = normalize(light.direction);
        float NoL = max(dot(N, L), 0.0);

        // check if light coming from behind
        if (NoL <= 0.0) continue;

        // Check for shadows
        if (isPointInShadow(hitInfo.hitPoint, N, L, stats)) continue;

        vec3 lightContribution = light.color * light.intensity * PI;

        // Evaluate BRDF for the light direction
        vec3 brdfValueForLight = evaluateBRDF(V, L, N, hitInfo.material);
        float misWeightLight = powerHeuristic(1.0, brdfPdf);
        vec3 lightSampleContribution = lightContribution * brdfValueForLight * NoL * misWeightLight;

        // BRDF sampling contribution
        float NoL_brdf = max(dot(N, sampleDir), 0.0);
        vec3 brdfSampleContribution = vec3(0.0);
        if (NoL_brdf > 0.0 && brdfPdf > 0.0) {
            // Check if the BRDF sample direction hits the light
            float alignment = dot(sampleDir, L);
            if (alignment > 0.9) { // Allow for some tolerance due to floating-point precision
                // MIS weight for BRDF sampling
                float misWeightBRDF = powerHeuristic(brdfPdf, 1.0);
                brdfSampleContribution = lightContribution * brdfValue * NoL_brdf * misWeightBRDF / brdfPdf;
            }
        }

        totalLighting += lightSampleContribution + brdfSampleContribution;
        
    }

    #if MAX_AREA_LIGHTS > 0
    // Area light calculations
    for (int i = 0; i < MAX_AREA_LIGHTS / 13 ; i++) {
        AreaLight light = getAreaLight(i);
        // return normalize(light.color);
        
        vec3 lightPos;
        float lightPdf;
        vec2 xi = getRandomSample(gl_FragCoord.xy, i, 0, rngState, 6);
        vec3 L = sampleAreaLight(light, xi, lightPos, lightPdf);
        
        float NoL = max(dot(N, L), 0.0);
        if (NoL <= 0.0) continue;

        float lightDistance = length(lightPos - hitInfo.hitPoint);

        
        // Check for shadows
        if (isPointInShadow(hitInfo.hitPoint, N, L, stats)) continue;


        vec3 lightContribution = evaluateAreaLight(light, hitInfo.hitPoint, L, lightDistance);

        // Evaluate BRDF for the light direction
        vec3 brdfValueForLight = evaluateBRDF(V, L, N, hitInfo.material);
        float misWeightLight = powerHeuristic(lightPdf, brdfPdf);
        vec3 lightSampleContribution = lightContribution * brdfValueForLight * NoL * misWeightLight / lightPdf;

        // BRDF sampling contribution
        float NoL_brdf = max(dot(N, sampleDir), 0.0);
        vec3 brdfSampleContribution = vec3(0.0);
        if (NoL_brdf > 0.0 && brdfPdf > 0.0) {
            vec3 hitPointOnLight = hitInfo.hitPoint + sampleDir * lightDistance;
            if (pointInRectangle(hitPointOnLight, light.position, light.u, light.v)) {
                vec3 lightContributionBRDF = evaluateAreaLight(light, hitInfo.hitPoint, sampleDir, lightDistance);
                float misWeightBRDF = powerHeuristic(brdfPdf, lightPdf);
                brdfSampleContribution = lightContributionBRDF * brdfValue * NoL_brdf * misWeightBRDF / brdfPdf;
            }
        }

        vec3 finalContribution = lightSampleContribution + brdfSampleContribution;
        totalLighting += finalContribution;
    }
    #endif

    return totalLighting;
}
