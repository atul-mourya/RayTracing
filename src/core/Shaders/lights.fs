#if MAX_DIRECTIONAL_LIGHTS > 0
uniform float directionalLights[ MAX_DIRECTIONAL_LIGHTS * 7 ];
#else
uniform float directionalLights[ 1 ]; // Dummy array to avoid compilation error
#endif

struct AreaLight {
    vec3 position;
    vec3 u; // First axis of the rectangular light
    vec3 v; // Second axis of the rectangular light
    vec3 color;
    float intensity;
    vec3 normal;
    float area;
};

#if MAX_AREA_LIGHTS > 0
uniform float areaLights[ MAX_AREA_LIGHTS * 13 ];
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
    light.normal = normalize( cross( light.u, light.v ) );
    light.area = length( cross( light.u, light.v ) );
    return light;
}

// Light record structure for better organization of light sampling data
struct LightRecord {
    vec3 direction;
    vec3 position;
    float pdf;
    vec3 emission;
    float area;
    bool didHit;
    int type;  // 0: directional, 1: area
};

LightRecord sampleAreaLight( AreaLight light, vec3 fromPoint, int sampleIndex, int bounceIndex, inout uint rngState ) {
    LightRecord record;

    // Early out for degenerate lights
    if( light.area < 1e-6 ) {
        record.didHit = false;
        return record;
    }

    // Light sampling strategy
    vec2 ruv = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, - 1 );
    // Generate random position on light surface
    vec3 lightPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );

    // Calculate vector to light and its properties
    vec3 toLight = lightPos - fromPoint;
    float dist = length( toLight );
    vec3 direction = toLight / dist;

    // Check if the light is facing the point
    // The light should emit in the opposite direction of its normal
    float lightAlignment = dot( direction, light.normal );
    if( lightAlignment > - 0.001 ) {  // Small epsilon to avoid precision issues
        record.didHit = false;
        return record;
    }

    // Calculate PDF following physical light principles
    float cosTheta = abs( lightAlignment );  // Use absolute value of alignment
    float distSq = dist * dist;
    float pdf = distSq / ( max( cosTheta * light.area, 1e-6 ) );

    record.direction = direction;
    record.position = lightPos;
    record.pdf = max( pdf, 0.001 );  // Avoid division by zero
    record.emission = light.color * light.intensity;
    record.area = light.area;
    record.didHit = true;
    record.type = 1;  // Area light type

    return record;
}

vec3 evaluateAreaLight( AreaLight light, LightRecord record ) {
    if( ! record.didHit )
        return vec3( 0.0 );

    float cosTheta = - dot( record.direction, light.normal );
    if( cosTheta <= 0.0 )
        return vec3( 0.0 );

    // Physical light falloff
    float distanceSqr = dot( record.position - light.position, record.position - light.position );
    float falloff = light.area / ( 4.0 * PI * distanceSqr );

    return record.emission * falloff * cosTheta;
}

float getMaterialTransparency(HitInfo shadowHit, Ray shadowRay, inout uint rngState) {
    // Check if the material has transmission (like glass)
    if (shadowHit.material.transmission > 0.0) {
        // Check if ray is entering or exiting the material
        bool isEntering = dot(shadowRay.direction, shadowHit.normal) < 0.0;
        
        // Get transmission data (color, direction changes due to refraction)
        TransmissionResult transResult = handleTransmission(
            shadowRay.direction,
            shadowHit.normal,
            shadowHit.material,
            isEntering,
            rngState
        );
        
        // Calculate how much light gets through
        // Average the RGB components of throughput (divide by 3.0)
        float transmissionFactor = length(transResult.throughput) / 3.0;
        
        // Calculate opacity: 1.0 minus (transmission * how much gets through)
        return 1.0 - (shadowHit.material.transmission * transmissionFactor);
    } 
    // If no transmission, check if it's transparent
    else if (shadowHit.material.transparent) {
        return shadowHit.material.opacity;
    }
    // If neither transmissive nor transparent, it's fully opaque
    else {
        return 1.0;
    }
}

bool isPointInShadow( vec3 point, vec3 normal, vec3 lightDir, uint rngState, inout ivec2 stats ) {
    
    float maxShadowDistance = 1000.0; // Maximum shadow distance
    Ray shadowRay;
    shadowRay.origin = point + normal * 0.001; // shadow bias
    shadowRay.direction = lightDir;

    // First quick check without transparency handling
    HitInfo shadowHit = traverseBVH( shadowRay, stats );

    // Fast path: if no hit or hit an opaque surface
    if( ! shadowHit.didHit )
        return false;
    if( shadowHit.didHit && length(shadowHit.hitPoint - point) > maxShadowDistance ) {
        return false;
    }
    if( ! shadowHit.material.transparent && shadowHit.material.transmission <= 0.0 )
        return true;

    // Complex path: handle transparent/transmissive materials
    float opacity = 0.0;
    const int MAX_SHADOW_STEPS = 16;

    for( int i = 0; i < MAX_SHADOW_STEPS; i ++ ) {
        if( opacity >= 0.99 )
            return true; // Early exit if accumulated opacity is high enough

        // Handle transparent and transmissive materials
        float materialOpacity = getMaterialTransparency(shadowHit, shadowRay, rngState);

        // Apply material's alpha
        if( shadowHit.material.alphaMode != 0 ) {
            materialOpacity *= shadowHit.material.color.a;
        }

        // Accumulate opacity with early exit check
        opacity += materialOpacity * ( 1.0 - opacity );
        if( opacity >= 0.99 )
            return true;

        // Continue ray
        shadowRay.origin = shadowHit.hitPoint + shadowRay.direction * 0.001;
        shadowHit = traverseBVH( shadowRay, stats );
        if( ! shadowHit.didHit )
            return false;
    }

    return opacity >= 0.99;
}

bool intersectRectangle( vec3 position, vec3 u, vec3 v, vec3 rayOrigin, vec3 rayDirection, out float dist ) {
    // Get light plane normal
    vec3 normal = normalize( cross( u, v ) );

    // Calculate intersection with light plane
    float denom = dot( normal, rayDirection );

    // Skip if ray is parallel to plane or facing away (backface)
    if( abs( denom ) < 1e-6 || denom > 0.0 ) {
        return false;
    }

    // Calculate intersection distance
    dist = dot( position - rayOrigin, normal ) / denom;

    // Skip if intersection is behind ray
    if( dist < 0.0 ) {
        return false;
    }

    // Calculate intersection point
    vec3 hitPoint = rayOrigin + rayDirection * dist;
    vec3 localPoint = hitPoint - position;

    // Project onto light's axes
    float projU = dot( localPoint, normalize( u ) );
    float projV = dot( localPoint, normalize( v ) );

    // Check if point is within rectangle bounds
    return abs( projU ) <= length( u ) && abs( projV ) <= length( v );
}

float calculateAreaLightVisibility(
    vec3 hitPoint,
    vec3 normal,
    AreaLight light,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {

    int SHADOW_SAMPLES = 4;
    float visibility = 0.0;

    // Calculate base importance
    float distanceToLight = length(light.position - hitPoint);
    float lightImportance = light.intensity / (distanceToLight * distanceToLight);
    
    // Adjust sample count (between 1-4 samples)
    SHADOW_SAMPLES = int(clamp(lightImportance * float(SHADOW_SAMPLES), 1.0, 4.0));

    // Pre-calculated common values
    vec3 shadowOrigin = hitPoint + normal * 0.001;
    vec3 centerToLight = light.position - shadowOrigin;
    float maxLightDist = length( centerToLight ) + length( light.u ) + length( light.v );

    // Use stratified sampling for better coverage
    for( int i = 0; i < SHADOW_SAMPLES; i ++ ) {
        vec2 ruv = getRandomSample( gl_FragCoord.xy, sampleIndex * SHADOW_SAMPLES + i, bounceIndex, rngState, - 1 );

        // Generate stratified position on light surface
        vec3 lightPos = light.position +
            light.u * ( ( ruv.x / float( SHADOW_SAMPLES ) + float( i % 2 ) / 2.0 ) - 0.5 ) +
            light.v * ( ( ruv.y / float( SHADOW_SAMPLES ) + float( i / 2 ) / 2.0 ) - 0.5 );

        vec3 toLight = lightPos - shadowOrigin;
        float lightDist = length( toLight );

        // Skip if beyond maximum possible distance
        if( lightDist > maxLightDist )
            continue;

        vec3 shadowDir = toLight / lightDist;
        float alignment = dot( shadowDir, light.normal );

        // Skip samples facing away from the light
        if( alignment > - 0.001 )
            continue;

        // Cast shadow ray with simplified transparency handling
        Ray shadowRay;
        shadowRay.origin = shadowOrigin;
        shadowRay.direction = shadowDir;

        float transmittance = 1.0;
        bool isShadowed = false;

        for( int step = 0; step < 8; step ++ ) { // Reduced from 16 steps
            HitInfo shadowHit = traverseBVH( shadowRay, stats );

            if( ! shadowHit.didHit || length( shadowHit.hitPoint - shadowOrigin ) > lightDist ) {
                // No hit or hit is beyond light - this sample is unoccluded
                break;
            }

            // Handle opaque objects with early exit
            if( ! shadowHit.material.transparent && shadowHit.material.transmission <= 0.0 ) {
                isShadowed = true;
                break;
            }

            // Handle transparent/transmissive materials
            float materialOpacity = shadowHit.material.transparent ? shadowHit.material.opacity : ( 1.0 - shadowHit.material.transmission );

            // Apply material's alpha if using alpha texture
            if( shadowHit.material.alphaMode != 0 ) {
                materialOpacity *= shadowHit.material.color.a;
            }

            // Accumulate transmittance
            transmittance *= ( 1.0 - materialOpacity );

            // Stop if accumulated opacity is too high
            if( transmittance < 0.01 ) {
                isShadowed = true;
                break;
            }

            shadowRay.origin = shadowHit.hitPoint + shadowDir * 0.001;
        }

        visibility += isShadowed ? 0.0 : transmittance;
    }

    return visibility / float( SHADOW_SAMPLES );
}

// Area light contribution calculation with MIS
vec3 calculateAreaLightContribution(
    AreaLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    BRDFSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    vec3 contribution = vec3( 0.0 );

    // Light sampling contribution
    LightRecord lightRecord = sampleAreaLight( light, hitPoint, sampleIndex, bounceIndex, rngState );

    if( lightRecord.didHit ) {
        float NoL = dot( normal, lightRecord.direction );

        if( NoL > 0.0 ) {
            // Calculate shadow visibility
            float visibility = calculateAreaLightVisibility( hitPoint, normal, light, sampleIndex, bounceIndex, rngState, stats );

            if( visibility > 0.0 ) {
                // Evaluate light and BRDF
                vec3 lightContribution = evaluateAreaLight( light, lightRecord );
                vec3 brdfValue = evaluateBRDF( viewDir, lightRecord.direction, normal, material );

                // MIS weight calculation
                float misWeightLight = powerHeuristic( lightRecord.pdf, brdfSample.pdf );
                contribution += lightContribution * brdfValue * NoL * misWeightLight * visibility / max( lightRecord.pdf, 0.001 );
            }
        }
    }

    // BRDF sampling contribution
    float dist;
    if( intersectRectangle( light.position, light.u, light.v, hitPoint, brdfSample.direction, dist ) ) {
        vec3 hitPos = hitPoint + brdfSample.direction * dist;

        LightRecord brdfRecord;
        brdfRecord.direction = brdfSample.direction;
        brdfRecord.position = hitPos;
        brdfRecord.emission = light.color * light.intensity;
        brdfRecord.didHit = true;

        // Calculate shadow visibility for BRDF sample
        float visibility = calculateAreaLightVisibility( hitPoint, normal, light, sampleIndex, bounceIndex, rngState, stats );

        if( visibility > 0.0 ) {
            float misWeightBRDF = powerHeuristic( brdfSample.pdf, lightRecord.pdf );
            vec3 brdfLightContribution = evaluateAreaLight( light, brdfRecord );
            contribution += brdfLightContribution * brdfSample.value * misWeightBRDF * visibility / max( brdfSample.pdf, 0.001 );
        }
    }

    return contribution;
}

struct LightSampleRec {
    vec3 direction;
    vec3 emission;
    float pdf;
    float dist;
    bool didHit;
    int type;  // 0: directional, 1: area
};

bool isDirectionValid( vec3 direction, vec3 normal, vec3 faceNormal ) {
    // Check if sample direction is valid relative to the surface
    // For non-transmissive materials, the light direction should be above the surface
    return dot( direction, faceNormal ) >= 0.0;
}

LightSampleRec sampleDirectionalLight( DirectionalLight light, vec3 hitPoint, vec3 normal, vec3 faceNormal ) {
    LightSampleRec rec;
    rec.direction = normalize( light.direction );
    rec.emission = light.color * light.intensity;
    rec.pdf = 1.0;  // Directional lights have uniform PDF
    rec.dist = 1e10; // Effectively infinite distance
    rec.type = 0;

    // Check if the light is facing the surface
    bool isSampleBelowSurface = dot( faceNormal, rec.direction ) < 0.0;
    rec.didHit = ! isSampleBelowSurface && isDirectionValid( rec.direction, normal, faceNormal );

    return rec;
}

vec3 calculateDirectLightingMIS( HitInfo hitInfo, vec3 V, BRDFSample brdfSample, int sampleIndex, int bounceIndex, inout uint rngState, inout ivec2 stats ) {
    vec3 totalLighting = vec3( 0.0 );
    vec3 N = hitInfo.normal;
    vec3 rayOrigin = hitInfo.hitPoint + N * 0.001;

    // Cache common values
    float NoV = max( dot( N, V ), 0.0 );
    bool isMetallic = hitInfo.material.metalness > 0.9;
    bool isGlossy = hitInfo.material.roughness < 0.2;

    // Directional lights
    #if MAX_DIRECTIONAL_LIGHTS > 0
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS / 7; i ++ ) {
        DirectionalLight light = getDirectionalLight( i );
        if( light.intensity <= 0.0 )
            continue;

        // Skip some directional light calculations for metallic surfaces facing away
        float NoL = dot( N, light.direction );
        if( isMetallic && NoL <= 0.0 )
            continue;

        LightSampleRec lightRec = sampleDirectionalLight( light, rayOrigin, N, N );
        if( ! lightRec.didHit )
            continue;

        // Physical sun intensity with atmospheric effects
        float baseIrradiance = 1000.0;  // W/m²
        float atmosphericTransmittance = 0.7;  // Clear sky
        float scatteringFactor = 0.5;   // Account for scatter
        float adjustmentScale = 0.01;    // Scale factor
        float emissionFactor = ( baseIrradiance * atmosphericTransmittance * scatteringFactor ) * adjustmentScale;

        // Only check shadows if the light contribution would be significant
        float potentialContribution = light.intensity * max( NoL, 0.0 );
        if( potentialContribution > 0.01 && ! isPointInShadow( rayOrigin, N, lightRec.direction, rngState, stats ) ) {
            vec3 brdfValue = evaluateBRDF( V, lightRec.direction, N, hitInfo.material );
            // For directional lights we use pure light sampling (no MIS needed)
            vec3 lightContribution = lightRec.emission * emissionFactor;    
            totalLighting += lightContribution * brdfValue * NoL;
        }
    }
    #endif

    // Area lights with adaptive sampling
    #if MAX_AREA_LIGHTS > 0 
    for( int i = 0; i < MAX_AREA_LIGHTS / 13; i ++ ) {
        AreaLight light = getAreaLight( i );
        if( light.intensity <= 0.0 )
            continue;

        // Skip distant or back-facing lights
        vec3 lightCenter = light.position - rayOrigin;
        float distSq = dot( lightCenter, lightCenter );
        float cosTheta = dot( normalize( lightCenter ), N );

        // Early exit for lights that won't contribute much
        if( distSq > ( light.intensity * 100.0 ) || ( isMetallic && cosTheta <= 0.0 ) )
            continue;

        totalLighting += calculateAreaLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, brdfSample, sampleIndex, bounceIndex, rngState, stats );
    }
    #endif

    return totalLighting;
}

struct IndirectLightingResult {
    vec3 direction;
    vec3 throughput;
    float misWeight;
};

IndirectLightingResult calculateIndirectLighting( vec3 V, vec3 N, RayTracingMaterial material, BRDFSample brdfSample, int sampleIndex, int bounceIndex, inout uint rngState ) {
    // Sample cosine-weighted direction with adaptive weights
    vec2 indirectSample = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex + 1, rngState, - 1 );

    // Get material-based importance for sampling strategy selection
    float materialImportance = getMaterialImportance( material );

    // Sample environment map
    EnvMapSample envSample = sampleEnvironmentMap( indirectSample );

    // Adaptive sampling weights based on material properties
    float envWeight = enableEnvironmentLight ? ( 0.3 * ( 1.0 - material.metalness ) ) : 0.0;
    float brdfWeight = materialImportance * 0.7;
    float cosineWeight = 1.0 - envWeight - brdfWeight;

    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdf;
    float rand = RandomValue( rngState );

    // Importance sampling strategy selection
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

    // Ensure valid PDFs and calculate MIS weight
    samplePdf = max( samplePdf, 0.001 );
    float brdfPdf = max( brdfSample.pdf, 0.001 );
    float envPdf = enableEnvironmentLight ? max( envSample.pdf, 0.001 ) : 0.0;
    float cosinePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );

    // Calculate MIS weights using the power heuristic
    float misWeight = powerHeuristic( samplePdf, envPdf * envWeight + brdfPdf * brdfWeight + cosinePdf * cosineWeight );

    // Calculate final contribution with energy conservation
    float NoL = max( dot( N, sampleDir ), 0.0 );
    vec3 throughput = sampleBrdf * NoL * misWeight / samplePdf;
    throughput *= globalIlluminationIntensity;

    IndirectLightingResult result;
    result.direction = sampleDir;
    result.throughput = throughput;
    result.misWeight = misWeight;
    return result;
}

vec3 evaluateAreaLightHelper( AreaLight light, Ray ray, out bool didHit ) {
    // Get light plane normal
    vec3 lightNormal = normalize( cross( light.u, light.v ) );

    // Calculate intersection with the light plane
    float denom = dot( lightNormal, ray.direction );

    // Skip if ray is parallel to plane
    if( abs( denom ) < 1e-6 ) {
        didHit = false;
        return vec3( 0.0 );
    }

    // Calculate intersection distance
    float t = dot( light.position - ray.origin, lightNormal ) / denom;

    // Skip if intersection is behind ray
    if( t < 0.0 ) {
        didHit = false;
        return vec3( 0.0 );
    }

    // Calculate intersection point
    vec3 hitPoint = ray.origin + ray.direction * t;
    vec3 localPoint = hitPoint - light.position;

    // Project onto light's axes
    float u = dot( localPoint, normalize( light.u ) );
    float v = dot( localPoint, normalize( light.v ) );

    // Check if point is within rectangle bounds
    if( abs( u ) <= length( light.u ) && abs( v ) <= length( light.v ) ) {
        didHit = true;
        // Return visualization color based on light properties
        return light.color * light.intensity * 0.1; // Scale for visibility
    }

    didHit = false;
    return vec3( 0.0 );
}