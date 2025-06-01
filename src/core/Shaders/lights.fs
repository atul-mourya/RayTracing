// -----------------------------------------------------------------------------
// Uniform Declarations & Structures
// -----------------------------------------------------------------------------

#if MAX_DIRECTIONAL_LIGHTS > 0
uniform float directionalLights[ MAX_DIRECTIONAL_LIGHTS * 7 ];
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

// Fast early exit checks for directional lights
bool shouldSkipDirectionalLight(
    DirectionalLight light,
    vec3 normal,
    RayTracingMaterial material,
    int bounceIndex
) {
    float NoL = dot( normal, light.direction );

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
    }

    return false;
}

// Simplified directional light contribution (much faster than before)
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

    float NoL = dot( normal, light.direction );
    vec3 rayOrigin = hitPoint + normal * 0.001;

    // Shadow test
    float visibility = traceShadowRay( rayOrigin, light.direction, 1000.0, rngState, stats );
    if( visibility <= 0.0 ) {
        return vec3( 0.0 );
    }

    // BRDF evaluation using cache
    vec3 brdfValue = evaluateMaterialResponseCached( viewDir, light.direction, normal, material, matCache );

    // Base contribution
    vec3 contribution = light.color * light.intensity * brdfValue * NoL * visibility;

    // Simple MIS only for first bounce where it matters most
    if( bounceIndex == 0 && brdfSample.pdf > 0.0 ) {
        float brdfAlignment = max( 0.0, dot( brdfSample.direction, light.direction ) );
        float misWeight = mix( 0.9, 0.1, brdfAlignment );
        contribution *= misWeight;
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
    vec3 offset = normal * 0.001; // Ray offset to avoid self-intersection
    vec3 rayOrigin = hitPoint + offset;

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
        float NoL = dot( normal, lightDir );
        float lightFacing = - dot( lightDir, light.normal );

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
                    float lightFacing = - dot( brdfSample.direction, light.normal );

                    if( lightFacing > 0.0 ) {
                        // PDFs for MIS
                        float lightPdf = ( hitDistance * hitDistance ) / ( light.area * lightFacing );

                        // MIS weight using power heuristic
                        float misWeight = powerHeuristic( brdfSample.pdf, lightPdf );

                        // Direct light emission
                        vec3 lightEmission = light.color * light.intensity;
                        float NoL = max( dot( normal, brdfSample.direction ), 0.0 );

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
    int maxDirectionalLights = MAX_DIRECTIONAL_LIGHTS / 7; // Total number of directional lights

    // Adaptive light count based on bounce depth and material
    int directionalLightCount = maxDirectionalLights;
    if( bounceIndex > 0 ) {
        // Reduce light count for secondary bounces
        if( bounceIndex == 1 ) {
            directionalLightCount = min( 4, maxDirectionalLights );
        } else if( bounceIndex == 2 ) {
            directionalLightCount = min( 2, maxDirectionalLights );
        } else {
            // For very deep bounces, only process the most important light
            directionalLightCount = min( 1, maxDirectionalLights );
        }
    }

    // Process lights in importance order (they're already sorted)
    #pragma unroll_loop_start
    for( int i = 0; i < min( 16, directionalLightCount ); i ++ ) {
        if( i >= maxDirectionalLights )
            break;

        DirectionalLight light = getDirectionalLight( i );

        // Quick importance check for directional lights
        float quickDirImportance = light.intensity * max( dot( N, light.direction ), 0.0 );
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

// Optimized strategy selection for indirect lighting
struct SamplingStrategy {
    int type;      // 0=env, 1=brdf, 2=cosine
    float weight;  // Normalized weight for this strategy
};

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

    // Get random sample for selection between sampling strategies
    vec2 randomSample = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex + 1, rngState, - 1 );
    float selectionRand = RandomValue( rngState );

    // Build active sampling strategies
    SamplingStrategy strategies[ 3 ];
    int numActiveStrategies = 0;
    float totalActiveWeight = 0.0;

    // Environment sampling
    if( samplingInfo.envmapImportance > 0.001 && enableEnvironmentLight && shouldUseEnvironmentSampling( bounceIndex, material ) ) {
        strategies[ numActiveStrategies ].type = 0;
        strategies[ numActiveStrategies ].weight = samplingInfo.envmapImportance;
        totalActiveWeight += samplingInfo.envmapImportance;
        numActiveStrategies ++;
    }

    // BRDF sampling strategy
    float brdfWeight = samplingInfo.specularImportance +
        samplingInfo.transmissionImportance +
        samplingInfo.clearcoatImportance;
    if( brdfWeight > 0.001 ) {
        strategies[ numActiveStrategies ].type = 1;
        strategies[ numActiveStrategies ].weight = brdfWeight;
        totalActiveWeight += brdfWeight;
        numActiveStrategies ++;
    }

    // Cosine sampling (diffuse)
    if( samplingInfo.diffuseImportance > 0.001 ) {
        strategies[ numActiveStrategies ].type = 2;
        strategies[ numActiveStrategies ].weight = samplingInfo.diffuseImportance;
        totalActiveWeight += samplingInfo.diffuseImportance;
        numActiveStrategies ++;
    }

    // Fallback if no strategies are active
    if( numActiveStrategies == 0 ) {
        // Default to cosine sampling
        result.direction = cosineWeightedSample( N, randomSample );
        result.pdf = cosineWeightedPDF( max( dot( N, result.direction ), 0.0 ) );
        result.throughput = evaluateMaterialResponse( V, result.direction, N, material ) *
            max( dot( N, result.direction ), 0.0 ) / result.pdf;
        result.misWeight = 1.0;
        return result;
    }

    // Select sampling strategy based on weights
    int selectedStrategy = - 1;
    float cumulativeWeight = 0.0;

    for( int i = 0; i < numActiveStrategies; i ++ ) {
        cumulativeWeight += strategies[ i ].weight / totalActiveWeight;
        if( selectionRand < cumulativeWeight ) {
            selectedStrategy = i;
            break;
        }
    }

    // Fallback to last strategy if rounding errors
    if( selectedStrategy == - 1 ) {
        selectedStrategy = numActiveStrategies - 1;
    }

    // Sample based on selected strategy
    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdfValue;
    vec3 envContribution = vec3( 0.0 );
    int strategyType = strategies[ selectedStrategy ].type;

    if( strategyType == 0 ) {
        // Environment sampling
        if( useEnvMapIS ) {
            EnvMapSample envSample = sampleEnvironmentWithContext( randomSample, bounceIndex, material, V, N );

            sampleDir = envSample.direction;
            samplePdf = envSample.pdf;
            envContribution = envSample.value;

            // Enhanced firefly reduction for environment samples
            float envLuminance = luminance( envContribution );
            if( bounceIndex > 0 && envLuminance > 0.0 ) {
                float maxEnvContribution = 20.0 / float( bounceIndex + 1 );

                // Material-specific adjustments
                if( material.roughness > 0.6 ) {
                    maxEnvContribution *= 2.0; // Diffuse materials handle more variance
                } else if( material.metalness > 0.8 ) {
                    maxEnvContribution *= 0.7; // Metals need tighter control
                }

                if( envLuminance > maxEnvContribution ) {
                    envContribution *= maxEnvContribution / envLuminance;
                }
            }

            sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
        } else {
            // Fallback to cosine sampling but mark as cosine strategy
            sampleDir = cosineWeightedSample( N, randomSample );
            samplePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );
            strategyType = 2; // Mark as cosine for correct MIS
            sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
            envContribution = vec3( 1.0 );
        }
    } else if( strategyType == 1 ) {
        // BRDF sampling
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdfValue = brdfSample.value;
        envContribution = vec3( 1.0 );
    } else {
        // Cosine sampling
        sampleDir = cosineWeightedSample( N, randomSample );
        samplePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
        envContribution = vec3( 1.0 );
    }

    float NoL = max( dot( N, sampleDir ), 0.0 );

    // Lazy PDF evaluation for MIS - only compute PDFs we need
    float combinedPdf = 0.0;

    // Add PDF contribution from each active strategy
    for( int i = 0; i < numActiveStrategies; i ++ ) {
        float stratPdf = 0.0;

        if( strategies[ i ].type == 0 && useEnvMapIS ) {
            // Environment PDF
            stratPdf = envMapSamplingPDFWithContext( sampleDir, bounceIndex, material, V, N );
        } else if( strategies[ i ].type == 1 ) {
            // BRDF PDF
            stratPdf = brdfSample.pdf;
        } else {
            // Cosine PDF
            stratPdf = cosineWeightedPDF( NoL );
        }

        combinedPdf += strategies[ i ].weight * stratPdf / totalActiveWeight;
    }

    samplePdf = max( samplePdf, MIN_PDF );
    combinedPdf = max( combinedPdf, MIN_PDF );

    // MIS weight calculation
    float misWeight = samplePdf / combinedPdf;

    // Calculate throughput
    vec3 throughput;

    if( strategyType == 0 && useEnvMapIS ) {
        // For environment sampling, include environment contribution directly
        throughput = sampleBrdfValue * envContribution * NoL / samplePdf;
    } else {
        // For other strategies, standard calculation
        throughput = sampleBrdfValue * NoL / samplePdf;
    }

    // Apply global illumination scaling
    throughput *= globalIlluminationIntensity;

    // Enhanced firefly clamping with material and environment awareness
    float pathLengthFactor = 1.0 / pow( float( bounceIndex + 1 ), 0.5 );

    // Adjust clamping threshold based on material type
    // View-dependent scaling for glossy materials
    float clampMultiplier = 1.0;

    // Material-based clamping adjustments
    if( material.metalness > 0.7 ) {
        clampMultiplier = 1.5;
    }
    if( material.roughness < 0.2 ) {
        // Additional scaling based on specular alignment
        vec3 reflectDir = reflect( - V, N );
        float specularAlignment = max( 0.0, dot( sampleDir, reflectDir ) );
        float viewDependentScale = mix( 1.0, 2.5, pow( specularAlignment, 4.0 ) );
        clampMultiplier *= viewDependentScale;
    }

    // Environment-specific adjustments
    if( strategyType == 0 && enableEnvironmentLight ) {
        float envScale = mix( 1.0, 1.8, ( envSamplingBias - 0.5 ) / 1.5 );
        clampMultiplier *= envScale;
    }

    // Bounce-dependent scaling
    if( bounceIndex > 2 ) {
        clampMultiplier *= 0.8;
    }

    float maxThroughput = fireflyThreshold * pathLengthFactor * clampMultiplier;

    // Color-preserving clamping
    float maxComponent = max( max( throughput.r, throughput.g ), throughput.b );
    if( maxComponent > maxThroughput ) {
        float excess = maxComponent - maxThroughput;
        float suppressionFactor = maxThroughput / ( maxThroughput + excess * 0.25 );
        throughput *= suppressionFactor;
    }

    // Set result values
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