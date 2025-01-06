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

LightRecord sampleAreaLight( AreaLight light, vec3 fromPoint, vec2 ruv ) {
    LightRecord record;

    // Early out for degenerate lights
    if( light.area < 1e-6 ) {
        record.didHit = false;
        return record;
    }

    // Generate random position on light surface
    vec3 lightPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );

    // Calculate vector to light and its properties
    vec3 toLight = lightPos - fromPoint;
    float dist = length( toLight );
    vec3 direction = toLight / dist;

    // Only contribute when the light is facing the point being lit
    // dot(direction, light.normal) should be negative for the light to face the point
    if( dot( direction, light.normal ) >= 0.0 ) {
        record.didHit = false;
        return record;
    }

    // Calculate PDF following physical light principles
    float cosTheta = abs( dot( direction, light.normal ) );
    float distSq = dist * dist;
    float pdf = distSq / ( max( cosTheta * light.area, 1e-6 ) );

    record.direction = direction;
    record.position = lightPos;
    record.pdf = pdf;
    record.emission = light.color * light.intensity;
    record.area = light.area;
    record.didHit = true;

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

bool isPointInShadow( vec3 point, vec3 normal, vec3 lightDir, inout ivec2 stats ) {
    Ray shadowRay;
    shadowRay.origin = point + normal * 0.001; // shadow bias
    shadowRay.direction = lightDir;

    float opacity = 0.0;
    const int MAX_SHADOW_STEPS = 32; // Limit shadow ray bounces
    uint rngState = uint( gl_FragCoord.x + gl_FragCoord.y * 1024.0 ); // Initialize RNG state

    for( int i = 0; i < MAX_SHADOW_STEPS; i ++ ) {
        HitInfo shadowHit = traverseBVH( shadowRay, stats );

        if( ! shadowHit.didHit ) {
            return false; // Ray reached light without being fully blocked
        }

        // Handle transparent and transmissive materials
        if( shadowHit.material.transparent || shadowHit.material.transmission > 0.0 ) {
            float materialOpacity;
            vec3 newDirection;

            if( shadowHit.material.transmission > 0.0 ) {
                // Use the transmission utilities for consistent handling
                bool entering = dot( shadowRay.direction, shadowHit.normal ) < 0.0;
                TransmissionResult transResult = handleTransmission( shadowRay.direction, shadowHit.normal, shadowHit.material, entering, rngState );

                // Update shadow ray direction
                newDirection = transResult.direction;

                // Calculate effective opacity based on transmission result
                float transmissionFactor = length( transResult.throughput ) / 3.0;
                materialOpacity = 1.0 - ( shadowHit.material.transmission * transmissionFactor );
            } else {
                // Handle regular transparency
                materialOpacity = shadowHit.material.transparent ? shadowHit.material.opacity : 1.0;
                newDirection = shadowRay.direction;
            }

            // Apply material's alpha if using alpha texture
            if( shadowHit.material.alphaMode != 0 ) {
                materialOpacity *= shadowHit.material.color.a;
            }

            // Accumulate opacity
            opacity += materialOpacity * ( 1.0 - opacity );

            if( opacity >= 0.99 ) {
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

// Area light contribution calculation with MIS
vec3 calculateAreaLightContribution(
    AreaLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    BRDFSample brdfSample,
    inout uint rngState,
    inout ivec2 stats
) {
    vec3 contribution = vec3( 0.0 );
    vec3 shadowOrigin = hitPoint + normal * 0.001;

    // Light sampling strategy
    vec2 xi = getRandomSample( gl_FragCoord.xy, 0, 0, rngState, 6 );
    LightRecord lightRecord = sampleAreaLight( light, hitPoint, xi );

    if( lightRecord.didHit ) {
        float NoL = dot( normal, lightRecord.direction );

        if( NoL > 0.0 && ! isPointInShadow( shadowOrigin, normal, lightRecord.direction, stats ) ) {
            // Evaluate light and BRDF
            vec3 lightContribution = evaluateAreaLight( light, lightRecord );
            vec3 brdfValue = evaluateBRDF( viewDir, lightRecord.direction, normal, material );

            // MIS weight calculation
            float misWeightLight = powerHeuristic( lightRecord.pdf, brdfSample.pdf );
            contribution += lightContribution * brdfValue * NoL * misWeightLight / max( lightRecord.pdf, 0.001 );
        }
    }

    // BRDF sampling contribution
    vec3 brdfHitPoint = hitPoint + brdfSample.direction * 1000.0;
    float dist;
    if( intersectRectangle( light.position, light.u, light.v, hitPoint, brdfSample.direction, dist ) ) {
        vec3 hitPos = hitPoint + brdfSample.direction * dist;
        float brdfDist = length( hitPos - hitPoint );

        LightRecord brdfRecord;
        brdfRecord.direction = brdfSample.direction;
        brdfRecord.position = hitPos;
        brdfRecord.emission = light.color * light.intensity;
        brdfRecord.didHit = true;

        float misWeightBRDF = powerHeuristic( brdfSample.pdf, lightRecord.pdf );
        vec3 brdfLightContribution = evaluateAreaLight( light, brdfRecord );
        contribution += brdfLightContribution * brdfSample.value * misWeightBRDF / max( brdfSample.pdf, 0.001 );
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

vec3 calculateDirectLightingMIS( HitInfo hitInfo, vec3 V, BRDFSample brdfSample, inout uint rngState, inout ivec2 stats ) {
    vec3 totalLighting = vec3( 0.0 );
    vec3 N = hitInfo.normal;
    vec3 faceNormal = hitInfo.normal; // Or compute face normal if different from shading normal
    vec3 rayOrigin = hitInfo.hitPoint + N * 0.001; // Shadow bias

    // Directional lights
    #if MAX_DIRECTIONAL_LIGHTS > 0
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS; i ++ ) {
        DirectionalLight light = getDirectionalLight( i );
        if( light.intensity <= 0.0 )
            continue;

        LightSampleRec lightRec = sampleDirectionalLight( light, rayOrigin, N, faceNormal );

        if( ! lightRec.didHit )
            continue;

        // Physical sun intensity with atmospheric effects
        float baseIrradiance = 1000.0;  // W/m²
        float atmosphericTransmittance = 0.7;  // Clear sky
        float scatteringFactor = 0.5;   // Account for scatter
        float adjustmentScale = 0.1;    // Scale factor

        // Check visibility
        if( ! isPointInShadow( rayOrigin, N, lightRec.direction, stats ) ) {
            float NoL = max( dot( N, lightRec.direction ), 0.0 );
            vec3 brdfValue = evaluateBRDF( V, lightRec.direction, N, hitInfo.material );

            // For directional lights we use pure light sampling (no MIS needed)
            vec3 lightContribution = lightRec.emission *
                ( baseIrradiance * atmosphericTransmittance * scatteringFactor ) *
                adjustmentScale;

            totalLighting += lightContribution * brdfValue * NoL;
        }
    }
    #endif

    // Area lights
    #if MAX_AREA_LIGHTS > 0 
    for( int i = 0; i < MAX_AREA_LIGHTS; i ++ ) {
        AreaLight light = getAreaLight( i );
        if( light.intensity <= 0.0 )
            continue;

        totalLighting += calculateAreaLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, brdfSample, rngState, stats );
    }
    #endif

    // Environment lighting contribution could be added here
    // if(enableEnvironmentLight) { ... }

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