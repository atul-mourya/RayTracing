// =============================================================================
// LIGHTS INDIRECT
// =============================================================================
// This file contains indirect lighting (global illumination) calculations
// including strategy selection and sampling weight computation.

// -----------------------------------------------------------------------------
// PDF Calculation Helpers
// -----------------------------------------------------------------------------

float calculateTransmissionPDF( vec3 V, vec3 L, vec3 N, float ior, float roughness, bool entering ) {
    // Calculate the half vector for transmission
    float eta = entering ? 1.0 / ior : ior;
    vec3 H = normalize( V + L * eta );

    if( dot( H, N ) < 0.0 )
        H = - H; // Ensure H points into the correct hemisphere

    float VoH = abs( dot( V, H ) );
    float LoH = abs( dot( L, H ) );
    float NoH = abs( dot( N, H ) );

    // GGX distribution
    float D = DistributionGGX( NoH, roughness );

    // Jacobian for transmission
    float denom = square( VoH + LoH * eta );
    float jacobian = ( LoH * eta * eta ) / max( denom, EPSILON );

    return D * NoH * jacobian;
}

float calculateClearcoatPDF( vec3 V, vec3 L, vec3 N, float clearcoatRoughness ) {
    vec3 H = normalize( V + L );
    float NoH = max( dot( N, H ), 0.0 );
    float NoV = max( dot( N, V ), 0.0 );

    return calculateVNDFPDF( NoH, NoV, clearcoatRoughness );
}

// -----------------------------------------------------------------------------
// Sampling Strategy Computation
// -----------------------------------------------------------------------------

// Validation function for sampling info
bool validateSamplingInfo( ImportanceSamplingInfo info ) {
    return ( info.diffuseImportance >= 0.0 ) &&
        ( info.specularImportance >= 0.0 ) &&
        ( info.transmissionImportance >= 0.0 ) &&
        ( info.clearcoatImportance >= 0.0 ) &&
        ( info.envmapImportance >= 0.0 );
}

SamplingStrategyWeights computeSamplingInfo(
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

    // Separate each sampling strategy
    info.specularWeight = samplingInfo.specularImportance;
    info.useSpecular = info.specularWeight > 0.001;

    info.diffuseWeight = samplingInfo.diffuseImportance;
    info.useDiffuse = info.diffuseWeight > 0.001;

    info.transmissionWeight = samplingInfo.transmissionImportance;
    info.useTransmission = info.transmissionWeight > 0.001;

    info.clearcoatWeight = samplingInfo.clearcoatImportance;
    info.useClearcoat = info.clearcoatWeight > 0.001;

    // Calculate total weight
    info.totalWeight = info.envWeight + info.specularWeight + info.diffuseWeight +
        info.transmissionWeight + info.clearcoatWeight;

    // Proper normalization and fallback
    if( info.totalWeight < 0.001 ) {
        // Safe fallback to diffuse sampling
        info = SamplingStrategyWeights( 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, false, false, true, false, false );
    } else {
        // Normalize weights to sum to 1.0
        float invTotal = 1.0 / info.totalWeight;
        info.envWeight *= invTotal;
        info.specularWeight *= invTotal;
        info.diffuseWeight *= invTotal;
        info.transmissionWeight *= invTotal;
        info.clearcoatWeight *= invTotal;
        info.totalWeight = 1.0;
    }

    return info;
}

// Fixed strategy selection with proper cumulative distribution
void selectSamplingStrategy(
    SamplingStrategyWeights weights,
    float randomValue,
    out int selectedStrategy,
    out float strategyPdf
) {
    // Strategy IDs: 0=env, 1=specular, 2=diffuse, 3=transmission, 4=clearcoat

    float cumulative = 0.0;

    if( weights.useEnv ) {
        cumulative += weights.envWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 0;
            strategyPdf = weights.envWeight;
            return;
        }
    }

    if( weights.useSpecular ) {
        cumulative += weights.specularWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 1;
            strategyPdf = weights.specularWeight;
            return;
        }
    }

    if( weights.useDiffuse ) {
        cumulative += weights.diffuseWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 2;
            strategyPdf = weights.diffuseWeight;
            return;
        }
    }

    if( weights.useTransmission ) {
        cumulative += weights.transmissionWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 3;
            strategyPdf = weights.transmissionWeight;
            return;
        }
    }

    if( weights.useClearcoat ) {
        selectedStrategy = 4;
        strategyPdf = weights.clearcoatWeight;
        return;
    }

    // Fallback
    selectedStrategy = 2; // Diffuse
    strategyPdf = weights.useDiffuse ? weights.diffuseWeight : 1.0;
}

// -----------------------------------------------------------------------------
// Indirect Lighting Calculation
// -----------------------------------------------------------------------------

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

    // Validate input sampling info
    if( samplingInfo.diffuseImportance < 0.0 ||
        samplingInfo.specularImportance < 0.0 ||
        samplingInfo.transmissionImportance < 0.0 ||
        samplingInfo.clearcoatImportance < 0.0 ||
        samplingInfo.envmapImportance < 0.0 ) {
        // Fallback to diffuse sampling
        result.direction = cosineWeightedSample( N, vec2( RandomValue( rngState ), RandomValue( rngState ) ) );
        result.throughput = material.color.rgb;
        result.misWeight = 1.0;
        result.pdf = 1.0;
        return result;
    }

    // Use corrected sampling info
    SamplingStrategyWeights weights = computeSamplingInfo( samplingInfo, bounceIndex, material );

    float selectionRand = RandomValue( rngState );
    vec2 sampleRand = vec2( RandomValue( rngState ), RandomValue( rngState ) );

    // Strategy selection
    int selectedStrategy;
    float strategySelectionPdf;
    selectSamplingStrategy( weights, selectionRand, selectedStrategy, strategySelectionPdf );

    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdfValue;

    // Execute selected strategy
    if( selectedStrategy == 0 ) { // Environment
        EnvMapSample envSample = sampleEnvironmentWithContext( sampleRand, bounceIndex, material, V, N );
        sampleDir = envSample.direction;
        samplePdf = envSample.pdf;
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );

    } else if( selectedStrategy == 1 ) { // Specular
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdfValue = brdfSample.value;

    } else if( selectedStrategy == 2 ) { // Diffuse
        sampleDir = cosineWeightedSample( N, sampleRand );
        samplePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );

#ifdef ENABLE_TRANSMISSION
    } else if( selectedStrategy == 3 ) { // Transmission
        bool entering = dot( V, N ) < 0.0;
        MicrofacetTransmissionResult mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, sampleRand, rngState );
        sampleDir = mtResult.direction;
        samplePdf = mtResult.pdf;
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );
#endif // ENABLE_TRANSMISSION

    } else { // Clearcoat (strategy 4)
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdfValue = brdfSample.value;
    }

    float NoL = max( dot( N, sampleDir ), 0.0 );

    // Calculate combined PDF for MIS (all active strategies)
    float combinedPdf = 0.0;

    if( weights.useEnv ) {
        float envPdf = envMapSamplingPDFWithContext( sampleDir, bounceIndex, material, V, N );
        combinedPdf += weights.envWeight * envPdf;
    }

    if( weights.useSpecular ) {
        combinedPdf += weights.specularWeight * brdfSample.pdf;
    }

    if( weights.useDiffuse ) {
        float diffusePdf = cosineWeightedPDF( NoL );
        combinedPdf += weights.diffuseWeight * diffusePdf;
    }

    if( weights.useTransmission && material.transmission > 0.0 ) {
        // Calculate transmission PDF for this direction
        bool entering = dot( V, N ) < 0.0;
        float transmissionPdf = calculateTransmissionPDF( V, sampleDir, N, material.ior, material.roughness, entering );
        combinedPdf += weights.transmissionWeight * transmissionPdf;
    }

    if( weights.useClearcoat && material.clearcoat > 0.0 ) {
        // Calculate clearcoat PDF for this direction
        float clearcoatPdf = calculateClearcoatPDF( V, sampleDir, N, material.clearcoatRoughness );
        combinedPdf += weights.clearcoatWeight * clearcoatPdf;
    }

    // Ensure valid PDFs
    samplePdf = max( samplePdf, MIN_PDF );
    combinedPdf = max( combinedPdf, MIN_PDF );

    // MIS weight calculation
    float misWeight = samplePdf / combinedPdf;

    // Throughput calculation
    vec3 throughput = sampleBrdfValue * NoL * misWeight / samplePdf;

    // Apply global illumination scaling
    throughput *= globalIlluminationIntensity;

    // Apply firefly reduction with proper material context
    float materialTolerance = getMaterialFireflyTolerance( material );
    float viewTolerance = getViewDependentTolerance( material, sampleDir, V, N );
    float finalThreshold = calculateFireflyThreshold( fireflyThreshold, materialTolerance * viewTolerance, bounceIndex );
    throughput = applySoftSuppressionRGB( throughput, finalThreshold, 0.25 );

    result.direction = sampleDir;
    result.throughput = throughput;
    result.misWeight = misWeight;
    result.pdf = samplePdf;

    return result;
}

// -----------------------------------------------------------------------------
// Legacy Direct Lighting System (For backward compatibility)
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
        return vec3( 0.0 );
    }

    // Skip direct lighting for pure glass/transparent materials at deeper bounces
    if( bounceIndex > 1 && hitInfo.material.transmission > 0.95 && hitInfo.material.roughness < 0.1 ) {
        return vec3( 0.0 );
    }

    float importanceThreshold = 0.001 * ( 1.0 + float( bounceIndex ) * 0.5 );

    // Directional lights processing
    #if MAX_DIRECTIONAL_LIGHTS > 0
    int directionalLightCount = MAX_DIRECTIONAL_LIGHTS;
    if( bounceIndex > 0 ) {
        if( bounceIndex == 1 ) {
            directionalLightCount = max( 1, min( 4, MAX_DIRECTIONAL_LIGHTS ) );
        } else if( bounceIndex == 2 ) {
            directionalLightCount = max( 1, min( 2, MAX_DIRECTIONAL_LIGHTS ) );
        } else {
            directionalLightCount = 1;
        }
    }

    #pragma unroll_loop_start
    for( int i = 0; i < min( 16, directionalLightCount ); i ++ ) {
        if( i >= MAX_DIRECTIONAL_LIGHTS )
            break;

        DirectionalLight light = getDirectionalLight( i );
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : ( hitInfo.material.roughness > 0.8 ? 0.7 : 1.0 );
        float quickDirImportance = light.intensity * materialWeight * max( 0.0, dot( N, light.direction ) );
        if( quickDirImportance < importanceThreshold ) {
            continue;
        }

        totalLighting += calculateDirectionalLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, bounceIndex, rngState, stats );
    }
    #pragma unroll_loop_end
    #endif

    // Area lights processing
    #if MAX_AREA_LIGHTS > 0
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

        vec3 lightCenter = light.position - hitInfo.hitPoint;
        float distSq = dot( lightCenter, lightCenter );
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : ( hitInfo.material.roughness > 0.8 ? 0.7 : 1.0 );
        float quickImportance = ( light.intensity * light.area * materialWeight ) / max( distSq, 1.0 );
        if( quickImportance < importanceThreshold ) {
            continue;
        }

        float cosTheta = dot( normalize( lightCenter ), N );
        if( distSq > ( light.intensity * 100.0 ) || ( hitInfo.material.metalness > 0.9 && cosTheta <= 0.0 ) ) {
            continue;
        }

        totalLighting += calculateAreaLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, sampleIndex, bounceIndex, rngState, stats );
    }
    #endif

    // Point lights processing
    #if MAX_POINT_LIGHTS > 0
    int maxPointLightCount = MAX_POINT_LIGHTS;
    if( bounceIndex > 2 ) {
        maxPointLightCount = min( 2, MAX_POINT_LIGHTS );
    } else if( bounceIndex > 1 ) {
        maxPointLightCount = min( 4, MAX_POINT_LIGHTS );
    }

    for( int i = 0; i < maxPointLightCount; i ++ ) {
        if( i >= MAX_POINT_LIGHTS )
            break;

        PointLight light = getPointLight( i );
        if( light.intensity <= 0.0 )
            continue;

        vec3 toLight = light.position - hitInfo.hitPoint;
        float distSq = dot( toLight, toLight );
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : ( hitInfo.material.roughness > 0.8 ? 0.7 : 1.0 );
        float effectiveIntensity = light.intensity * materialWeight;
        if( distSq > ( effectiveIntensity * 10000.0 ) || distSq < 0.001 )
            continue;

        totalLighting += calculatePointLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, bounceIndex, rngState, stats );
    }
    #endif

    // Spot lights processing
    #if MAX_SPOT_LIGHTS > 0
    int maxSpotLightCount = MAX_SPOT_LIGHTS;
    if( bounceIndex > 2 ) {
        maxSpotLightCount = min( 2, MAX_SPOT_LIGHTS );
    } else if( bounceIndex > 1 ) {
        maxSpotLightCount = min( 4, MAX_SPOT_LIGHTS );
    }

    for( int i = 0; i < maxSpotLightCount; i ++ ) {
        if( i >= MAX_SPOT_LIGHTS )
            break;

        SpotLight light = getSpotLight( i );
        if( light.intensity <= 0.0 )
            continue;

        vec3 toLight = light.position - hitInfo.hitPoint;
        float distSq = dot( toLight, toLight );
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : ( hitInfo.material.roughness > 0.8 ? 0.7 : 1.0 );
        float effectiveIntensity = light.intensity * materialWeight;
        if( distSq > ( effectiveIntensity * 10000.0 ) || distSq < 0.001 )
            continue;

        totalLighting += calculateSpotLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, bounceIndex, rngState, stats );
    }
    #endif

    return totalLighting;
}