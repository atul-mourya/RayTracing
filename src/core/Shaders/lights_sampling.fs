// =============================================================================
// LIGHTS SAMPLING
// =============================================================================
// This file contains light sampling functions, importance-weighted sampling,
// MIS calculations, and the unified direct lighting system.

// -----------------------------------------------------------------------------
// Light Sampling Functions
// -----------------------------------------------------------------------------

// Enhanced area light sampling functions
LightSample sampleRectAreaLight( AreaLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
	LightSample lightSample;
	lightSample.valid = false;
	
	// Validate light area to prevent NaN
	if( light.area <= 0.0 ) {
		return lightSample;
	}
	
	// Sample random position on rectangle
	vec3 randomPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );

	vec3 toLight = randomPos - rayOrigin;
	float lightDistSq = dot( toLight, toLight );
	float dist = sqrt( lightDistSq );
	vec3 direction = toLight / dist;
	vec3 lightNormal = normalize( cross( light.u, light.v ) );

	lightSample.lightType = LIGHT_TYPE_AREA;
	lightSample.emission = light.color * light.intensity;
	lightSample.distance = dist;
	lightSample.direction = direction;
	lightSample.pdf = ( lightDistSq / ( light.area * max( dot( - direction, lightNormal ), 0.001 ) ) ) * lightSelectionPdf;
	lightSample.valid = dot( - direction, lightNormal ) > 0.0;

	return lightSample;
}

LightSample sampleCircAreaLight( AreaLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
	LightSample lightSample;
	lightSample.valid = false;
	
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
	float dist = sqrt( lightDistSq );
	vec3 direction = toLight / dist;
	vec3 lightNormal = normalize( cross( light.u, light.v ) );

	lightSample.lightType = LIGHT_TYPE_AREA;
	lightSample.emission = light.color * light.intensity;
	lightSample.distance = dist;
	lightSample.direction = direction;
	lightSample.pdf = ( lightDistSq / ( light.area * max( dot( - direction, lightNormal ), 0.001 ) ) ) * lightSelectionPdf;
	lightSample.valid = dot( - direction, lightNormal ) > 0.0;

	return lightSample;
}

// Enhanced spot light sampling with radius support
LightSample sampleSpotLightWithRadius( SpotLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
    vec3 toLight = light.position - rayOrigin;
    float lightDist = length( toLight );
    vec3 lightDir = toLight / lightDist;

    // Check cone attenuation
    float spotCosAngle = dot( - lightDir, light.direction );
    float coneCosAngle = cos( light.angle );

    LightSample lightSample;
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
    vec3 toLight = light.position - rayOrigin;
    float lightDist = length( toLight );
    vec3 lightDir = toLight / lightDist;

    // Calculate distance attenuation
    float distanceAttenuation = getDistanceAttenuation( lightDist, 0.0, 2.0 );

    LightSample lightSample;
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

// Enhanced light sampling with importance weighting for better noise reduction
LightSample sampleLightWithImportance(
    vec3 rayOrigin,
    vec3 normal,
    RayTracingMaterial material,
    vec2 randomSeed,
    int bounceIndex,
    inout uint rngState
) {
    LightSample result;
    result.valid = false;
    result.pdf = 0.0;

    int totalLights = getTotalLightCount( );
    if( totalLights == 0 )
        return result;

    // Calculate light importance weights for better sampling
    float lightWeights[ 16 ]; // Assuming max 16 total lights
    float totalWeight = 0.0;
    int lightIndex = 0;

    // Calculate importance for each light type
    #if MAX_DIRECTIONAL_LIGHTS > 0
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS && lightIndex < 16; i ++ ) {
        DirectionalLight light = getDirectionalLight( i );
        float importance = calculateDirectionalLightImportance( light, rayOrigin, normal, material, bounceIndex );
        lightWeights[ lightIndex ] = importance;
        totalWeight += importance;
        lightIndex ++;
    }
    #endif

    #if MAX_AREA_LIGHTS > 0
    for( int i = 0; i < MAX_AREA_LIGHTS && lightIndex < 16; i ++ ) {
        AreaLight light = getAreaLight( i );
        float importance = estimateLightImportance( light, rayOrigin, normal, material );
        lightWeights[ lightIndex ] = importance;
        totalWeight += importance;
        lightIndex ++;
    }
    #endif

    #if MAX_POINT_LIGHTS > 0
    for( int i = 0; i < MAX_POINT_LIGHTS && lightIndex < 16; i ++ ) {
        PointLight light = getPointLight( i );
        float importance = calculatePointLightImportance( light, rayOrigin, normal, material );
        lightWeights[ lightIndex ] = importance;
        totalWeight += importance;
        lightIndex ++;
    }
    #endif

    #if MAX_SPOT_LIGHTS > 0
    for( int i = 0; i < MAX_SPOT_LIGHTS && lightIndex < 16; i ++ ) {
        SpotLight light = getSpotLight( i );
        float importance = calculateSpotLightImportance( light, rayOrigin, normal, material );
        lightWeights[ lightIndex ] = importance;
        totalWeight += importance;
        lightIndex ++;
    }
    #endif

    if( totalWeight <= 0.0 ) {
        // Fallback to uniform sampling
        float lightSelection = randomSeed.x * float( totalLights );
        int selectedLight = int( lightSelection );
        float lightSelectionPdf = 1.0 / float( totalLights );

        LightSample fallbackResult;
        fallbackResult.valid = false;
        fallbackResult.pdf = lightSelectionPdf;

        #if MAX_DIRECTIONAL_LIGHTS > 0
        if( selectedLight < MAX_DIRECTIONAL_LIGHTS ) {
            DirectionalLight light = getDirectionalLight( selectedLight );
            if( light.intensity > 0.0 ) {
                fallbackResult.direction = normalize( light.direction );
                fallbackResult.emission = light.color * light.intensity;
                fallbackResult.distance = 1e6;
                fallbackResult.lightType = LIGHT_TYPE_DIRECTIONAL;
                fallbackResult.valid = true;
            }
        }
        #endif

        return fallbackResult;
    }

    // Importance-based light selection
    float selectionValue = randomSeed.x * totalWeight;
    float cumulative = 0.0;
    int selectedLight = 0;

    for( int i = 0; i < totalLights && i < 16; i ++ ) {
        cumulative += lightWeights[ i ];
        if( selectionValue <= cumulative ) {
            selectedLight = i;
            break;
        }
    }

    float lightSelectionPdf = lightWeights[ selectedLight ] / totalWeight;

    // Sample the selected light
    result.valid = false;
    result.pdf = lightSelectionPdf;

    int currentIndex = 0;

    // Sample directional lights
    #if MAX_DIRECTIONAL_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_DIRECTIONAL_LIGHTS ) {
        int dirLightIndex = selectedLight - currentIndex;
        DirectionalLight light = getDirectionalLight( dirLightIndex );
        if( light.intensity > 0.0 ) {
            vec3 direction;
            float pdf = 1.0;

            if( light.angle > 0.0 ) {
                // Soft directional light - sample within cone
                float cosHalfAngle = cos( light.angle * 0.5 );
                float cosTheta = mix( cosHalfAngle, 1.0, randomSeed.y );
                float sinTheta = sqrt( max( 0.0, 1.0 - cosTheta * cosTheta ) );
                float phi = 2.0 * PI * RandomValue( rngState );

                vec3 w = normalize( light.direction );
                vec3 u = normalize( cross( abs( w.x ) > 0.9 ? vec3( 0, 1, 0 ) : vec3( 1, 0, 0 ), w ) );
                vec3 v = cross( w, u );

                direction = normalize( cosTheta * w + sinTheta * ( cos( phi ) * u + sin( phi ) * v ) );
                pdf = 1.0 / ( 2.0 * PI * ( 1.0 - cosHalfAngle ) );
            } else {
                direction = normalize( light.direction );
            }

            result.direction = direction;
            result.emission = light.color * light.intensity;
            result.distance = 1e6;
            result.pdf = pdf * lightSelectionPdf;
            result.lightType = LIGHT_TYPE_DIRECTIONAL;
            result.valid = true;
            return result;
        }
    }
    currentIndex += MAX_DIRECTIONAL_LIGHTS;
    #endif

    #if MAX_AREA_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_AREA_LIGHTS ) {
        int areaLightIndex = selectedLight - currentIndex;
        AreaLight light = getAreaLight( areaLightIndex );
        if( light.intensity > 0.0 ) {
            vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
            return sampleRectAreaLight( light, rayOrigin, uv, lightSelectionPdf );
        }
    }
    currentIndex += MAX_AREA_LIGHTS;
    #endif

    #if MAX_POINT_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_POINT_LIGHTS ) {
        int pointLightIndex = selectedLight - currentIndex;
        PointLight light = getPointLight( pointLightIndex );
        if( light.intensity > 0.0 ) {
            return samplePointLightWithAttenuation( light, rayOrigin, lightSelectionPdf );
        }
    }
    currentIndex += MAX_POINT_LIGHTS;
    #endif

    #if MAX_SPOT_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_SPOT_LIGHTS ) {
        int spotLightIndex = selectedLight - currentIndex;
        SpotLight light = getSpotLight( spotLightIndex );
        if( light.intensity > 0.0 ) {
            vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
            return sampleSpotLightWithRadius( light, rayOrigin, uv, lightSelectionPdf );
        }
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

    if( totalWeight <= 0.0 )
        return 0.0;

    diffuseWeight /= totalWeight;
    specularWeight /= totalWeight;

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

    // Calculate light PDF
    float lightPdf = lightDistSq / ( light.area * lightFacing );

    // Calculate BRDF PDF for MIS
    float brdfPdf = calculateMaterialPDF( worldWo, lightDir, surf.normal, surf.material );

    // Apply MIS weighting
    float misWeight = ( brdfPdf > 0.0 ) ? misHeuristic( lightPdf, brdfPdf ) : 1.0;

    // Calculate final contribution
    vec3 lightEmission = light.color * light.intensity;
    vec3 contribution = lightEmission * brdfColor * surfaceFacing * visibility * misWeight / lightPdf;

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
    if( totalLights == 0 ) {
        return vec3( 0.0 );
    }

    float importanceThreshold = 0.001 * ( 1.0 + float( bounceIndex ) * 0.5 );

    // Calculate total sampling weight
    float totalSamplingWeight = 0.0;
    if( misStrategy.useLightSampling )
        totalSamplingWeight += misStrategy.lightWeight;
    if( misStrategy.useBRDFSampling )
        totalSamplingWeight += misStrategy.brdfWeight;
    if( misStrategy.useEnvSampling && enableEnvironmentLight )
        totalSamplingWeight += misStrategy.envWeight;

    if( totalSamplingWeight <= 0.0 ) {
        totalSamplingWeight = 1.0;
        misStrategy.useLightSampling = true;
        misStrategy.lightWeight = 1.0;
    }

    vec2 stratifiedRandom = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, - 1 );

    // Determine sampling technique
    float rand = stratifiedRandom.x;
    bool sampleLights = false;
    bool sampleBRDF = false;
    bool sampleEnv = false;

    if( rand < misStrategy.lightWeight / totalSamplingWeight && misStrategy.useLightSampling ) {
        sampleLights = true;
    } else if( rand < ( misStrategy.lightWeight + misStrategy.brdfWeight ) / totalSamplingWeight && misStrategy.useBRDFSampling ) {
        sampleBRDF = true;
    } else if( misStrategy.useEnvSampling && enableEnvironmentLight ) {
        sampleEnv = true;
    } else {
        sampleLights = true;
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

                    vec3 lightContribution = lightSample.emission * brdfValue * NoL * visibility * misWeight / lightSample.pdf;
                    totalContribution += lightContribution * totalSamplingWeight / misStrategy.lightWeight;
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

                for( int i = 0; i < MAX_AREA_LIGHTS && ! foundIntersection; i ++ ) {
                    AreaLight light = getAreaLight( i );
                    if( light.intensity <= 0.0 )
                        continue;

                    float lightImportance = estimateLightImportance( light, hitInfo.hitPoint, hitInfo.normal, hitInfo.material );
                    if( lightImportance < importanceThreshold )
                        continue;

                    float hitDistance = 1e6;
                    if( intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance ) ) {
                        if( lightImportance > maxImportance ) {
                            maxImportance = lightImportance;
                            maxImportanceLight = i;
                        }
                        foundIntersection = true;
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
                                float lightPdf = lightDistSq / ( light.area * lightFacing );
                                lightPdf /= float( totalLights );

                                float brdfPdfWeighted = brdfSample.pdf * misStrategy.brdfWeight;
                                float lightPdfWeighted = lightPdf * misStrategy.lightWeight;
                                float misWeight = powerHeuristic( brdfPdfWeighted, lightPdfWeighted );

                                vec3 lightEmission = light.color * light.intensity;
                                vec3 brdfContribution = lightEmission * brdfSample.value * NoL * visibility * misWeight / brdfSample.pdf;
                                totalContribution += brdfContribution * totalSamplingWeight / misStrategy.brdfWeight;
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
            EnvMapSample envSample = sampleEnvironmentWithContext( envRandom, bounceIndex, hitInfo.material, viewDir, hitInfo.normal );

            if( envSample.pdf > 0.0 ) {
                float NoL = max( 0.0, dot( hitInfo.normal, envSample.direction ) );

                if( NoL > 0.0 && isDirectionValid( envSample.direction, hitInfo.normal ) ) {
                    float visibility = traceShadowRay( rayOrigin, envSample.direction, 1000.0, rngState, stats );

                    if( visibility > 0.0 ) {
                        vec3 brdfValue = evaluateMaterialResponse( viewDir, envSample.direction, hitInfo.normal, hitInfo.material );
                        float brdfPdf = calculateMaterialPDF( viewDir, envSample.direction, hitInfo.normal, hitInfo.material );

                        float envPdfWeighted = envSample.pdf * misStrategy.envWeight;
                        float brdfPdfWeighted = brdfPdf * misStrategy.brdfWeight;
                        float misWeight = ( brdfPdf > 0.0 ) ? powerHeuristic( envPdfWeighted, brdfPdfWeighted ) : 1.0;

                        vec3 envContribution = envSample.value * brdfValue * NoL * visibility * misWeight / envSample.pdf;
                        totalContribution += envContribution * totalSamplingWeight / misStrategy.envWeight;
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