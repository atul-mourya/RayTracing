// =============================================================================
// MATERIAL PROPERTIES
// =============================================================================
// This file contains BRDF distribution functions, geometry terms, and
// material weight calculations for physically-based rendering.

// -----------------------------------------------------------------------------
// Microfacet Distribution Functions
// -----------------------------------------------------------------------------

float DistributionGGX( float NoH, float roughness ) {
	float alpha = roughness * roughness;
	float alpha2 = alpha * alpha;
	float denom = ( NoH * NoH * ( alpha2 - 1.0 ) + 1.0 );
	return alpha2 / max( PI * denom * denom, EPSILON );
}

#ifdef ENABLE_SHEEN
float SheenDistribution( float NoH, float roughness ) {
	// Ensure minimum roughness to prevent extreme values
	float clampedRoughness = max( roughness, MIN_ROUGHNESS );
	float alpha = clampedRoughness * clampedRoughness;
	float invAlpha = 1.0 / alpha;
	float d = ( NoH * NoH * ( invAlpha * invAlpha - 1.0 ) + 1.0 );
	// Protect against division by very small values and clamp output
	return min( invAlpha * invAlpha / max( PI * d * d, EPSILON ), 100.0 );
}
#endif // ENABLE_SHEEN

// -----------------------------------------------------------------------------
// Geometry Terms
// -----------------------------------------------------------------------------

float GeometrySchlickGGX( float NdotV, float roughness ) {
	float r = roughness + 1.0;
	float k = ( r * r ) / 8.0;
	return NdotV / max( NdotV * ( 1.0 - k ) + k, EPSILON );
}

float GeometrySmith( float NoV, float NoL, float roughness ) {
	float ggx2 = GeometrySchlickGGX( NoV, roughness );
	float ggx1 = GeometrySchlickGGX( NoL, roughness );
	return ggx1 * ggx2;
}

// -----------------------------------------------------------------------------
// PDF Calculation Helpers
// -----------------------------------------------------------------------------

// Calculate PDF for standard GGX importance sampling
// Used when sampling H directly from GGX distribution (ImportanceSampleGGX)
// Formula: D(H) * NoH / (4 * VoH)
float calculateGGXPDF( float NoH, float VoH, float roughness ) {
	float D = DistributionGGX( NoH, roughness );
	return D * NoH / max( 4.0 * VoH, EPSILON );
}

// Calculate PDF for VNDF (Visible Normal Distribution Function) sampling
// Used when sampling H from visible normals (sampleGGXVNDF)
// Formula: G1(V) * D(H) / (NoV * 4)
// Note: VoH cancels out in the Jacobian transform from H-space to L-space
float calculateVNDFPDF( float NoH, float NoV, float roughness ) {
	float D = DistributionGGX( NoH, roughness );
	float G1 = GeometrySchlickGGX( NoV, roughness );
	return D * G1 / max( NoV * 4.0, EPSILON );
}

// -----------------------------------------------------------------------------
// Iridescence Evaluation
// -----------------------------------------------------------------------------

#ifdef ENABLE_IRIDESCENCE

vec3 evalSensitivity( float OPD, vec3 shift ) {
	float phase = TWO_PI * OPD * 1.0e-9;
	vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
	vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
	vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );

	vec3 xyz = val * sqrt( TWO_PI * var ) * cos( pos * phase + shift ) *
		exp( - square( phase ) * var );
	xyz.x += 9.7470e-14 * sqrt( TWO_PI * 4.5282e+09 ) *
		cos( 2.2399e+06 * phase + shift[ 0 ] ) *
		exp( - 4.5282e+09 * square( phase ) );
	return XYZ_TO_REC709 * ( xyz / 1.0685e-7 );
}

vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
    // Force iridescenceIor -> outsideIOR when thinFilmThickness -> 0.0
	float iridescenceIor = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );

    // Evaluate the cosTheta on the base layer (Snell law)
	float sinTheta2Sq = square( outsideIOR / iridescenceIor ) * ( 1.0 - square( cosTheta1 ) );

    // Handle TIR:
	float cosTheta2Sq = 1.0 - sinTheta2Sq;
	if( cosTheta2Sq < 0.0 ) {
		return vec3( 1.0 );
	}

	float cosTheta2 = sqrt( cosTheta2Sq );

    // First interface
	float R0 = iorToFresnel0( iridescenceIor, outsideIOR );
	float R12 = fresnelSchlick( cosTheta1, R0 );
	float T121 = 1.0 - R12;
	float phi12 = iridescenceIor < outsideIOR ? PI : 0.0;
	float phi21 = PI - phi12;

    // Second interface
	vec3 baseIOR = fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) ); // guard against 1.0
	vec3 R1 = iorToFresnel0( baseIOR, iridescenceIor );
	vec3 R23 = fresnelSchlick( cosTheta2, R1 );
	vec3 phi23 = vec3( 0.0 );
	phi23 = mix( phi23, vec3( PI ), lessThan( baseIOR, vec3( iridescenceIor ) ) );

	float OPD = 2.0 * iridescenceIor * thinFilmThickness * cosTheta2;
	vec3 phi = vec3( phi21 ) + phi23;

    // Compound terms
	vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
	vec3 r123 = sqrt( R123 );
	vec3 Rs = square( T121 ) * R23 / ( vec3( 1.0 ) - R123 );

    // Reflectance term for m = 0 (DC term amplitude)
	vec3 C0 = R12 + Rs;
	vec3 I = C0;
	vec3 Cm = Rs - T121;

	for( int m = 1; m <= 2; ++ m ) {
		Cm *= r123;
		vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
		I += Cm * Sm;
	}

	return max( I, vec3( 0.0 ) );
}

#endif // ENABLE_IRIDESCENCE

// -----------------------------------------------------------------------------
// BRDF Weight Calculation
// -----------------------------------------------------------------------------

// OPTIMIZED: Enhanced BRDF weight calculation using cached values
BRDFWeights calculateBRDFWeights( RayTracingMaterial material, MaterialClassification mc, MaterialCache cache ) {
	BRDFWeights weights;

    // Use precomputed values from cache - eliminates redundant calculations
	float invRoughness = cache.invRoughness;
	float metalFactor = cache.metalFactor;

    // Optimized specular calculation using classification
	float baseSpecularWeight;
	if( mc.isMetallic ) {
        // Metals: ensure strong specular regardless of roughness
		baseSpecularWeight = max( invRoughness * metalFactor, 0.7 );
	} else if( mc.isSmooth ) {
        // Non-metals but smooth: strong specular
		baseSpecularWeight = invRoughness * metalFactor * 1.2;
	} else {
        // Regular specular calculation
		baseSpecularWeight = max( invRoughness * metalFactor, material.metalness * 0.1 );
	}

	weights.specular = baseSpecularWeight * material.specularIntensity;
	weights.diffuse = ( 1.0 - baseSpecularWeight ) * ( 1.0 - material.metalness );

    // Optimized sheen calculation using cached value
	weights.sheen = material.sheen * cache.maxSheenColor;

    // Enhanced clearcoat calculation using classification
	if( mc.hasClearcoat ) {
		weights.clearcoat = material.clearcoat * invRoughness * 0.4; // Boost for classified clearcoat materials
	} else {
		weights.clearcoat = material.clearcoat * invRoughness * 0.35;
	}

    // Enhanced transmission calculation using cached IOR factor
	if( mc.isTransmissive ) {
        // High transmission materials get optimized calculation
		float transmissionBase = cache.iorFactor * invRoughness * 0.8; // Higher base for classified transmissive
		weights.transmission = material.transmission * transmissionBase *
			( 0.6 + 0.4 * material.ior / 2.0 ) *
			( 1.0 + material.dispersion * 0.6 );
	} else {
        // Regular transmission calculation using cached iorFactor
		float transmissionBase = cache.iorFactor * invRoughness * 0.7;
		weights.transmission = material.transmission * transmissionBase *
			( 0.5 + 0.5 * material.ior / 2.0 ) *
			( 1.0 + material.dispersion * 0.5 );
	}

    // Optimized iridescence calculation
	float iridescenceBase = invRoughness * ( mc.isSmooth ? 0.6 : 0.5 );
	weights.iridescence = material.iridescence * iridescenceBase *
		( 0.5 + 0.5 * ( material.iridescenceThicknessRange.y - material.iridescenceThicknessRange.x ) / 1000.0 ) *
		( 0.5 + 0.5 * material.iridescenceIOR / 2.0 );

    // Single normalization pass with enhanced precision
	float total = weights.specular + weights.diffuse + weights.sheen +
		weights.clearcoat + weights.transmission + weights.iridescence;
	float invTotal = 1.0 / max( total, 0.001 );

    // Vectorized multiplication
	weights.specular *= invTotal;
	weights.diffuse *= invTotal;
	weights.sheen *= invTotal;
	weights.clearcoat *= invTotal;
	weights.transmission *= invTotal;
	weights.iridescence *= invTotal;

	return weights;
}

// -----------------------------------------------------------------------------
// Material Importance and Sampling Info
// -----------------------------------------------------------------------------

// Enhanced material importance with better classification utilization - OPTIMIZED
float getMaterialImportance( RayTracingMaterial material, MaterialClassification mc ) {
    // Early out for specialized materials
	if( material.transmission > 0.0 || material.clearcoat > 0.0 ) {
		return 0.95;
	}

    // Base importance from enhanced complexity score
	float baseImportance = mc.complexityScore;

    // Enhanced emissive importance calculation
	float emissiveImportance = 0.0;
	if( mc.isEmissive ) {
		// Use more accurate luminance calculation with proper weights
		float emissiveLuminance = dot( material.emissive, vec3( 0.2126, 0.7152, 0.0722 ) );
		emissiveImportance = min( 0.6, emissiveLuminance * material.emissiveIntensity * 0.25 );
	}

    // Enhanced material-specific boosts using classification
	float materialBoost = 0.0;
	if( mc.isMetallic && mc.isSmooth )
		materialBoost += 0.25; // Perfect reflector
	else if( mc.isMetallic )
		materialBoost += 0.15;

	if( mc.isTransmissive )
		materialBoost += 0.2;
	if( mc.hasClearcoat )
		materialBoost += 0.1;

    // Combine all factors with better weighting
	float totalImportance = max( baseImportance + materialBoost, emissiveImportance );

    // Clamp and return with slight boost for complex materials
	return clamp( totalImportance, 0.0, 1.0 );
}

ImportanceSamplingInfo getImportanceSamplingInfo( RayTracingMaterial material, int bounceIndex, MaterialClassification mc ) {
	ImportanceSamplingInfo info;

    // Base BRDF weights using temporary cache
	MaterialCache tempCache;
	tempCache.invRoughness = 1.0 - material.roughness;
	tempCache.metalFactor = 0.5 + 0.5 * material.metalness;
	tempCache.iorFactor = min( 2.0 / material.ior, 1.0 );
	tempCache.maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );
	BRDFWeights weights = calculateBRDFWeights( material, mc, tempCache );

    // Base importances on BRDF weights
	info.diffuseImportance = weights.diffuse;
	info.specularImportance = weights.specular;
	info.transmissionImportance = weights.transmission;
	info.clearcoatImportance = weights.clearcoat;

    // Vectorized environment importance calculation
	float baseEnvStrength = environmentIntensity * 0.05;

    // Material-based environment factor (vectorized calculations)
	float envMaterialFactor = 1.0;
	envMaterialFactor *= mix( 1.0, 2.5, float( mc.isMetallic ) );           // Metals reflect environment strongly
	envMaterialFactor *= mix( 1.0, 1.8, float( mc.isRough ) );              // Rough materials sample diffusely
	envMaterialFactor *= mix( 1.0, 0.4, float( mc.isTransmissive ) );       // Transmissive materials interact less
	envMaterialFactor *= mix( 1.0, 1.6, float( mc.hasClearcoat ) );         // Clearcoat adds reflection

    // Pure physically-based: treat all bounces equally (matches three-gpu-pathtracer)
	info.envmapImportance = baseEnvStrength * envMaterialFactor;

    // Material-specific adjustments using classification
	if( bounceIndex > 2 ) {
		float depthFactor = 1.0 / float( bounceIndex - 1 );

        // Vectorized depth adjustments
		info.specularImportance *= ( 0.7 + depthFactor * 0.3 );
		info.clearcoatImportance *= ( 0.6 + depthFactor * 0.4 );
		info.diffuseImportance *= ( 1.2 + depthFactor * 0.3 );
	}

    // Fast material-specific boosts using pre-computed classification
	if( mc.isMetallic && bounceIndex < 3 ) {
		info.specularImportance = max( info.specularImportance, 0.6 );
		info.envmapImportance = max( info.envmapImportance, 0.3 );
		info.diffuseImportance *= 0.4;
	}

	if( mc.isTransmissive ) {
		info.transmissionImportance = max( info.transmissionImportance, 0.8 );
		info.diffuseImportance *= 0.2;
		info.specularImportance *= 0.6;
		info.envmapImportance *= 0.7;
	}

	if( mc.hasClearcoat ) {
		info.clearcoatImportance = max( info.clearcoatImportance, 0.4 );
		info.envmapImportance = max( info.envmapImportance, 0.2 );
	}

    // Normalize to sum to 1.0
	float sum = info.diffuseImportance + info.specularImportance +
		info.transmissionImportance + info.clearcoatImportance +
		info.envmapImportance;

	if( sum > 0.001 ) {
		float invSum = 1.0 / sum;
		info.diffuseImportance *= invSum;
		info.specularImportance *= invSum;
		info.transmissionImportance *= invSum;
		info.clearcoatImportance *= invSum;
		info.envmapImportance *= invSum;
	} else {
        // Fallback - prefer environment sampling when IS is available
		if( useEnvMapIS && enableEnvironmentLight ) {
			info.diffuseImportance = 0.4;
			info.envmapImportance = 0.6;
		} else {
			info.diffuseImportance = 0.6;
			info.envmapImportance = 0.4;
		}
		info.specularImportance = 0.0;
		info.transmissionImportance = 0.0;
		info.clearcoatImportance = 0.0;
	}

	return info;
}

// -----------------------------------------------------------------------------
// Material Cache Creation
// -----------------------------------------------------------------------------

MaterialCache createMaterialCache( vec3 N, vec3 V, RayTracingMaterial material, MaterialSamples samples, MaterialClassification mc ) {
	MaterialCache cache;

	cache.NoV = max( dot( N, V ), 0.001 );

    // Use pre-computed material classification for faster checks
	cache.isPurelyDiffuse = mc.isRough && ! mc.isMetallic &&
		material.transmission == 0.0 && material.clearcoat == 0.0;
	cache.isMetallic = mc.isMetallic;
	cache.hasSpecialFeatures = mc.isTransmissive || mc.hasClearcoat ||
		material.sheen > 0.0 || material.iridescence > 0.0;

    // Pre-compute frequently used values
	cache.alpha = samples.roughness * samples.roughness;
	cache.alpha2 = cache.alpha * cache.alpha;
	float r = samples.roughness + 1.0;
	cache.k = ( r * r ) / 8.0;

    // Pre-compute F0 and colors
	vec3 dielectricF0 = vec3( 0.04 ) * material.specularColor;
	cache.F0 = mix( dielectricF0, samples.albedo.rgb, samples.metalness ) * material.specularIntensity;
	cache.diffuseColor = samples.albedo.rgb * ( 1.0 - samples.metalness );
	cache.specularColor = samples.albedo.rgb;
	cache.texSamples = samples;

    // OPTIMIZED: Pre-compute BRDF shared values to eliminate redundant calculations
	cache.invRoughness = 1.0 - samples.roughness;
	cache.metalFactor = 0.5 + 0.5 * samples.metalness;
	cache.iorFactor = min( 2.0 / material.ior, 1.0 );
	cache.maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );

	return cache;
}

MaterialCache createMaterialCacheLegacy( vec3 N, vec3 V, RayTracingMaterial material ) {
	MaterialCache cache;

	cache.NoV = max( dot( N, V ), 0.001 );
	cache.isPurelyDiffuse = material.roughness > 0.98 && material.metalness < 0.02 &&
		material.transmission == 0.0 && material.clearcoat == 0.0;
	cache.isMetallic = material.metalness > 0.7;
	cache.hasSpecialFeatures = material.transmission > 0.0 || material.clearcoat > 0.0 ||
		material.sheen > 0.0 || material.iridescence > 0.0;

	cache.alpha = material.roughness * material.roughness;
	cache.alpha2 = cache.alpha * cache.alpha;
	float r = material.roughness + 1.0;
	cache.k = ( r * r ) / 8.0;

	vec3 dielectricF0 = vec3( 0.04 ) * material.specularColor;
	cache.F0 = mix( dielectricF0, material.color.rgb, material.metalness ) * material.specularIntensity;
	cache.diffuseColor = material.color.rgb * ( 1.0 - material.metalness );
	cache.specularColor = material.color.rgb;

    // Create dummy MaterialSamples for compatibility
	cache.texSamples.albedo = material.color;
	cache.texSamples.emissive = material.emissive * material.emissiveIntensity;
	cache.texSamples.metalness = material.metalness;
	cache.texSamples.roughness = material.roughness;
	cache.texSamples.normal = N;
	cache.texSamples.hasTextures = false;

    // OPTIMIZED: Pre-compute BRDF shared values for legacy cache too
	cache.invRoughness = 1.0 - material.roughness;
	cache.metalFactor = 0.5 + 0.5 * material.metalness;
	cache.iorFactor = min( 2.0 / material.ior, 1.0 );
	cache.maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );

	return cache;
}