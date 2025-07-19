// -----------------------------------------------------------------------------
// Uniform Declarations & Structures
// -----------------------------------------------------------------------------

#if MAX_DIRECTIONAL_LIGHTS > 0
uniform float directionalLights[ MAX_DIRECTIONAL_LIGHTS * 8 ]; // Updated from 7 to 8 for angle parameter
#else
uniform float directionalLights[ 1 ]; // Dummy array to avoid compilation error
#endif

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
    float angle;  // Angular diameter in radians
};

struct AreaLight {
    vec3 position;
    vec3 u; // First axis of the rectangular light
    vec3 v; // Second axis of the rectangular light
    vec3 color;
    float intensity;
    vec3 normal;
    float area;
};

struct IndirectLightingResult {
    vec3 direction;    // Sampled direction for next bounce
    vec3 throughput;   // Light throughput along this path
    float misWeight;   // MIS weight for this sample
    float pdf;         // PDF of the generated sample
};

// -----------------------------------------------------------------------------
// Light Data Access Functions
// -----------------------------------------------------------------------------

DirectionalLight getDirectionalLight( int index ) {
    int baseIndex = index * 8;  // Updated from 7 to 8
    DirectionalLight light;
    light.direction = normalize( vec3( directionalLights[ baseIndex ], directionalLights[ baseIndex + 1 ], directionalLights[ baseIndex + 2 ] ) );
    light.color = vec3( directionalLights[ baseIndex + 3 ], directionalLights[ baseIndex + 4 ], directionalLights[ baseIndex + 5 ] );
    light.intensity = directionalLights[ baseIndex + 6 ];
    light.angle = directionalLights[ baseIndex + 7 ];  // New angle parameter
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

// -----------------------------------------------------------------------------
// Cone Sampling for Soft Directional Shadows
// -----------------------------------------------------------------------------

// Sample direction within a cone for soft shadows
vec3 sampleCone( vec3 direction, float halfAngle, vec2 xi ) {
    // Sample within cone using spherical coordinates
    float cosHalfAngle = cos( halfAngle );
    float cosTheta = mix( cosHalfAngle, 1.0, xi.x );
    float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );
    float phi = TWO_PI * xi.y;

    // Create local coordinate system
    vec3 up = abs( direction.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
    vec3 tangent = normalize( cross( up, direction ) );
    vec3 bitangent = cross( direction, tangent );

    // Convert to world space
    vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
    return normalize( tangent * localDir.x + bitangent * localDir.y + direction * localDir.z );
}

// -----------------------------------------------------------------------------
// Shadow & Intersection Test Functions
// -----------------------------------------------------------------------------

float getMaterialTransparency( HitInfo shadowHit, Ray shadowRay, inout uint rngState ) {
    // Check if the material has transmission (like glass)
    if( shadowHit.material.transmission > 0.0 ) {
        // Check if ray is entering or exiting the material
        bool isEntering = dot( shadowRay.direction, shadowHit.normal ) < 0.0;

        // Use simplified shadow transmission instead of full handleTransmission
        float transmittance = calculateShadowTransmittance( shadowRay.direction, shadowHit.normal, shadowHit.material, isEntering );

        // Return opacity based on transmittance
        return 1.0 - transmittance;
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

float traceShadowRay( vec3 origin, vec3 dir, float maxDist, inout uint rngState, inout ivec2 stats ) {
    Ray shadowRay;
    shadowRay.origin = origin;
    shadowRay.direction = dir;

    // Media tracking for shadow rays
    MediumStack shadowMediaStack;
    shadowMediaStack.depth = 0;

    // Track accumulated transmittance
    float transmittance = 1.0;

    // Allow more steps through transparent media for shadow rays
    const int MAX_SHADOW_TRANSMISSIONS = 8;

    for( int step = 0; step < MAX_SHADOW_TRANSMISSIONS; step ++ ) {
        HitInfo shadowHit = traverseBVH( shadowRay, stats );

        // No hit or hit beyond light distance
        if( ! shadowHit.didHit || length( shadowHit.hitPoint - origin ) > maxDist )
            break;

        // Special handling for transmissive materials
        if( shadowHit.material.transmission > 0.0 ) {
            // Determine if entering or exiting medium
            bool entering = dot( shadowRay.direction, shadowHit.normal ) < 0.0;
            vec3 N = entering ? shadowHit.normal : - shadowHit.normal;

            // Apply absorption if exiting medium
            if( ! entering && shadowHit.material.attenuationDistance > 0.0 ) {
                float dist = length( shadowHit.hitPoint - shadowRay.origin );
                vec3 absorption = calculateBeerLawAbsorption( shadowHit.material.attenuationColor, shadowHit.material.attenuationDistance, dist );
                transmittance *= ( absorption.r + absorption.g + absorption.b ) / 3.0;
            }

            // Compute transmittance based on material properties
            float fresnel = fresnelSchlick( abs( dot( shadowRay.direction, N ) ), iorToFresnel0( shadowHit.material.ior, 1.0 ) );

            // Combine Fresnel with transmission property
            float matTransmittance = ( 1.0 - fresnel ) * shadowHit.material.transmission;
            transmittance *= matTransmittance;

            // Early exit if almost no light passes through
            if( transmittance < 0.005 )
                return 0.0;

            // Continue ray
            shadowRay.origin = shadowHit.hitPoint + shadowRay.direction * 0.001;
        } else if( shadowHit.material.transparent ) {
            // Handle transparent materials
            transmittance *= ( 1.0 - shadowHit.material.opacity );

            if( transmittance < 0.005 )
                return 0.0;

            // Continue ray
            shadowRay.origin = shadowHit.hitPoint + shadowRay.direction * 0.001;
        } else {
            // Fully opaque object blocks shadow ray
            return 0.0;
        }
    }

    return transmittance;
}

bool intersectAreaLight( AreaLight light, vec3 rayOrigin, vec3 rayDirection, inout float t ) {
    // Fast path - precomputed normal
    vec3 normal = light.normal;
    float denom = dot( normal, rayDirection );

    // Quick rejection (backface culling and near-parallel rays)
    if( denom >= - 0.0001 )
        return false;

    // Calculate intersection distance
    float invDenom = 1.0 / denom; // Multiply is faster than divide on many GPUs
    t = dot( light.position - rayOrigin, normal ) * invDenom;

    // Skip intersections behind the ray
    if( t <= 0.001 )
        return false;

    // Optimized rectangle test using vector rejection
    vec3 hitPoint = rayOrigin + rayDirection * t;
    vec3 localPoint = hitPoint - light.position;

    // Normalized u/v directions
    vec3 u_dir = light.u / length( light.u );
    vec3 v_dir = light.v / length( light.v );

    // Project onto axes
    float u_proj = dot( localPoint, u_dir );
    float v_proj = dot( localPoint, v_dir );

    // Check within rectangle bounds (half-lengths)
    return ( abs( u_proj ) <= length( light.u ) && abs( v_proj ) <= length( light.v ) );
}

// -----------------------------------------------------------------------------
// DIRECTIONAL LIGHT FUNCTIONS
// -----------------------------------------------------------------------------

// Calculate adaptive ray offset based on scene scale and surface properties
vec3 calculateRayOffset( vec3 hitPoint, vec3 normal, RayTracingMaterial material ) {
    // Base epsilon scaled by scene size
    float scaleEpsilon = max( 1e-4, length( hitPoint ) * 1e-6 );

    // Adjust for material properties
    float materialEpsilon = scaleEpsilon;
    if( material.transmission > 0.0 ) {
        // Transmissive materials need larger offsets to avoid light leaking
        materialEpsilon *= 2.0;
    }
    if( material.roughness < 0.1 ) {
        // Smooth materials are more sensitive to precision issues
        materialEpsilon *= 1.5;
    }

    return normal * materialEpsilon;
}

// Fast early exit checks for directional lights
bool shouldSkipDirectionalLight(
    DirectionalLight light,
    vec3 normal,
    RayTracingMaterial material,
    int bounceIndex
) {
    float NoL = max( 0.0, dot( normal, light.direction ) );

    // Basic validity checks
    if( light.intensity <= 0.001 || NoL <= 0.001 ) {
        return true;
    }

    // Material-specific early exits for performance
    if( bounceIndex > 0 ) {
        // Skip dim lights on secondary bounces
        if( light.intensity < 0.01 ) {
            return true;
        }

        // Skip lights that barely hit metals at grazing angles
        if( material.metalness > 0.9 && NoL < 0.1 ) {
            return true;
        }

        // Skip lights that won't contribute much to rough dielectrics
        if( material.metalness < 0.1 && material.roughness > 0.9 && light.intensity < 0.1 ) {
            return true;
        }
    }

    return false;
}

// Directional light contribution with soft shadows
vec3 calculateDirectionalLightContribution(
    DirectionalLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    MaterialCache matCache,
    DirectionSample brdfSample,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Fast early exit
    if( shouldSkipDirectionalLight( light, normal, material, bounceIndex ) ) {
        return vec3( 0.0 );
    }

    // Calculate adaptive ray offset
    vec3 rayOffset = calculateRayOffset( hitPoint, normal, material );
    vec3 rayOrigin = hitPoint + rayOffset;

    // Determine shadow sampling strategy based on light angle
    vec3 shadowDirection;
    float lightPdf = 1e6; // Default for sharp shadows

    if( light.angle > 0.001 ) {
        // Soft shadows: sample direction within cone
        vec2 xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
        float halfAngle = light.angle * 0.5;
        shadowDirection = sampleCone( light.direction, halfAngle, xi );

        // Calculate PDF for cone sampling
        float cosHalfAngle = cos( halfAngle );
        lightPdf = 1.0 / ( TWO_PI * ( 1.0 - cosHalfAngle ) );
    } else {
        // Sharp shadows: use original direction
        shadowDirection = light.direction;
    }

    float NoL = max( 0.0, dot( normal, shadowDirection ) );
    if( NoL <= 0.0 ) {
        return vec3( 0.0 );
    }

    // Shadow test
    float maxShadowDistance = 1e6;
    float visibility = traceShadowRay( rayOrigin, shadowDirection, maxShadowDistance, rngState, stats );
    if( visibility <= 0.0 ) {
        return vec3( 0.0 );
    }

    // BRDF evaluation using sampled direction
    vec3 brdfValue = evaluateMaterialResponseCached( viewDir, shadowDirection, normal, material, matCache );

    // Base contribution
    vec3 contribution = light.color * light.intensity * brdfValue * NoL * visibility;

    // MIS for directional lights (only on primary rays where it matters)
    if( bounceIndex == 0 && brdfSample.pdf > 0.0 ) {
        // Check alignment between BRDF sample and shadow direction
        float alignment = max( 0.0, dot( normalize( brdfSample.direction ), shadowDirection ) );

        // Only apply MIS if there's significant alignment
        if( alignment > 0.996 ) {
            float misWeight = powerHeuristic( lightPdf, brdfSample.pdf );
            contribution *= misWeight;
        }
        // If no alignment, light sampling dominates (no reduction needed)
    }

    return contribution;
}

// -----------------------------------------------------------------------------
// Light Importance & Contribution Calculations (Area Lights)
// -----------------------------------------------------------------------------

// Light importance estimation - helps guide where to spend computation
float estimateLightImportance(
    AreaLight light,
    vec3 hitPoint,
    vec3 normal,
    RayTracingMaterial material
) {
    // Distance-based importance
    vec3 toLight = light.position - hitPoint;
    float distSq = dot( toLight, toLight );
    float distanceFactor = 1.0 / max( distSq, 0.01 );

    // Angular importance - light facing toward surface?
    vec3 lightDir = normalize( toLight );
    float NoL = max( dot( normal, lightDir ), 0.0 );
    float lightFacing = max( - dot( lightDir, light.normal ), 0.0 );

    // Size importance
    float sizeFactor = light.area;

    // Brightness importance
    float intensity = light.intensity * luminance( light.color );

    // Material-specific factors
    float materialFactor = 1.0;
    if( material.metalness > 0.7 ) {
        // Metals care more about bright lights for specular reflections
        materialFactor = 2.0;
    } else if( material.roughness > 0.8 ) {
        // Rough diffuse surfaces care more about large lights
        materialFactor = 0.8;
    }

    // Combined importance score
    return distanceFactor * NoL * lightFacing * sizeFactor * intensity * materialFactor;
}

// Highly optimized area light contribution calculation
vec3 calculateAreaLightContribution(
    AreaLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    MaterialCache matCache,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Importance estimation to decide sampling strategy
    float lightImportance = estimateLightImportance( light, hitPoint, normal, material );

    // Skip lights with negligible contribution 
    if( lightImportance < 0.001 )
        return vec3( 0.0 );

    // Pre-compute common values
    vec3 contribution = vec3( 0.0 );
    vec3 rayOffset = calculateRayOffset( hitPoint, normal, material );
    vec3 rayOrigin = hitPoint + rayOffset;

    // Adaptive sampling strategy based on material and importance
    bool isDiffuse = material.roughness > 0.7 && material.metalness < 0.3;
    bool isSpecular = material.roughness < 0.3 || material.metalness > 0.7;
    bool isFirstBounce = bounceIndex == 0;

    // ---------------------------
    // LIGHT SAMPLING STRATEGY
    // ---------------------------
    if( isFirstBounce || isDiffuse || ( lightImportance > 0.1 && ! isSpecular ) ) {
        // Get stratified sample point for better coverage
        vec2 ruv = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, - 1 );

        // Generate position on light surface (stratified to improve sampling)
        vec3 lightPos = light.position +
            light.u * ( ruv.x - 0.5 ) +
            light.v * ( ruv.y - 0.5 );

        // Calculate light direction and properties
        vec3 toLight = lightPos - hitPoint;
        float lightDistSq = dot( toLight, toLight );
        float lightDist = sqrt( lightDistSq );
        vec3 lightDir = toLight / lightDist;

        // Geometric terms
        float NoL = max( 0.0, dot( normal, lightDir ) );
        float lightFacing = max( 0.0, - dot( lightDir, light.normal ) );

        // Early exit for geometry facing away
        if( NoL > 0.0 && lightFacing > 0.0 ) {
            // Shadow test with single ray
            float visibility = traceShadowRay( rayOrigin, lightDir, lightDist, rngState, stats );

            if( visibility > 0.0 ) {
                // BRDF evaluation
                vec3 brdfValue = evaluateMaterialResponseCached( viewDir, lightDir, normal, material, matCache );

                // Calculate PDFs for both strategies
                float lightPdf = lightDistSq / ( light.area * lightFacing );
                float brdfPdf = brdfSample.pdf;

                // Light contribution with inverse-square falloff
                float falloff = light.area / ( 4.0 * PI * lightDistSq );
                vec3 lightContribution = light.color * light.intensity * falloff * lightFacing;

                // MIS weight using power heuristic for better noise reduction
                float misWeight = ( brdfPdf > 0.0 && isFirstBounce ) ? powerHeuristic( lightPdf, brdfPdf ) : 1.0;

                contribution += lightContribution * brdfValue * NoL * visibility * misWeight;
            }
        }
    }

    // ---------------------------
    // BRDF SAMPLING STRATEGY
    // ---------------------------
    if( ( isFirstBounce || isSpecular ) && brdfSample.pdf > 0.0 ) {
        // Fast path - check if ray could possibly hit light before intersection test
        vec3 toLight = light.position - rayOrigin;
        float rayToLightDot = dot( toLight, brdfSample.direction );

        // Only proceed if ray is pointing toward light's general area
        if( rayToLightDot > 0.0 ) {
            float hitDistance = 0.0;
            bool hitLight = intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance );

            if( hitLight ) {
                // We hit the light with our BRDF sample!
                float visibility = traceShadowRay( rayOrigin, brdfSample.direction, hitDistance, rngState, stats );

                if( visibility > 0.0 ) {
                    // Light geometric terms at hit point
                    float lightFacing = max( 0.0, - dot( brdfSample.direction, light.normal ) );

                    if( lightFacing > 0.0 ) {
                        // PDFs for MIS
                        float lightPdf = ( hitDistance * hitDistance ) / ( light.area * lightFacing );

                        // MIS weight using power heuristic
                        float misWeight = powerHeuristic( brdfSample.pdf, lightPdf );

                        // Direct light emission
                        vec3 lightEmission = light.color * light.intensity;
                        float NoL = max( 0.0, dot( normal, brdfSample.direction ) );

                        contribution += lightEmission * brdfSample.value * NoL * visibility * misWeight;
                    }
                }
            }
        }
    }

    return contribution;
}

// -----------------------------------------------------------------------------
// MASTER LIGHTING FUNCTION
// -----------------------------------------------------------------------------

vec3 calculateDirectLightingMIS(
    HitInfo hitInfo,
    vec3 V,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    vec3 totalLighting = vec3( 0.0 );
    vec3 N = hitInfo.normal;

    MaterialCache matCache = createMaterialCacheLegacy( N, V, hitInfo.material );

    // Early termination for materials that don't need direct lighting
    if( hitInfo.material.emissiveIntensity > 10.0 ) {
        // Highly emissive materials don't need direct lighting contribution
        return vec3( 0.0 );
    }

    // Skip direct lighting for pure glass/transparent materials at deeper bounces
    if( bounceIndex > 1 && hitInfo.material.transmission > 0.95 && hitInfo.material.roughness < 0.1 ) {
        return vec3( 0.0 );
    }

    // Importance threshold that increases with bounce depth
    float importanceThreshold = 0.001 * ( 1.0 + float( bounceIndex ) * 0.5 );

    // -----------------------------
    // Directional lights processing
    // -----------------------------
    #if MAX_DIRECTIONAL_LIGHTS > 0

    // Adaptive light count based on bounce depth and material
    int directionalLightCount = MAX_DIRECTIONAL_LIGHTS;
    if( bounceIndex > 0 ) {
        // More aggressive reduction for secondary bounces
        if( bounceIndex == 1 ) {
            directionalLightCount = max( 1, min( 4, MAX_DIRECTIONAL_LIGHTS ) );
        } else if( bounceIndex == 2 ) {
            directionalLightCount = max( 1, min( 2, MAX_DIRECTIONAL_LIGHTS ) );
        } else {
            // For very deep bounces, only process the most important light
            directionalLightCount = 1;
        }
    }

    // Process lights in importance order (they should be pre-sorted by importance)
    #pragma unroll_loop_start
    for( int i = 0; i < min( 16, directionalLightCount ); i ++ ) {
        if( i >= MAX_DIRECTIONAL_LIGHTS )
            break;

        DirectionalLight light = getDirectionalLight( i );

        // Quick importance check for directional lights
        float quickDirImportance = light.intensity * max( 0.0, dot( N, light.direction ) );
        if( quickDirImportance < importanceThreshold ) {
            continue;
        }

        totalLighting += calculateDirectionalLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, bounceIndex, rngState, stats );
    }
    #pragma unroll_loop_end
    #endif // MAX_DIRECTIONAL_LIGHTS > 0

    // ----------------------
    // Area lights processing
    // ----------------------
    #if MAX_AREA_LIGHTS > 0 
    // For deeper bounces, limit area light count
    int maxAreaLightCount = ( MAX_AREA_LIGHTS / 13 );
    if( bounceIndex > 2 ) {
        maxAreaLightCount = min( 2, maxAreaLightCount );
    } else if( bounceIndex > 1 ) {
        maxAreaLightCount = min( 4, maxAreaLightCount );
    }

    for( int i = 0; i < maxAreaLightCount; i ++ ) {
        AreaLight light = getAreaLight( i );
        if( light.intensity <= 0.0 )
            continue;

        // Quick distance and facing checks
        vec3 lightCenter = light.position - hitInfo.hitPoint;
        float distSq = dot( lightCenter, lightCenter );

        // Quick importance calculation for early culling
        float quickImportance = light.intensity * light.area / max( distSq, 1.0 );
        if( quickImportance < importanceThreshold ) {
            continue;
        }

        float cosTheta = dot( normalize( lightCenter ), N );

        // Early exit for lights that won't contribute much
        if( distSq > ( light.intensity * 100.0 ) || ( hitInfo.material.metalness > 0.9 && cosTheta <= 0.0 ) ) {
            continue;
        }

        totalLighting += calculateAreaLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, sampleIndex, bounceIndex, rngState, stats );
    }
    #endif // MAX_AREA_LIGHTS > 0

    return totalLighting;
}

SamplingStrategyWeights computeOptimizedSamplingInfo(
    ImportanceSamplingInfo samplingInfo,
    int bounceIndex,
    RayTracingMaterial material
) {
    SamplingStrategyWeights info;

    // Environment sampling weight
    info.envWeight = 0.0;
    info.useEnv = false;
    if( enableEnvironmentLight && shouldUseEnvironmentSampling( bounceIndex, material ) ) {
        info.envWeight = samplingInfo.envmapImportance;
        info.useEnv = info.envWeight > 0.001;
    }

    // BRDF sampling weight (specular + transmission + clearcoat)
    info.brdfWeight = samplingInfo.specularImportance +
        samplingInfo.transmissionImportance +
        samplingInfo.clearcoatImportance;
    info.useBrdf = info.brdfWeight > 0.001;

    // Cosine sampling weight (diffuse)
    info.cosineWeight = samplingInfo.diffuseImportance;
    info.useCosine = info.cosineWeight > 0.001;

    // Calculate total weight
    info.totalWeight = info.envWeight + info.brdfWeight + info.cosineWeight;

    // Fallback if no strategies are active
    if( info.totalWeight < 0.001 ) {
        info.cosineWeight = 1.0;
        info.useCosine = true;
        info.totalWeight = 1.0;
        info.envWeight = 0.0;
        info.brdfWeight = 0.0;
        info.useEnv = false;
        info.useBrdf = false;
    }

    return info;
}

IndirectLightingResult calculateIndirectLighting(
    vec3 V,
    vec3 N,
    RayTracingMaterial material,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    ImportanceSamplingInfo samplingInfo
) {
    // Initialize result
    IndirectLightingResult result;

    // Pre-compute all sampling strategy information
    SamplingStrategyWeights optInfo = computeOptimizedSamplingInfo( samplingInfo, bounceIndex, material );

    // Get random sample for selection between sampling strategies
    vec2 randomSample = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex + 1, rngState, - 1 );
    float selectionRand = RandomValue( rngState );

    // Strategy selection using cumulative weights (branch-free)
    float normalizedRand = selectionRand * optInfo.totalWeight;
    float cumulativeEnv = optInfo.envWeight;
    float cumulativeBrdf = cumulativeEnv + optInfo.brdfWeight;

    // Determine selected strategy using step functions (more GPU-friendly)
    float selectEnv = step( normalizedRand, cumulativeEnv ) * float( optInfo.useEnv );
    float selectBrdf = step( normalizedRand, cumulativeBrdf ) * ( 1.0 - selectEnv ) * float( optInfo.useBrdf );
    float selectCosine = ( 1.0 - selectEnv - selectBrdf );

    // Sample based on selected strategy
    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdfValue;
    vec3 envContribution = vec3( 1.0 );

    // Use vectorized strategy execution
    if( selectEnv > 0.5 ) {
        // Environment sampling - direction only, NO environment radiance in throughput
        EnvMapSample envSample = sampleEnvironmentWithContext( randomSample, bounceIndex, material, V, N );

        sampleDir = envSample.direction;
        samplePdf = envSample.pdf;

        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );

    } else if( selectBrdf > 0.5 ) {
        // BRDF sampling
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdfValue = brdfSample.value;
    } else {
        // Cosine sampling
        sampleDir = cosineWeightedSample( N, randomSample );
        samplePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
    }

    float NoL = max( dot( N, sampleDir ), 0.0 );

    // MIS calculation using pre-computed weights
    float combinedPdf = 0.0;

    // Calculate PDFs only for active strategies
    if( optInfo.useEnv ) {
        float envPdf = envMapSamplingPDFWithContext( sampleDir, bounceIndex, material, V, N );
        combinedPdf += optInfo.envWeight * envPdf / optInfo.totalWeight;
    }

    if( optInfo.useBrdf ) {
        combinedPdf += optInfo.brdfWeight * brdfSample.pdf / optInfo.totalWeight;
    }

    if( optInfo.useCosine ) {
        float cosinePdf = cosineWeightedPDF( NoL );
        combinedPdf += optInfo.cosineWeight * cosinePdf / optInfo.totalWeight;
    }

    samplePdf = max( samplePdf, MIN_PDF );
    combinedPdf = max( combinedPdf, MIN_PDF );

    // MIS weight calculation
    float misWeight = samplePdf / combinedPdf;

    // Throughput calculation
    vec3 throughput = sampleBrdfValue * NoL * misWeight / samplePdf;

    // Apply global illumination scaling
    throughput *= globalIlluminationIntensity;

    // firefly clamping
    float pathLengthFactor = 1.0 / pow( float( bounceIndex + 1 ), 0.5 );

    // Material-based clamping adjustments (vectorized)
    // Calculate comprehensive firefly threshold using shared utilities
    float materialTolerance = getMaterialFireflyTolerance( material );
    float viewTolerance = getViewDependentTolerance( material, sampleDir, V, N );

    // Environment and bounce-specific adjustments
    float contextMultiplier = 1.0;
    contextMultiplier *= mix( 1.0, 1.8, selectEnv * ( envSamplingBias - 0.5 ) / 1.5 ); // Environment bias
    contextMultiplier *= mix( 1.0, 0.8, step( 2.0, float( bounceIndex ) ) ); // Bounce scaling

    float finalThreshold = calculateFireflyThreshold( fireflyThreshold, materialTolerance * viewTolerance * contextMultiplier, bounceIndex );

    // Apply consistent soft suppression
    throughput = applySoftSuppressionRGB( throughput, finalThreshold, 0.25 );

    result.direction = sampleDir;
    result.throughput = throughput;
    result.misWeight = misWeight;
    result.pdf = samplePdf;

    return result;
}

// -----------------------------------------------------------------------------
// Debug/Helper Functions
// -----------------------------------------------------------------------------

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