// =============================================================================
// LIGHTS SAMPLING (ANGLE/D3D11 Optimized)
// =============================================================================
// This file contains light sampling functions, importance-weighted sampling,
// MIS calculations, and the unified direct lighting system.
//
// ANGLE/D3D11 Optimizations Applied:
// - Full struct initialization to avoid X4000 warnings
// - Division guards to avoid X4008 warnings  
// - Restructured loops to avoid X3557 warnings (no early returns in loops)
// - Removed #pragma unroll_loop_start/end (causes ANGLE issues)

// -----------------------------------------------------------------------------
// Helper: Fully Initialize LightSample
// -----------------------------------------------------------------------------
LightSample initLightSample( ) {
    LightSample ls;
    ls.valid = false;
    ls.direction = vec3( 0.0, 1.0, 0.0 );
    ls.emission = vec3( 0.0 );
    ls.distance = 0.0;
    ls.pdf = 0.0;
    ls.lightType = LIGHT_TYPE_POINT;
    return ls;
}

// -----------------------------------------------------------------------------
// Light Sampling Functions
// -----------------------------------------------------------------------------

// Enhanced area light sampling functions
LightSample sampleRectAreaLight( AreaLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
    LightSample lightSample = initLightSample( );

    // Validate light area to prevent NaN
    if( light.area <= 0.0 ) {
        return lightSample;
    }

    // Sample random position on rectangle
    vec3 randomPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );

    vec3 toLight = randomPos - rayOrigin;
    float lightDistSq = dot( toLight, toLight );

    // Guard against zero distance
    if( lightDistSq < 1e-10 ) {
        return lightSample;
    }

    float dist = sqrt( lightDistSq );
    vec3 direction = toLight / dist;
    vec3 lightNormal = normalize( cross( light.u, light.v ) );

    float cosAngle = dot( - direction, lightNormal );

    lightSample.lightType = LIGHT_TYPE_AREA;
    lightSample.emission = light.color * light.intensity;
    lightSample.distance = dist;
    lightSample.direction = direction;
    // Guard division: ensure denominator is never zero
    lightSample.pdf = ( lightDistSq / max( light.area * max( cosAngle, 0.001 ), 1e-10 ) ) * lightSelectionPdf;
    lightSample.valid = cosAngle > 0.0;

    return lightSample;
}

LightSample sampleCircAreaLight( AreaLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
    LightSample lightSample = initLightSample( );

    // Validate light area to prevent NaN
    if( light.area <= 0.0 ) {
        return lightSample;
    }

    // Sample random position on circle
    float r = 0.5 * sqrt( ruv.x );
    float theta = ruv.y * 2.0 * PI;
    float x = r * cos( theta );
    float y = r * sin( theta );

    vec3 randomPos = light.position + light.u * x + light.v * y;

    vec3 toLight = randomPos - rayOrigin;
    float lightDistSq = dot( toLight, toLight );

    // Guard against zero distance
    if( lightDistSq < 1e-10 ) {
        return lightSample;
    }

    float dist = sqrt( lightDistSq );
    vec3 direction = toLight / dist;
    vec3 lightNormal = normalize( cross( light.u, light.v ) );

    float cosAngle = dot( - direction, lightNormal );

    lightSample.lightType = LIGHT_TYPE_AREA;
    lightSample.emission = light.color * light.intensity;
    lightSample.distance = dist;
    lightSample.direction = direction;
    // Guard division
    lightSample.pdf = ( lightDistSq / max( light.area * max( cosAngle, 0.001 ), 1e-10 ) ) * lightSelectionPdf;
    lightSample.valid = cosAngle > 0.0;

    return lightSample;
}

// Enhanced spot light sampling with radius support
LightSample sampleSpotLightWithRadius( SpotLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
    LightSample lightSample = initLightSample( );

    vec3 toLight = light.position - rayOrigin;
    float lightDist = length( toLight );

    // Guard against zero distance
    if( lightDist < 1e-10 ) {
        return lightSample;
    }

    vec3 lightDir = toLight / lightDist;

    // Check cone attenuation
    float spotCosAngle = dot( - lightDir, light.direction );
    float coneCosAngle = cos( light.angle );

    lightSample.lightType = LIGHT_TYPE_SPOT;
    lightSample.direction = lightDir;
    lightSample.distance = lightDist;
    lightSample.pdf = lightSelectionPdf;
    lightSample.valid = spotCosAngle >= coneCosAngle;

    if( lightSample.valid ) {
        float penumbraCosAngle = cos( light.angle * 0.9 ); // 10% penumbra
        float coneAttenuation = getSpotAttenuation( coneCosAngle, penumbraCosAngle, spotCosAngle );
        float distanceAttenuation = getDistanceAttenuation( lightDist, 0.0, 2.0 );

        lightSample.emission = light.color * light.intensity * distanceAttenuation * coneAttenuation;
    } else {
        lightSample.emission = vec3( 0.0 );
    }

    return lightSample;
}

// Enhanced point light sampling with distance attenuation
LightSample samplePointLightWithAttenuation( PointLight light, vec3 rayOrigin, float lightSelectionPdf ) {
    LightSample lightSample = initLightSample( );

    vec3 toLight = light.position - rayOrigin;
    float lightDist = length( toLight );

    // Guard against zero distance
    if( lightDist < 1e-10 ) {
        return lightSample;
    }

    vec3 lightDir = toLight / lightDist;

    // Calculate distance attenuation
    float distanceAttenuation = getDistanceAttenuation( lightDist, 0.0, 2.0 );

    lightSample.lightType = LIGHT_TYPE_POINT;
    lightSample.direction = lightDir;
    lightSample.distance = lightDist;
    lightSample.emission = light.color * light.intensity * distanceAttenuation;
    lightSample.pdf = lightSelectionPdf;
    lightSample.valid = true;

    return lightSample;
}

// -----------------------------------------------------------------------------
// Importance-Weighted Light Sampling
// -----------------------------------------------------------------------------

// ANGLE-optimized: No early returns in loops, full initialization
LightSample sampleLightWithImportance(
    vec3 rayOrigin,
    vec3 normal,
    RayTracingMaterial material,
    vec2 randomSeed,
    int bounceIndex,
    inout uint rngState
) {
    LightSample result = initLightSample( );

    int totalLights = getTotalLightCount( );
    if( totalLights == 0 ) {
        return result;
    }

    float totalWeight = 0.0;
    int lightIndex = 0;

    // -------------------------------------------------------------------------
    // PASS 1: Calculate Total Weight (no early exits)
    // -------------------------------------------------------------------------

    #if MAX_DIRECTIONAL_LIGHTS > 0
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS; i ++ ) {
        if( lightIndex < 16 ) {
            DirectionalLight light = getDirectionalLight( i );
            totalWeight += calculateDirectionalLightImportance( light, rayOrigin, normal, material, bounceIndex );
            lightIndex ++;
        }
    }
    #endif

    #if MAX_AREA_LIGHTS > 0
    for( int i = 0; i < MAX_AREA_LIGHTS; i ++ ) {
        if( lightIndex < 16 ) {
            AreaLight light = getAreaLight( i );
            float importance = ( light.intensity > 0.0 ) ? estimateLightImportance( light, rayOrigin, normal, material ) : 0.0;
            totalWeight += importance;
            lightIndex ++;
        }
    }
    #endif

    #if MAX_POINT_LIGHTS > 0
    for( int i = 0; i < MAX_POINT_LIGHTS; i ++ ) {
        if( lightIndex < 16 ) {
            PointLight light = getPointLight( i );
            totalWeight += calculatePointLightImportance( light, rayOrigin, normal, material );
            lightIndex ++;
        }
    }
    #endif

    #if MAX_SPOT_LIGHTS > 0
    for( int i = 0; i < MAX_SPOT_LIGHTS; i ++ ) {
        if( lightIndex < 16 ) {
            SpotLight light = getSpotLight( i );
            totalWeight += calculateSpotLightImportance( light, rayOrigin, normal, material );
            lightIndex ++;
        }
    }
    #endif

    // -------------------------------------------------------------------------
    // Fallback: Uniform Sampling if no importance
    // -------------------------------------------------------------------------
    if( totalWeight <= 0.0 ) {
        float lightSelection = randomSeed.x * float( totalLights );
        int selectedLight = int( lightSelection );
        // Guard division by zero
        float lightSelectionPdf = 1.0 / max( float( totalLights ), 1.0 );

        LightSample fallbackResult = initLightSample( );
        fallbackResult.pdf = lightSelectionPdf;

        int currentIdx = 0;
        bool sampled = false;

        #if MAX_DIRECTIONAL_LIGHTS > 0
        if( ! sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_DIRECTIONAL_LIGHTS ) {
            DirectionalLight light = getDirectionalLight( selectedLight - currentIdx );
            if( light.intensity > 0.0 ) {
                fallbackResult.direction = normalize( light.direction );
                fallbackResult.emission = light.color * light.intensity;
                fallbackResult.distance = 1e6;
                fallbackResult.lightType = LIGHT_TYPE_DIRECTIONAL;
                fallbackResult.valid = true;
                sampled = true;
            }
        }
        currentIdx += MAX_DIRECTIONAL_LIGHTS;
        #endif

        #if MAX_AREA_LIGHTS > 0
        if( ! sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_AREA_LIGHTS ) {
            AreaLight light = getAreaLight( selectedLight - currentIdx );
            if( light.intensity > 0.0 ) {
                vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
                fallbackResult = sampleRectAreaLight( light, rayOrigin, uv, lightSelectionPdf );
                sampled = true;
            }
        }
        currentIdx += MAX_AREA_LIGHTS;
        #endif

        #if MAX_POINT_LIGHTS > 0
        if( ! sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_POINT_LIGHTS ) {
            PointLight light = getPointLight( selectedLight - currentIdx );
            if( light.intensity > 0.0 ) {
                fallbackResult = samplePointLightWithAttenuation( light, rayOrigin, lightSelectionPdf );
                sampled = true;
            }
        }
        currentIdx += MAX_POINT_LIGHTS;
        #endif

        #if MAX_SPOT_LIGHTS > 0
        if( ! sampled && selectedLight >= currentIdx && selectedLight < currentIdx + MAX_SPOT_LIGHTS ) {
            SpotLight light = getSpotLight( selectedLight - currentIdx );
            if( light.intensity > 0.0 ) {
                vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
                fallbackResult = sampleSpotLightWithRadius( light, rayOrigin, uv, lightSelectionPdf );
                sampled = true;
            }
        }
        #endif

        return fallbackResult;
    }

    // -------------------------------------------------------------------------
    // PASS 2: Select and Sample Light (no early returns in loops)
    // -------------------------------------------------------------------------

    float selectionValue = randomSeed.x * totalWeight;
    float cumulative = 0.0;
    lightIndex = 0;

    // Track which light was selected
    int selectedType = - 1;      // 0=dir, 1=area, 2=point, 3=spot
    int selectedIdx = - 1;
    float selectedImportance = 0.0;

    #if MAX_DIRECTIONAL_LIGHTS > 0
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS; i ++ ) {
        if( lightIndex < 16 && selectedType < 0 ) {
            DirectionalLight light = getDirectionalLight( i );
            float importance = calculateDirectionalLightImportance( light, rayOrigin, normal, material, bounceIndex );
            float prevCumulative = cumulative;
            cumulative += importance;

            if( selectionValue > prevCumulative && selectionValue <= cumulative ) {
                selectedType = 0;
                selectedIdx = i;
                selectedImportance = importance;
            }
        }
        lightIndex ++;
    }
    #endif

    #if MAX_AREA_LIGHTS > 0
    for( int i = 0; i < MAX_AREA_LIGHTS; i ++ ) {
        if( lightIndex < 16 && selectedType < 0 ) {
            AreaLight light = getAreaLight( i );
            float importance = ( light.intensity > 0.0 ) ? estimateLightImportance( light, rayOrigin, normal, material ) : 0.0;
            float prevCumulative = cumulative;
            cumulative += importance;

            if( selectionValue > prevCumulative && selectionValue <= cumulative ) {
                selectedType = 1;
                selectedIdx = i;
                selectedImportance = importance;
            }
        }
        lightIndex ++;
    }
    #endif

    #if MAX_POINT_LIGHTS > 0
    for( int i = 0; i < MAX_POINT_LIGHTS; i ++ ) {
        if( lightIndex < 16 && selectedType < 0 ) {
            PointLight light = getPointLight( i );
            float importance = calculatePointLightImportance( light, rayOrigin, normal, material );
            float prevCumulative = cumulative;
            cumulative += importance;

            if( selectionValue > prevCumulative && selectionValue <= cumulative ) {
                selectedType = 2;
                selectedIdx = i;
                selectedImportance = importance;
            }
        }
        lightIndex ++;
    }
    #endif

    #if MAX_SPOT_LIGHTS > 0
    for( int i = 0; i < MAX_SPOT_LIGHTS; i ++ ) {
        if( lightIndex < 16 && selectedType < 0 ) {
            SpotLight light = getSpotLight( i );
            float importance = calculateSpotLightImportance( light, rayOrigin, normal, material );
            float prevCumulative = cumulative;
            cumulative += importance;

            if( selectionValue > prevCumulative && selectionValue <= cumulative ) {
                selectedType = 3;
                selectedIdx = i;
                selectedImportance = importance;
            }
        }
        lightIndex ++;
    }
    #endif

    // -------------------------------------------------------------------------
    // PASS 3: Sample the selected light (outside loops)
    // -------------------------------------------------------------------------

    // Guard division by zero
    float pdf = selectedImportance / max( totalWeight, 1e-10 );

    #if MAX_DIRECTIONAL_LIGHTS > 0
    if( selectedType == 0 && selectedIdx >= 0 ) {
        DirectionalLight light = getDirectionalLight( selectedIdx );

        vec3 direction;
        float dirPdf = 1.0;

        if( light.angle > 0.0 ) {
            float cosHalfAngle = cos( light.angle * 0.5 );
            float cosTheta = mix( cosHalfAngle, 1.0, randomSeed.y );
            float sinTheta = sqrt( max( 0.0, 1.0 - cosTheta * cosTheta ) );
            float phi = 2.0 * PI * RandomValue( rngState );

            vec3 w = normalize( light.direction );
            vec3 u = normalize( cross( abs( w.x ) > 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ), w ) );
            vec3 v = cross( w, u );

            direction = normalize( cosTheta * w + sinTheta * ( cos( phi ) * u + sin( phi ) * v ) );
            // Guard division: (1.0 - cosHalfAngle) could be zero if angle is 0
            float solidAngle = 2.0 * PI * max( 1.0 - cosHalfAngle, 1e-10 );
            dirPdf = 1.0 / solidAngle;
        } else {
            direction = normalize( light.direction );
        }

        result.direction = direction;
        result.emission = light.color * light.intensity;
        result.distance = 1e6;
        result.pdf = dirPdf * pdf;
        result.lightType = LIGHT_TYPE_DIRECTIONAL;
        result.valid = true;
    }
    #endif

    #if MAX_AREA_LIGHTS > 0
    if( selectedType == 1 && selectedIdx >= 0 ) {
        AreaLight light = getAreaLight( selectedIdx );
        vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
        result = sampleRectAreaLight( light, rayOrigin, uv, pdf );
    }
    #endif

    #if MAX_POINT_LIGHTS > 0
    if( selectedType == 2 && selectedIdx >= 0 ) {
        PointLight light = getPointLight( selectedIdx );
        result = samplePointLightWithAttenuation( light, rayOrigin, pdf );
    }
    #endif

    #if MAX_SPOT_LIGHTS > 0
    if( selectedType == 3 && selectedIdx >= 0 ) {
        SpotLight light = getSpotLight( selectedIdx );
        vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
        result = sampleSpotLightWithRadius( light, rayOrigin, uv, pdf );
    }
    #endif

    return result;
}

// -----------------------------------------------------------------------------
// Material PDF Calculation for MIS
// -----------------------------------------------------------------------------

// Helper function to calculate material PDF for a given direction
float calculateMaterialPDF( vec3 viewDir, vec3 lightDir, vec3 normal, RayTracingMaterial material ) {
    float NoV = max( 0.0, dot( normal, viewDir ) );
    float NoL = max( 0.0, dot( normal, lightDir ) );
    vec3 H = normalize( viewDir + lightDir );
    float NoH = max( 0.0, dot( normal, H ) );
    float VoH = max( 0.0, dot( viewDir, H ) );

    // Calculate lobe weights
    float diffuseWeight = ( 1.0 - material.metalness ) * ( 1.0 - material.transmission );
    float specularWeight = 1.0 - diffuseWeight * ( 1.0 - material.metalness );
    float totalWeight = diffuseWeight + specularWeight;

    if( totalWeight <= 0.0 ) {
        return 0.0;
    }

    // Guard division
    float invTotalWeight = 1.0 / max( totalWeight, 1e-10 );
    diffuseWeight *= invTotalWeight;
    specularWeight *= invTotalWeight;

    float pdf = 0.0;

    // Diffuse PDF (cosine-weighted hemisphere)
    if( diffuseWeight > 0.0 && NoL > 0.0 ) {
        pdf += diffuseWeight * NoL * PI_INV;
    }

    // Specular PDF (VNDF sampling used in path tracer)
    if( specularWeight > 0.0 && NoL > 0.0 ) {
        float roughness = max( material.roughness, 0.02 );
        pdf += specularWeight * calculateVNDFPDF( NoH, NoV, roughness );
    }

    return max( pdf, 1e-8 );
}

// Enhanced area light sampling with proper MIS and validation
vec3 sampleAreaLightContribution(
    AreaLight light,
    vec3 worldWo,
    HitInfo surf,
    vec3 rayOrigin,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Sample random position on light surface
    vec2 ruv = vec2( RandomValue( rngState ), RandomValue( rngState ) );
    vec3 lightPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );

    vec3 toLight = lightPos - rayOrigin;
    float lightDistSq = dot( toLight, toLight );

    // Guard against zero distance
    if( lightDistSq < 1e-10 ) {
        return vec3( 0.0 );
    }

    float lightDist = sqrt( lightDistSq );
    vec3 lightDir = toLight / lightDist;

    // Check if light is facing the surface
    vec3 lightNormal = normalize( cross( light.u, light.v ) );
    float lightFacing = dot( - lightDir, lightNormal );

    if( lightFacing <= 0.0 ) {
        return vec3( 0.0 );
    }

    // Check if surface is facing the light
    float surfaceFacing = dot( surf.normal, lightDir );
    if( surfaceFacing <= 0.0 ) {
        return vec3( 0.0 );
    }

    // Validate direction
    if( ! isDirectionValid( lightDir, surf.normal ) ) {
        return vec3( 0.0 );
    }

    // Test for occlusion
    float visibility = traceShadowRay( rayOrigin, lightDir, lightDist - 0.001, rngState, stats );
    if( visibility <= 0.0 ) {
        return vec3( 0.0 );
    }

    // Calculate BRDF
    vec3 brdfColor = evaluateMaterialResponse( worldWo, lightDir, surf.normal, surf.material );

    // Calculate light PDF - guard division
    float lightPdf = lightDistSq / max( light.area * lightFacing, EPSILON );

    // Calculate BRDF PDF for MIS
    float brdfPdf = calculateMaterialPDF( worldWo, lightDir, surf.normal, surf.material );

    // Apply MIS weighting
    float misWeight = ( brdfPdf > 0.0 ) ? misHeuristic( lightPdf, brdfPdf ) : 1.0;

    // Calculate final contribution - guard division
    vec3 lightEmission = light.color * light.intensity;
    vec3 contribution = lightEmission * brdfColor * surfaceFacing * visibility * misWeight / max( lightPdf, MIN_PDF );

    return contribution;
}

// -----------------------------------------------------------------------------
// Unified Direct Lighting System
// -----------------------------------------------------------------------------

// Optimized direct lighting function with importance-based sampling and better MIS
vec3 calculateDirectLightingUnified(
    HitInfo hitInfo,
    vec3 viewDir,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    vec3 totalContribution = vec3( 0.0 );
    vec3 rayOrigin = hitInfo.hitPoint + hitInfo.normal * 0.001;

    // Early exit for highly emissive surfaces
    if( hitInfo.material.emissiveIntensity > 10.0 ) {
        return vec3( 0.0 );
    }

    // Adaptive MIS Strategy Selection
    vec3 currentThroughput = vec3( 1.0 );
    MISStrategy misStrategy = selectOptimalMISStrategy( hitInfo.material, bounceIndex, currentThroughput );

    // Adaptive light processing
    int totalLights = getTotalLightCount( );
    if( totalLights == 0 && ! enableEnvironmentLight ) {
        return vec3( 0.0 );
    }

    float importanceThreshold = 0.001 * ( 1.0 + float( bounceIndex ) * 0.5 );

    // Check if discrete lights exist
    bool hasDiscreteLights = totalLights > 0;

    // Calculate total sampling weight only include light weight if lights exist
    float totalSamplingWeight = 0.0;
    if( misStrategy.useLightSampling && hasDiscreteLights ) {
        totalSamplingWeight += misStrategy.lightWeight;
    }
    if( misStrategy.useBRDFSampling ) {
        totalSamplingWeight += misStrategy.brdfWeight;
    }
    if( misStrategy.useEnvSampling && enableEnvironmentLight ) {
        totalSamplingWeight += misStrategy.envWeight;
    }

    if( totalSamplingWeight <= 0.0 ) {
        totalSamplingWeight = 1.0;
        // Fallback: prioritize environment if enabled, otherwise BRDF
        if( enableEnvironmentLight ) {
            misStrategy.useEnvSampling = true;
            misStrategy.envWeight = 1.0;
        } else {
            misStrategy.useBRDFSampling = true;
            misStrategy.brdfWeight = 1.0;
        }
    }

    vec2 stratifiedRandom = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, - 1 );

    // Determine sampling technique
    float rand = stratifiedRandom.x;
    bool sampleLights = false;
    bool sampleBRDF = false;
    bool sampleEnv = false;

    // Calculate effective weights for probability (only include light weight if lights exist)
    float effectiveLightWeight = hasDiscreteLights ? misStrategy.lightWeight : 0.0;
    // Guard division
    float invTotalSamplingWeight = 1.0 / max( totalSamplingWeight, 1e-10 );
    float cumulativeLight = effectiveLightWeight * invTotalSamplingWeight;
    float cumulativeBRDF = ( effectiveLightWeight + misStrategy.brdfWeight ) * invTotalSamplingWeight;

    if( rand < cumulativeLight && misStrategy.useLightSampling && hasDiscreteLights ) {
        sampleLights = true;
    } else if( rand < cumulativeBRDF && misStrategy.useBRDFSampling ) {
        sampleBRDF = true;
    } else if( misStrategy.useEnvSampling && enableEnvironmentLight ) {
        sampleEnv = true;
    } else if( hasDiscreteLights ) {
        // Fallback to light sampling only if lights exist
        sampleLights = true;
    } else if( enableEnvironmentLight ) {
        // Fallback to environment sampling when no discrete lights
        sampleEnv = true;
    }

    if( sampleLights ) {
        // Importance-weighted light sampling
        vec2 lightRandom = vec2( stratifiedRandom.y, RandomValue( rngState ) );
        LightSample lightSample = sampleLightWithImportance( rayOrigin, hitInfo.normal, hitInfo.material, lightRandom, bounceIndex, rngState );

        if( lightSample.valid && lightSample.pdf > 0.0 ) {
            float NoL = max( 0.0, dot( hitInfo.normal, lightSample.direction ) );
            float lightImportance = lightSample.emission.r + lightSample.emission.g + lightSample.emission.b;

            if( NoL > 0.0 && lightImportance * NoL > importanceThreshold && isDirectionValid( lightSample.direction, hitInfo.normal ) ) {
                float shadowDistance = min( lightSample.distance - 0.001, 1000.0 );
                float visibility = traceShadowRay( rayOrigin, lightSample.direction, shadowDistance, rngState, stats );

                if( visibility > 0.0 ) {
                    vec3 brdfValue = evaluateMaterialResponse( viewDir, lightSample.direction, hitInfo.normal, hitInfo.material );
                    float brdfPdf = calculateMaterialPDF( viewDir, lightSample.direction, hitInfo.normal, hitInfo.material );

                    float misWeight = 1.0;
                    if( brdfPdf > 0.0 && misStrategy.useBRDFSampling ) {
                        float lightPdfWeighted = lightSample.pdf * misStrategy.lightWeight;
                        float brdfPdfWeighted = brdfPdf * misStrategy.brdfWeight;

                        if( lightSample.lightType == LIGHT_TYPE_AREA ) {
                            misWeight = powerHeuristic( lightPdfWeighted, brdfPdfWeighted );
                        } else if( bounceIndex == 0 && lightSample.lightType == LIGHT_TYPE_DIRECTIONAL ) {
                            misWeight = powerHeuristic( lightPdfWeighted, brdfPdfWeighted );
                        }
                    }

                    // Guard division
                    vec3 lightContribution = lightSample.emission * brdfValue * NoL * visibility * misWeight / max( lightSample.pdf, 1e-10 );
                    totalContribution += lightContribution * totalSamplingWeight / max( misStrategy.lightWeight, 1e-10 );
                }
            }
        }
    }

    if( sampleBRDF ) {
        // BRDF sampling strategy
        if( brdfSample.pdf > 0.0 && misStrategy.useBRDFSampling ) {
            float NoL = max( 0.0, dot( hitInfo.normal, brdfSample.direction ) );

            if( NoL > 0.0 && isDirectionValid( brdfSample.direction, hitInfo.normal ) ) {
                #if MAX_AREA_LIGHTS > 0
                bool foundIntersection = false;
                float maxImportance = 0.0;
                int maxImportanceLight = - 1;

                // ANGLE-optimized: No early break, track best match
                for( int i = 0; i < MAX_AREA_LIGHTS; i ++ ) {
                    AreaLight light = getAreaLight( i );
                    if( light.intensity > 0.0 ) {
                        float lightImportance = estimateLightImportance( light, hitInfo.hitPoint, hitInfo.normal, hitInfo.material );
                        if( lightImportance >= importanceThreshold ) {
                            float hitDistance = 1e6;
                            if( intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance ) ) {
                                if( lightImportance > maxImportance ) {
                                    maxImportance = lightImportance;
                                    maxImportanceLight = i;
                                }
                                foundIntersection = true;
                            }
                        }
                    }
                }

                if( foundIntersection && maxImportanceLight >= 0 ) {
                    AreaLight light = getAreaLight( maxImportanceLight );
                    float hitDistance = 1e6;

                    if( intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance ) ) {
                        float shadowDistance = min( hitDistance - 0.001, 1000.0 );
                        float visibility = traceShadowRay( rayOrigin, brdfSample.direction, shadowDistance, rngState, stats );

                        if( visibility > 0.0 ) {
                            float lightFacing = max( 0.0, - dot( brdfSample.direction, light.normal ) );
                            if( lightFacing > 0.0 ) {
                                float lightDistSq = hitDistance * hitDistance;
                                // Guard division
                                float lightPdf = lightDistSq / max( light.area * lightFacing, EPSILON );
                                lightPdf /= max( float( totalLights ), 1.0 );

                                float brdfPdfWeighted = brdfSample.pdf * misStrategy.brdfWeight;
                                float lightPdfWeighted = lightPdf * misStrategy.lightWeight;
                                float misWeight = powerHeuristic( brdfPdfWeighted, lightPdfWeighted );

                                vec3 lightEmission = light.color * light.intensity;
                                // Guard division
                                vec3 brdfContribution = lightEmission * brdfSample.value * NoL * visibility * misWeight / max( brdfSample.pdf, 1e-10 );
                                totalContribution += brdfContribution * totalSamplingWeight / max( misStrategy.brdfWeight, 1e-10 );
                            }
                        }
                    }
                }
                #endif
            }
        }
    }

    if( sampleEnv ) {
        // Environment sampling
        if( enableEnvironmentLight && misStrategy.useEnvSampling ) {
            vec2 envRandom = vec2( RandomValue( rngState ), RandomValue( rngState ) );
            vec3 envColor = vec3( 0.0 );
            vec3 envDirection = vec3( 0.0, 1.0, 0.0 );
            float envPdf = sampleEquirectProbability( envRandom, envColor, envDirection );

            if( envPdf > 0.0 ) {
                float NoL = max( 0.0, dot( hitInfo.normal, envDirection ) );

                if( NoL > 0.0 && isDirectionValid( envDirection, hitInfo.normal ) ) {
                    float visibility = traceShadowRay( rayOrigin, envDirection, 1000.0, rngState, stats );

                    if( visibility > 0.0 ) {
                        vec3 brdfValue = evaluateMaterialResponse( viewDir, envDirection, hitInfo.normal, hitInfo.material );
                        float brdfPdf = calculateMaterialPDF( viewDir, envDirection, hitInfo.normal, hitInfo.material );

                        float envPdfWeighted = envPdf * misStrategy.envWeight;
                        float brdfPdfWeighted = brdfPdf * misStrategy.brdfWeight;
                        float misWeight = ( brdfPdf > 0.0 ) ? powerHeuristic( envPdfWeighted, brdfPdfWeighted ) : 1.0;

                        // Guard division
                        vec3 envContribution = envColor * brdfValue * NoL * visibility * misWeight / max( envPdf, 1e-10 );
                        totalContribution += envContribution * totalSamplingWeight / max( misStrategy.envWeight, 1e-10 );
                    }
                }
            }
        }
    }

    // EMISSIVE TRIANGLE DIRECT LIGHTING
    // NOTE: Emissive triangle sampling is handled separately in pathtracer_core.fs
    // to bypass firefly suppression. Do not add it here to avoid double-counting.

    return totalContribution;
}