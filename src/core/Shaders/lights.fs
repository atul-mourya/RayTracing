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

float getMaterialTransparency( HitInfo shadowHit, Ray shadowRay, inout uint rngState ) {
    // Check if the material has transmission (like glass)
    if( shadowHit.material.transmission > 0.0 ) {
        // Check if ray is entering or exiting the material
        bool isEntering = dot( shadowRay.direction, shadowHit.normal ) < 0.0;

        // Get transmission data (color, direction changes due to refraction)
        TransmissionResult transResult = handleTransmission( shadowRay.direction, shadowHit.normal, shadowHit.material, isEntering, rngState );

        // Calculate how much light gets through
        // Average the RGB components of throughput (divide by 3.0)
        float transmissionFactor = length( transResult.throughput ) / 3.0;

        // Calculate opacity: 1.0 minus (transmission * how much gets through)
        return 1.0 - ( shadowHit.material.transmission * transmissionFactor );
    } 
    // If no transmission, check if it's transparent
    else if( shadowHit.material.transparent ) {
        return shadowHit.material.opacity;
    }
    // If neither transmissive nor transparent, it's fully opaque
    else {
        return 1.0;
    }
}

bool isPointInShadow( vec3 point, vec3 normal, vec3 lightDir, uint rngState, inout ivec2 stats ) {
    const float SHADOW_BIAS = 0.001;
    const float MAX_SHADOW_DISTANCE = 1000.0;
    const float OPACITY_THRESHOLD = 0.99;
    const int MAX_SHADOW_STEPS = 16;

    // Initialize shadow ray (avoid struct initialization in loop)
    Ray shadowRay;
    shadowRay.origin = point + normal * SHADOW_BIAS;
    shadowRay.direction = - normalize( lightDir );

    // First hit check
    HitInfo shadowHit = traverseBVH( shadowRay, stats );

    // Fast path: if no hit or hit an opaque surface
    if( ! shadowHit.didHit ||
        length( shadowHit.hitPoint - point ) > MAX_SHADOW_DISTANCE ||
        ( ! shadowHit.material.transparent && shadowHit.material.transmission <= 0.0 ) ) {
        return shadowHit.didHit &&
            length( shadowHit.hitPoint - point ) <= MAX_SHADOW_DISTANCE &&
            ! shadowHit.material.transparent &&
            shadowHit.material.transmission <= 0.0;
    }

    // Complex path: handle transparent/transmissive materials
    float opacity = 0.0;
    vec3 rayOrigin = shadowRay.origin;

    // Unrolled first iteration to avoid redundant checks
    float materialOpacity = getMaterialTransparency( shadowHit, shadowRay, rngState );
    if( shadowHit.material.alphaMode != 0 ) {
        materialOpacity *= shadowHit.material.color.a;
    }
    opacity = materialOpacity;

    // Early exit check
    if( opacity >= OPACITY_THRESHOLD ) {
        return true;
    }

    // Main loop (MAX_SHADOW_STEPS - 1 because we already did first iteration)
    for( int i = 0; i < MAX_SHADOW_STEPS - 1; i ++ ) {
        rayOrigin = shadowHit.hitPoint + lightDir * SHADOW_BIAS;
        shadowRay.origin = rayOrigin;
        shadowHit = traverseBVH( shadowRay, stats );

        if( ! shadowHit.didHit ) {
            return false;
        }

        materialOpacity = getMaterialTransparency( shadowHit, shadowRay, rngState );
        if( shadowHit.material.alphaMode != 0 ) {
            materialOpacity *= shadowHit.material.color.a;
        }

        // Optimized opacity accumulation
        opacity += materialOpacity * ( 1.0 - opacity );
        if( opacity >= OPACITY_THRESHOLD ) {
            return true;
        }
    }

    return opacity >= OPACITY_THRESHOLD;
}

// Add this helper function for shadow rays
float traceShadowRay( vec3 origin, vec3 dir, float maxDist, inout uint rngState, inout ivec2 stats ) {
    Ray shadowRay;
    shadowRay.origin = origin;
    shadowRay.direction = dir;

    // Single BVH traversal for shadow
    HitInfo shadowHit = traverseBVH( shadowRay, stats );

    // No hit or hit beyond light distance
    if( ! shadowHit.didHit || length( shadowHit.hitPoint - origin ) > maxDist )
        return 1.0;

    // Fast path for opaque objects
    if( ! shadowHit.material.transparent && shadowHit.material.transmission <= 0.0 )
        return 0.0;

    // Simple transparency accumulation (max 2 transparent surfaces)
    float transmittance = 1.0;
    for( int step = 0; step < 2; step ++ ) {
        float opacity = shadowHit.material.transparent ? shadowHit.material.opacity : ( 1.0 - shadowHit.material.transmission );

        if( shadowHit.material.alphaMode != 0 )
            opacity *= shadowHit.material.color.a;

        transmittance *= ( 1.0 - opacity );

        if( transmittance < 0.02 )
            return 0.0;

        // Continue ray
        shadowRay.origin = shadowHit.hitPoint + dir * 0.001;
        shadowHit = traverseBVH( shadowRay, stats );

        if( ! shadowHit.didHit || length( shadowHit.hitPoint - origin ) > maxDist )
            break;
    }

    return transmittance;
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
    // Adaptive light sampling based on importance
    float distanceToLight = length( light.position - hitPoint );
    float lightArea = light.area;
    float solidAngle = lightArea / ( distanceToLight * distanceToLight );

    // Early exit for distant lights with minimal contribution
    if( solidAngle < 0.001 )
        return 0.0;

    // Adaptive sample count (1-4) based on light importance
    int SHADOW_SAMPLES = clamp( int( solidAngle * 16.0 ), 1, 4 );
    float visibility = 0.0;

    // Pre-compute shared values
    vec3 shadowOrigin = hitPoint + normal * 0.001;
    vec3 centerToLight = light.position - shadowOrigin;
    float maxLightDist = length( centerToLight ) + length( light.u ) + length( light.v );

    // Use stratified sampling for better coverage
    for( int i = 0; i < SHADOW_SAMPLES; i ++ ) {
        // Stratified position on light surface
        vec2 ruv = getRandomSample( gl_FragCoord.xy, sampleIndex * SHADOW_SAMPLES + i, bounceIndex, rngState, - 1 );
        vec2 stratifiedOffset = vec2( ( ruv.x / float( SHADOW_SAMPLES ) + float( i % 2 ) / 2.0 ) - 0.5, ( ruv.y / float( SHADOW_SAMPLES ) + float( i / 2 ) / 2.0 ) - 0.5 );

        vec3 lightPos = light.position + light.u * stratifiedOffset.x + light.v * stratifiedOffset.y;
        vec3 toLight = lightPos - shadowOrigin;
        float lightDist = length( toLight );

        // Quick validity checks
        if( lightDist > maxLightDist || dot( normalize( toLight ), light.normal ) > - 0.001 )
            continue;

        // Fast shadow test with limited transparency
        visibility += traceShadowRay( shadowOrigin, normalize( toLight ), lightDist, rngState, stats );
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
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Light sampling
    vec2 ruv = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, - 1 );

    // Generate position on light surface
    vec3 lightPos = light.position +
        light.u * ( ruv.x - 0.5 ) +
        light.v * ( ruv.y - 0.5 );

    // Calculate light direction and properties
    vec3 toLight = lightPos - hitPoint;
    float lightDist = length( toLight );
    vec3 lightDir = toLight / lightDist;

    // Basic geometric checks
    float NoL = dot( normal, lightDir );
    float lightFacing = - dot( lightDir, light.normal );

    // Skip if light is not visible or facing away
    if( NoL <= 0.0 || lightFacing <= 0.0 ) {
        return vec3( 0.0 );
    }

    // Calculate shadow visibility
    float visibility = calculateAreaLightVisibility( hitPoint, normal, light, sampleIndex, bounceIndex, rngState, stats );

    if( visibility <= 0.0 ) {
        return vec3( 0.0 );
    }

    // Calculate BRDF and light contribution
    vec3 brdfValue = evaluateMaterialResponse( viewDir, lightDir, normal, material );

    // Physical light falloff
    float distanceSqr = lightDist * lightDist;
    float falloff = light.area / ( 4.0 * PI * distanceSqr );

    // Final contribution
    vec3 lightContribution = light.color * light.intensity * falloff * lightFacing;

    return lightContribution * brdfValue * NoL * visibility;
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

vec3 calculateDirectLightingMIS( HitInfo hitInfo, vec3 V, DirectionSample brdfSample, int sampleIndex, int bounceIndex, inout uint rngState, inout ivec2 stats ) {
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

        // Skip inactive lights
        if( light.intensity <= 0.0 )
            continue;

        float NoL = dot( N, light.direction );

        // Skip back-facing lights and metallic optimization
        if( NoL <= 0.0 || ( isMetallic && NoL <= 0.0 ) )
            continue;

        // Only check shadows if light contribution would be significant
        if( light.intensity * NoL > 0.01 && ! isPointInShadow( rayOrigin, N, - light.direction, rngState, stats ) ) {
            vec3 brdfValue = evaluateMaterialResponse( V, light.direction, N, hitInfo.material );

            vec3 lightContribution = light.color * light.intensity;
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

IndirectLightingResult calculateIndirectLighting( vec3 V, vec3 N, RayTracingMaterial material, DirectionSample brdfSample, int sampleIndex, int bounceIndex, inout uint rngState ) {
    // Initialize result
    IndirectLightingResult result;

    // Sample base direction using random value
    vec2 indirectSample = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex + 1, rngState, - 1 );
    float rand = RandomValue( rngState );

    // Calculate weights only if environment light is enabled
    float envWeight = 0.0;
    float brdfWeight = getMaterialImportance( material ); // Get material-based importance once

    vec3 sampleDir = brdfSample.direction;
    float samplePdf = brdfSample.pdf;
    vec3 sampleBrdfValue = brdfSample.value;
    float NoL = max( dot( N, sampleDir ), 0.0 );

    if( rand >= brdfWeight ) {
        // Cosine-weighted sampling
        sampleDir = cosineWeightedSample( N, indirectSample );
        NoL = max( dot( N, sampleDir ), 0.0 );
        samplePdf = NoL * PI_INV;
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
    }

    // Ensure valid PDFs
    // samplePdf = max( samplePdf, 0.001 );
    float brdfPdf = brdfSample.pdf;
    float cosinePdf = NoL * PI_INV;
    float cosineWeight = 1.0 - envWeight - brdfWeight;
    
    // float combinedPdf = brdfPdf * brdfWeight + cosinePdf * cosineWeight;
    float misWeight = powerHeuristic( samplePdf, cosineWeight );

    // Calculate final throughput
    vec3 throughput = sampleBrdfValue * NoL * misWeight / samplePdf;
    throughput *= globalIlluminationIntensity;

    // Set result values
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