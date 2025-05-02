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

        // Get transmission data
        TransmissionResult transResult = handleTransmission( shadowRay.direction, shadowHit.normal, shadowHit.material, isEntering, rngState );

        // Calculate how much light gets through
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

// Helper function to determine if a BRDF sample aligns with a directional light
float directionalLightAlignment( vec3 brdfDirection, vec3 lightDirection, float threshold ) {
    float alignment = dot( brdfDirection, lightDirection );

    // Use smooth step for soft transition based on alignment threshold
    return smoothstep( threshold - 0.01, threshold, alignment );
}

// -----------------------------------------------------------------------------
// Light Importance & Contribution Calculations
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
                vec3 brdfValue = evaluateMaterialResponse( viewDir, lightDir, normal, material );

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

// Optimized directional light contribution calculation
vec3 calculateDirectionalLightContribution(
    DirectionalLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    DirectionSample brdfSample,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Early exits for performance
    if( light.intensity <= 0.001 )
        return vec3( 0.0 );

    float NoL = dot( normal, light.direction );

    if( NoL <= 0.001 )
        return vec3( 0.0 );

    // Material-specific early exits
    if( material.metalness > 0.9 ) {
        vec3 reflectDir = reflect( - viewDir, normal );
        float alignment = dot( reflectDir, light.direction );

        float roughnessAdjustedThreshold = max( 0.5, 0.98 - material.roughness * 0.5 );
        if( alignment < roughnessAdjustedThreshold && material.roughness < 0.2 )
            return vec3( 0.0 );
    }

    // Importance-based culling
    float importance = light.intensity * NoL;
    float threshold = 0.01; // default

    if( material.roughness < 0.3 )
        threshold = 0.005; // lower threshold for specular materials
    else if( material.roughness > 0.7 && material.metalness < 0.3 )
        threshold = 0.02; // higher threshold for diffuse materials

    if( importance < threshold && bounceIndex > 0 )
        return vec3( 0.0 );

    // Begin light calculations
    vec3 contribution = vec3( 0.0 );
    bool isFirstBounce = bounceIndex == 0;
    vec3 rayOrigin = hitPoint + normal * 0.001;

    // Material classification
    bool isMetallic = material.metalness > 0.7;
    bool isDiffuse = material.roughness > 0.7 && material.metalness < 0.3;
    bool isGlossy = material.roughness < 0.5;

    // --------------------------
    // 1. DIRECT LIGHT SAMPLING
    // --------------------------
    if( ! ( isMetallic && NoL < 0.1 ) ) {
        float visibility = traceShadowRay( rayOrigin, light.direction, 1000.0, rngState, stats );

        if( visibility > 0.0 ) {
            vec3 brdfValue = evaluateMaterialResponse( viewDir, light.direction, normal, material );
            vec3 directContribution = light.color * light.intensity * brdfValue * NoL;

            if( isFirstBounce && brdfSample.pdf > 0.0 ) {
                float misWeight = 0.9; // Bias toward direct sampling for directional lights
                contribution += directContribution * misWeight * visibility;
            } else {
                contribution += directContribution * visibility;
            }
        }
    }

    // --------------------------
    // 2. BRDF SAMPLING CONTRIBUTION
    // --------------------------
    if( bounceIndex > 1 && isDiffuse )
        return contribution;

    if( ( isFirstBounce || material.roughness < 0.5 ) && brdfSample.pdf > 0.0 ) {
        float alignment = directionalLightAlignment( brdfSample.direction, light.direction, 0.999 - material.roughness * 0.5 );

        if( alignment > 0.05 ) {
            float visibility = traceShadowRay( rayOrigin, brdfSample.direction, 1000.0, rngState, stats );

            if( visibility > 0.0 ) {
                float NoL = max( dot( normal, brdfSample.direction ), 0.0 );
                vec3 brdfContribution = light.color * light.intensity *
                    brdfSample.value * NoL * alignment;

                float misWeight = 0.1; // Smaller weight for BRDF samples
                contribution += brdfContribution * misWeight * visibility;
            }
        }
    }

    return contribution;
}

// -----------------------------------------------------------------------------
// Master Lighting Functions
// -----------------------------------------------------------------------------

// Updated version of the calculateDirectLightingMIS function
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
    vec3 rayOrigin = hitInfo.hitPoint + N * 0.001;

    // Material properties for light selection strategies
    bool isSpecular = hitInfo.material.roughness < 0.2 || hitInfo.material.metalness > 0.9;
    bool isDiffuse = hitInfo.material.roughness > 0.7 && hitInfo.material.metalness < 0.3;
    bool isFirstBounce = bounceIndex == 0;

    // -----------------------------
    // Directional lights processing
    // -----------------------------
    #if MAX_DIRECTIONAL_LIGHTS > 0
    int maxLights = MAX_DIRECTIONAL_LIGHTS / 7; // Total number of directional lights

    // Strategy 1: Always process all lights for first bounce (for quality)
    if( isFirstBounce ) {
        for( int i = 0; i < maxLights; i ++ ) {
            DirectionalLight light = getDirectionalLight( i );
            totalLighting += calculateDirectionalLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, brdfSample, bounceIndex, rngState, stats );
        }
    } 
    // Strategy 2: For secondary+ bounces, use unified importance sampling
    else {
        // Use a single light selection method for all secondary bounces
        int numToProcess = min(4, maxLights);
        float importanceValues[16];
        int lightIndices[16];

        // Initialize arrays
        #pragma unroll_loop_start
        for (int i = 0; i < min(16, maxLights); i++) {
            DirectionalLight light = getDirectionalLight(i);
            float NoL = max(0.0, dot(N, light.direction));
            
            // Simple importance metric
            importanceValues[i] = light.intensity * NoL;
            
            // Store original indices
            lightIndices[i] = i;
        }
        #pragma unroll_loop_end

        // Selection algorithm: find top N lights with linear scans
        // This is more GPU-friendly than bubble sort (O(N·k) vs O(N²))
        for (int k = 0; k < numToProcess; k++) {
            int maxIdx = k;
            float maxVal = importanceValues[k];
            
            // Single linear scan to find maximum remaining element
            #pragma unroll_loop_start
            for (int i = k + 1; i < min(16, maxLights); i++) {
                // Branchless max using step function
                bool isLarger = importanceValues[i] > maxVal;
                maxIdx = isLarger ? i : maxIdx;
                maxVal = isLarger ? importanceValues[i] : maxVal;
            }
            #pragma unroll_loop_end
            
            // Swap elements (minimal data movement)
            float tempVal = importanceValues[k];
            int tempIdx = lightIndices[k];
            
            importanceValues[k] = importanceValues[maxIdx];
            lightIndices[k] = lightIndices[maxIdx];
            
            importanceValues[maxIdx] = tempVal;
            lightIndices[maxIdx] = tempIdx;
        }

        // Process only the top lights with highest importance
        #pragma unroll_loop_start
        for (int i = 0; i < numToProcess; i++) {
            // Skip negligible contributions
            if (importanceValues[i] < 0.01) continue;
            
            DirectionalLight light = getDirectionalLight(lightIndices[i]);
            totalLighting += calculateDirectionalLightContribution(
                light, hitInfo.hitPoint, N, V, hitInfo.material, 
                brdfSample, bounceIndex, rngState, stats
            );
        }
        #pragma unroll_loop_end
    }
    #endif // MAX_DIRECTIONAL_LIGHTS > 0

    // ----------------------
    // Area lights processing
    // ----------------------
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
        if( distSq > ( light.intensity * 100.0 ) || ( hitInfo.material.metalness > 0.9 && cosTheta <= 0.0 ) )
            continue;

        totalLighting += calculateAreaLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, brdfSample, sampleIndex, bounceIndex, rngState, stats );
    }
    #endif // MAX_AREA_LIGHTS > 0

    return totalLighting;
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

    // Get random sample for selection between sampling strategies
    vec2 randomSample = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex + 1, rngState, - 1 );
    float selectionRand = RandomValue( rngState );

    // Extract importance weights for different sampling strategies
    float envWeight = samplingInfo.envmapImportance;
    float diffuseWeight = samplingInfo.diffuseImportance;
    float specularWeight = samplingInfo.specularImportance;
    float transmissionWeight = samplingInfo.transmissionImportance;
    float clearcoatWeight = samplingInfo.clearcoatImportance;

    // Combine related strategies for simplicity
    float brdfWeight = specularWeight + transmissionWeight + clearcoatWeight;
    float cosineWeight = diffuseWeight;

    // Ensure weights sum to 1.0
    float totalWeight = envWeight + brdfWeight + cosineWeight;
    if( totalWeight <= 0.0 ) {
        // Fallback weights if we have an issue
        envWeight = 0.2;
        brdfWeight = 0.5;
        cosineWeight = 0.3;
        totalWeight = 1.0;
    } else if( abs( totalWeight - 1.0 ) > 0.01 ) {
        // Normalize if not very close to 1.0
        float invTotal = 1.0 / totalWeight;
        envWeight *= invTotal;
        brdfWeight *= invTotal;
        cosineWeight *= invTotal;
    }

    // Initialize sampling variables
    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdfValue;
    int samplingStrategy = 0; // 0=env, 1=brdf, 2=cosine

    // Cumulative probability technique for easier selection
    float cumulativeEnv = envWeight;
    float cumulativeBrdf = cumulativeEnv + brdfWeight;

    // Select sampling technique based on random value and importance weights
    if( selectionRand < cumulativeEnv && envWeight > 0.001 ) {
        // Environment map importance sampling (fallback to cosine sampling)
        sampleDir = cosineWeightedSample( N, randomSample );
        float NoL = max( dot( N, sampleDir ), 0.0 );
        samplePdf = NoL * PI_INV;
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
        samplingStrategy = 0;
    } else if( selectionRand < cumulativeBrdf && brdfWeight > 0.001 ) {
        // Use the pre-computed BRDF sample
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdfValue = brdfSample.value;
        samplingStrategy = 1;
    } else {
        // Cosine-weighted hemisphere sampling
        sampleDir = cosineWeightedSample( N, randomSample );
        float NoL = max( dot( N, sampleDir ), 0.0 );
        samplePdf = cosineWeightedPDF( NoL );
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
        samplingStrategy = 2;
    }

    // Ensure valid NoL (cos theta)
    float NoL = max( dot( N, sampleDir ), 0.0 );

    // Calculate PDFs for all strategies for MIS
    float brdfPdf = max( brdfSample.pdf, MIN_PDF );
    float cosinePdf = max( cosineWeightedPDF( NoL ), MIN_PDF );
    float envPdf = cosinePdf; // fallback to cosine if env map sampling not implemented

    // Compute combined PDF for MIS
    float combinedPdf = envWeight * envPdf +      // Environment sampling
        brdfWeight * brdfPdf +     // BRDF sampling
        cosineWeight * cosinePdf;  // Cosine sampling

    // Ensure minimum PDF value to prevent NaN/Inf
    samplePdf = max( samplePdf, MIN_PDF );
    combinedPdf = max( combinedPdf, MIN_PDF );

    // Apply balance heuristic for MIS
    float misWeight = samplePdf / combinedPdf;

    // Calculate throughput
    vec3 throughput = sampleBrdfValue * NoL / samplePdf;

    // Apply global illumination scaling
    throughput *= globalIlluminationIntensity;

    // Apply adaptive clamping based on material properties
    float pathLengthFactor = 1.0 / pow( float( bounceIndex + 1 ), 0.5 );

    // Adjust clamping threshold based on material type
    float clampMultiplier = 1.0;
    if( material.metalness > 0.7 )
        clampMultiplier = 2.0; // Metals can be brighter
    if( material.roughness < 0.2 )
        clampMultiplier = 1.5; // Glossy surfaces can be brighter

    float maxThroughput = fireflyThreshold * pathLengthFactor * clampMultiplier;

    // Detect potential fireflies and apply color-preserving clamping
    float maxComponent = max( max( throughput.r, throughput.g ), throughput.b );
    if( maxComponent > maxThroughput ) {
        // Apply smooth clamping to preserve color
        float scale = maxThroughput / maxComponent;
        throughput *= scale;
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