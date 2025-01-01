#if MAX_DIRECTIONAL_LIGHTS > 0
uniform float directionalLights[ MAX_DIRECTIONAL_LIGHTS * 7 ]; // 7 values per light;
#else
uniform float directionalLights[ 1 ]; // Dummy array to avoid compilation error
#endif

struct AreaLight {
    vec3 position;
    vec3 u; // First axis of the rectangular light
    vec3 v; // Second axis of the rectangular light
    vec3 color;
    float intensity;
};

#if MAX_AREA_LIGHTS > 0
uniform float areaLights[ MAX_AREA_LIGHTS * 13 ]; // 13 values per light;
#else
uniform float areaLights[ 1 ]; // Dummy array to avoid compilation error
#endif

uniform float globalIlluminationIntensity;

struct DirectionalLight {
    vec3 direction;
    vec3 color;
    float intensity;
};

DirectionalLight getDirectionalLight( int index ) {
    int baseIndex = index * 7;
    DirectionalLight light;
    light.direction = vec3( directionalLights[ baseIndex ], directionalLights[ baseIndex + 1 ], directionalLights[ baseIndex + 2 ] );
    light.color = vec3( directionalLights[ baseIndex + 3 ], directionalLights[ baseIndex + 4 ], directionalLights[ baseIndex + 5 ] );
    light.intensity = directionalLights[ baseIndex + 6 ];
    return light;
}

AreaLight getAreaLight( int index ) {

    int baseIndex = index * 13;
    AreaLight light;
    light.position = vec3( areaLights[ baseIndex ], areaLights[ baseIndex + 1 ], areaLights[ baseIndex + 2 ] );
    light.u = vec3( areaLights[ baseIndex + 3 ], areaLights[ baseIndex + 4 ], areaLights[ baseIndex + 5 ] );
    light.v = vec3( areaLights[ baseIndex + 6 ], areaLights[ baseIndex + 7 ], areaLights[ baseIndex + 8 ] );
    light.color = vec3( areaLights[ baseIndex + 9 ], areaLights[ baseIndex + 10 ], areaLights[ baseIndex + 11 ] );
    light.intensity = areaLights[ baseIndex + 12 ];

    return light;
}

vec3 sampleAreaLight( AreaLight light, vec2 xi, out vec3 lightPos, out float pdf ) {
    vec3 randomPos = light.position + light.u * ( xi.x - 0.5 ) + light.v * ( xi.y - 0.5 );
    lightPos = randomPos;
    vec3 lightArea = cross( light.u, light.v );
    float area = length( lightArea );
    pdf = 1.0 / area;
    return normalize( lightPos );
}

vec3 evaluateAreaLight( AreaLight light, vec3 hitPoint, vec3 lightDir, float lightDistance ) {
    float cosTheta = dot( lightDir, cross( light.u, light.v ) );
    if( cosTheta <= 0.0 )
        return vec3( 0.0 );

    // Calculate actual area of the light
    vec3 lightArea = cross( light.u, light.v );
    float area = length( lightArea );

    // Physical light falloff
    float falloff = area / ( 4.0 * PI * lightDistance * lightDistance );

    // Convert light intensity from lumens to radiance
    // Typical LED bulb: 800-1600 lumens
    // Conversion factor: ~1/683 watts per lumen for white light
    float radianceScale = 1.0 / 683.0;

    return light.color * ( light.intensity * radianceScale ) * falloff * cosTheta;
}

bool isPointInShadow(vec3 point, vec3 normal, vec3 lightDir, inout ivec2 stats) {
    Ray shadowRay;
    shadowRay.origin = point + normal * 0.001; // shadow bias
    shadowRay.direction = lightDir;
    
    float opacity = 0.0;
    const int MAX_SHADOW_STEPS = 32; // Limit shadow ray bounces
    uint rngState = uint(gl_FragCoord.x + gl_FragCoord.y * 1024.0); // Initialize RNG state
    
    for(int i = 0; i < MAX_SHADOW_STEPS; i++) {
        HitInfo shadowHit = traverseBVH(shadowRay, stats);
        
        if(!shadowHit.didHit) {
            return false; // Ray reached light without being fully blocked
        }
        
        // Handle transparent and transmissive materials
        if(shadowHit.material.transparent || shadowHit.material.transmission > 0.0) {
            float materialOpacity;
            vec3 newDirection;
            
            if(shadowHit.material.transmission > 0.0) {
                // Use the transmission utilities for consistent handling
                bool entering = dot(shadowRay.direction, shadowHit.normal) < 0.0;
                TransmissionResult transResult = handleTransmission(
                    shadowRay.direction,
                    shadowHit.normal,
                    shadowHit.material,
                    entering,
                    rngState
                );
                
                // Update shadow ray direction
                newDirection = transResult.direction;
                
                // Calculate effective opacity based on transmission result
                float transmissionFactor = length(transResult.throughput) / 3.0;
                materialOpacity = 1.0 - (shadowHit.material.transmission * transmissionFactor);
            } else {
                // Handle regular transparency
                materialOpacity = shadowHit.material.transparent ? 
                                shadowHit.material.opacity : 
                                1.0;
                newDirection = shadowRay.direction;
            }
            
            // Apply material's alpha if using alpha texture
            if(shadowHit.material.alphaMode != 0) {
                materialOpacity *= shadowHit.material.color.a;
            }
            
            // Accumulate opacity
            opacity += materialOpacity * (1.0 - opacity);
            
            if(opacity >= 0.99) {
                return true; // Effectively opaque
            }
            
            // Continue ray with potentially modified direction
            shadowRay.origin = shadowHit.hitPoint + newDirection * 0.001;
            shadowRay.direction = newDirection;
            continue;
        }
        
        // Opaque material hit
        return true;
    }
    
    // If we've exceeded MAX_SHADOW_STEPS, consider it shadowed if accumulated opacity is high enough
    return opacity >= 0.99;
}

bool pointInRectangle( vec3 point, vec3 center, vec3 u, vec3 v ) {
    vec3 d = point - center;
    float projU = dot( d, normalize( u ) );
    float projV = dot( d, normalize( v ) );
    return abs( projU ) <= length( u ) && abs( projV ) <= length( v );
}

vec3 calculateDirectLightingMIS( HitInfo hitInfo, vec3 V, BRDFSample brdfSample, inout uint rngState, inout ivec2 stats ) {
    vec3 totalLighting = vec3( 0.0 );
    vec3 N = hitInfo.normal;

    // Pre-compute shadow ray origin
    vec3 shadowOrigin = hitInfo.hitPoint + N * 0.001;

    // Directional lights
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS / 7; i ++ ) {
        DirectionalLight light = getDirectionalLight( i );

        if( light.intensity <= 0.0 )
            continue;

        vec3 L = normalize( light.direction );
        float NoL = dot( N, L );

        // check if light coming from behind
        if( NoL <= 0.0 )
            continue;

        // Check for shadows
        if( isPointInShadow( shadowOrigin, N, L, stats ) )
            continue;

        // Physical sun intensity with atmospheric effects
        // Base solar irradiance: ~1000 W/m²
        // Typical clear sky transmittance: ~70%
        // Additional atmospheric scattering: ~50%
        float baseIrradiance = 1000.0;  // W/m²
        float atmosphericTransmittance = 0.7;  // Clear sky
        float scatteringFactor = 0.5;   // Account for scatter
        float adjustmentScale = 0.1;  // Scale factor to adjust intensity

        float sunIrradiance = baseIrradiance * atmosphericTransmittance * scatteringFactor;
        vec3 lightContribution = light.color * ( light.intensity * sunIrradiance ) * adjustmentScale;

        vec3 brdfValueForLight = evaluateBRDF( V, L, N, hitInfo.material );

        // MIS weights
        float lightPdf = 1.0; // Directional light has uniform PDF
        float misWeightLight = powerHeuristic( lightPdf, brdfSample.pdf );
        float misWeightBRDF = powerHeuristic( brdfSample.pdf, lightPdf );

        // Combine contributions
        totalLighting += lightContribution * brdfValueForLight * NoL * misWeightLight;

        // Add BRDF sampling contribution
        // Check if the BRDF sample direction hits the light
        float alignment = dot( brdfSample.direction, L );
        if( alignment > 0.99 && brdfSample.pdf > 0.0 ) {
            totalLighting += lightContribution * brdfSample.value * NoL * misWeightBRDF / max( brdfSample.pdf, 0.001 );
        }
    }

    #if MAX_AREA_LIGHTS > 0
    for( int i = 0; i < MAX_AREA_LIGHTS / 13; i ++ ) {
        AreaLight light = getAreaLight( i );
        // return normalize(light.color);

        if( light.intensity <= 0.0 )
            continue;

        vec3 lightPos;
        float lightPdf;
        vec2 xi = getRandomSample( gl_FragCoord.xy, i, 0, rngState, 6 );
        vec3 L = sampleAreaLight( light, xi, lightPos, lightPdf );

        float NoL = dot( N, L );
        if( NoL <= 0.0 )
            continue;

        if( isPointInShadow( shadowOrigin, N, L, stats ) )
            continue;

        float lightDistance = length( lightPos - hitInfo.hitPoint );
        vec3 lightContribution = evaluateAreaLight( light, hitInfo.hitPoint, L, lightDistance );

        // MIS weights
        float misWeightLight = powerHeuristic( lightPdf, brdfSample.pdf );
        float misWeightBRDF = powerHeuristic( brdfSample.pdf, lightPdf );

        // Light sampling contribution
        totalLighting += lightContribution * evaluateBRDF( V, L, N, hitInfo.material ) * NoL * misWeightLight / max( lightPdf, 0.001 );

        // BRDF sampling contribution
        vec3 hitPointOnLight = hitInfo.hitPoint + brdfSample.direction * lightDistance;
        if( pointInRectangle( hitPointOnLight, light.position, light.u, light.v ) ) {
            vec3 brdfLightContribution = evaluateAreaLight( light, hitInfo.hitPoint, brdfSample.direction, lightDistance );
            totalLighting += brdfLightContribution * brdfSample.value * NoL * misWeightBRDF / max( brdfSample.pdf, 0.001 );
        }
    }
    #endif

    return totalLighting;
}

struct IndirectLightingResult {
    vec3 direction;
    vec3 throughput;
};

IndirectLightingResult calculateIndirectLighting( vec3 V, vec3 N, RayTracingMaterial material, BRDFSample brdfSample, int sampleIndex, int bounceIndex, inout uint rngState ) {
    // Sample cosine-weighted direction
    vec2 indirectSample = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex + 1, rngState, - 1 );

    // Get material-based importance for sampling strategy selection
    float materialImportance = getMaterialImportance( material );

    // Sample environment map
    EnvMapSample envSample = sampleEnvironmentMap( indirectSample );

    // Three-way sampling strategy selection
    float rand = RandomValue( rngState );
    float envWeight = enableEnvironmentLight ? 0.3 : 0.0;
    float brdfWeight = materialImportance * 0.7;
    float cosineWeight = 1.0 - envWeight - brdfWeight;

    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdf;

    if( rand < envWeight && envSample.pdf > 0.0 ) {
        // Use environment map sample
        sampleDir = envSample.direction;
        samplePdf = envSample.pdf;
        sampleBrdf = evaluateBRDF( V, sampleDir, N, material );
    } else if( rand < envWeight + brdfWeight ) {
        // Use BRDF sample
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdf = brdfSample.value;
    } else {
        // Use cosine-weighted sample
        sampleDir = cosineWeightedSample( N, indirectSample );
        samplePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );
        sampleBrdf = evaluateBRDF( V, sampleDir, N, material );
    }

    // Ensure PDFs are never zero
    samplePdf = max( samplePdf, 0.001 );
    float brdfPdf = max( brdfSample.pdf, 0.001 );
    float envPdf = enableEnvironmentLight ? max( calcEnvMapPdf( sampleDir ), 0.001 ) : 0.0;
    float cosinePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );

    // Calculate MIS weights using the power heuristic
    float misWeight = powerHeuristic( samplePdf, envPdf * envWeight +
        brdfPdf * brdfWeight +
        cosinePdf * cosineWeight );

    // Calculate final contribution
    float NoL = max( dot( N, sampleDir ), 0.0 );
    vec3 throughput = sampleBrdf * NoL * misWeight / samplePdf;

    // A surface can reflect more than 100% of incoming light in certain directions
    // due to the combination of BRDF and geometric terms
    float maxValue = 5.0; // Allow for higher energy concentration in certain directions
    throughput = clamp( throughput, vec3( 0.0 ), vec3( maxValue ) );
    throughput *= globalIlluminationIntensity;

    IndirectLightingResult result;
    result.direction = sampleDir;
    result.throughput = throughput;

    return result;
}