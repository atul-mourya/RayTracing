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
    // eta is the relative IOR: eta_transmitted / eta_incident
    // When entering: air(1.0) -> material(ior), so eta = ior
    // When exiting: material(ior) -> air(1.0), so eta = 1.0/ior
    float eta = entering ? ior : 1.0 / ior;

    // Transmission half-vector formula (Walter et al. 2007)
    vec3 H = normalize( V + eta * L );

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
    if( enableEnvironmentLight && useEnvMapIS ) {
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
        vec3 envColor;
        samplePdf = sampleEquirectProbability( sampleRand, envColor, sampleDir );
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
        vec3 envColor;
        float envPdf = sampleEquirect( sampleDir, envColor );
        // Only include environment in MIS if it has valid contribution (envPdf > 0)
        if( envPdf > 0.0 ) {
            combinedPdf += weights.envWeight * envPdf;
        }
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
    // float materialTolerance = getMaterialFireflyTolerance( material );
    // float viewTolerance = getViewDependentTolerance( material, sampleDir, V, N );
    // float finalThreshold = calculateFireflyThreshold( fireflyThreshold, materialTolerance * viewTolerance, bounceIndex );
    // throughput = applySoftSuppressionRGB( throughput, finalThreshold, 0.25 );

    result.direction = sampleDir;
    result.throughput = throughput;
    result.misWeight = misWeight;
    result.pdf = samplePdf;

    return result;
}