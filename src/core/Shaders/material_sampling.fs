// =============================================================================
// MATERIAL SAMPLING
// =============================================================================
// This file contains importance sampling functions for various BRDF lobes
// including GGX, cosine-weighted hemisphere, VNDF, and multi-lobe MIS.

// -----------------------------------------------------------------------------
// Basic Sampling Functions
// -----------------------------------------------------------------------------

vec3 ImportanceSampleGGX( vec3 N, float roughness, vec2 Xi ) {
	float alpha = roughness * roughness;
	float phi = TWO_PI * Xi.x;
	float cosTheta = sqrt( ( 1.0 - Xi.y ) / ( 1.0 + ( alpha * alpha - 1.0 ) * Xi.y ) );
	float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );

    // Spherical to cartesian conversion
	vec3 H = vec3( cos( phi ) * sinTheta, sin( phi ) * sinTheta, cosTheta );

    // TBN construction
	vec3 up = abs( N.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tangent = normalize( cross( up, N ) );
	vec3 bitangent = cross( N, tangent );

	return normalize( tangent * H.x + bitangent * H.y + N * H.z );
}

vec3 ImportanceSampleCosine( vec3 N, vec2 xi ) {
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

	// Cosine-weighted sampling
	float phi = TWO_PI * xi.x;
	float cosTheta = sqrt( 1.0 - xi.y );
	float sinTheta = sqrt( xi.y );

	// Convert from polar to Cartesian coordinates
	vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );

	// Transform the sampled direction to world space
	return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
}

vec3 cosineWeightedSample( vec3 N, vec2 xi ) {
    // Construct a local coordinate system (TBN)
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

    // Cosine-weighted sampling using concentric disk mapping
    // Convert to polar coordinates
	float phi = TWO_PI * xi.y;
	float cosTheta = sqrt( 1.0 - xi.x );
	float sinTheta = sqrt( xi.x );

    // Convert from polar to Cartesian coordinates in tangent space
	vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );

    // Transform the sampled direction to world space
	return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
}

float cosineWeightedPDF( float NoL ) {
	return max( NoL, MIN_PDF ) * PI_INV;
}

// -----------------------------------------------------------------------------
// VNDF Sampling (Visible Normal Distribution Function)
// -----------------------------------------------------------------------------

vec3 sampleGGXVNDF( vec3 V, float roughness, vec2 Xi ) {
	float alpha = roughness * roughness;
    // Transform view direction to local space
	vec3 Vh = normalize( vec3( alpha * V.x, alpha * V.y, V.z ) );

    // Construct orthonormal basis around view direction
	float lensq = Vh.x * Vh.x + Vh.y * Vh.y;
	vec3 T1 = lensq > 0.0 ? vec3( - Vh.y, Vh.x, 0.0 ) / sqrt( lensq ) : vec3( 1.0, 0.0, 0.0 );
	vec3 T2 = cross( Vh, T1 );

    // Sample point with polar coordinates (r, phi)
	float r = sqrt( Xi.x );
	float phi = TWO_PI * Xi.y;
	float t1 = r * cos( phi );
	float t2 = r * sin( phi );
	float s = 0.5 * ( 1.0 + Vh.z );
	t2 = ( 1.0 - s ) * sqrt( 1.0 - t1 * t1 ) + s * t2;

    // Compute normal
	vec3 Nh = t1 * T1 + t2 * T2 + sqrt( max( 0.0, 1.0 - t1 * t1 - t2 * t2 ) ) * Vh;

    // Transform the normal back to the ellipsoid configuration
	vec3 Ne = normalize( vec3( alpha * Nh.x, alpha * Nh.y, max( 0.0, Nh.z ) ) );
	return Ne;
}

// -----------------------------------------------------------------------------
// Multi-Lobe MIS Sampling
// -----------------------------------------------------------------------------

// ===== MULTI-LOBE MIS FUNCTIONS (Conditional Compilation) =====
#ifdef ENABLE_MULTI_LOBE_MIS

// IMPROVEMENT: Enhanced sampling weights calculation for multi-lobe MIS
MultiLobeWeights calculateSamplingWeights( vec3 V, vec3 N, RayTracingMaterial material ) {
	MultiLobeWeights weights;

    // Get material classification for optimized calculations
	MaterialClassification mc = classifyMaterial( material );

    // Create temporary cache for calculations
	MaterialCache tempCache;
	tempCache.invRoughness = 1.0 - material.roughness;
	tempCache.metalFactor = 0.5 + 0.5 * material.metalness;
	tempCache.iorFactor = min( 2.0 / material.ior, 1.0 );
	tempCache.maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );

    // Calculate base BRDF weights
	BRDFWeights brdfWeights = calculateBRDFWeights( material, mc, tempCache );

    // Calculate view-dependent factors
	float NoV = max( dot( N, V ), 0.0 );
	float fresnelFactor = pow( 1.0 - NoV, 5.0 );

    // Enhanced diffuse weight (reduced at grazing angles)
	weights.diffuse = brdfWeights.diffuse * ( 1.0 - fresnelFactor * 0.3 );

    // Enhanced specular weight (increased at grazing angles)
	weights.specular = brdfWeights.specular * ( 1.0 + fresnelFactor * 0.5 );

    // Clearcoat weight with fresnel enhancement
	weights.clearcoat = brdfWeights.clearcoat * ( 1.0 + fresnelFactor * 0.8 );

    // Transmission weight (view-dependent)
	weights.transmission = brdfWeights.transmission * tempCache.iorFactor;

    // Sheen weight (enhanced at grazing angles)
	weights.sheen = brdfWeights.sheen * ( 1.0 + fresnelFactor );

    // Iridescence weight
	weights.iridescence = brdfWeights.iridescence * ( 1.0 + fresnelFactor * 0.6 );

    // Calculate total weight for normalization
	weights.totalWeight = weights.diffuse + weights.specular + weights.clearcoat +
		weights.transmission + weights.sheen + weights.iridescence;

    // Ensure minimum total weight to prevent division by zero
	weights.totalWeight = max( weights.totalWeight, 1e-6 );

    // Normalize weights
	float invTotal = 1.0 / weights.totalWeight;
	weights.diffuse *= invTotal;
	weights.specular *= invTotal;
	weights.clearcoat *= invTotal;
	weights.transmission *= invTotal;
	weights.sheen *= invTotal;
	weights.iridescence *= invTotal;

	return weights;
}

// Calculate MIS weight considering all possible sampling strategies
float calculateMultiLobeMISWeight(
	vec3 sampledDirection,
	vec3 V,
	vec3 N,
	RayTracingMaterial material,
	MultiLobeWeights weights,
	float selectedPdf
) {
    // Calculate PDFs for all possible sampling strategies
	float diffusePdf = 0.0;
	float specularPdf = 0.0;
	float clearcoatPdf = 0.0;
	float transmissionPdf = 0.0;
	float sheenPdf = 0.0;

	float NoL = dot( N, sampledDirection );

    // Diffuse PDF
	if( NoL > 0.0 ) {
		diffusePdf = NoL / PI;
	}

    // Specular PDF
	vec3 H = normalize( V + sampledDirection );
	float NoH = max( dot( N, H ), 0.0 );
	float VoH = max( dot( V, H ), 0.0 );
	float NoV = max( dot( N, V ), 0.0 );

	if( NoH > 0.0 && VoH > 0.0 && NoV > 0.0 ) {
		float D = DistributionGGX( NoH, material.roughness );
		float G1 = GeometrySchlickGGX( NoV, material.roughness );
		specularPdf = D * G1 * VoH / ( NoV * 4.0 );

        // Clearcoat PDF (using clearcoat roughness)
		if( material.clearcoat > 0.0 ) {
			float DClearcoat = DistributionGGX( NoH, material.clearcoatRoughness );
			float G1Clearcoat = GeometrySchlickGGX( NoV, material.clearcoatRoughness );
			clearcoatPdf = DClearcoat * G1Clearcoat * VoH / ( NoV * 4.0 );
		}
	}

    // Transmission PDF (simplified)
	if( material.transmission > 0.0 && NoL < 0.0 ) {
        // For transmission, we're sampling the opposite hemisphere
		transmissionPdf = abs( NoL ) / PI; // Simplified transmission PDF
	}

    // Sheen PDF (approximated as diffuse)
	if( material.sheen > 0.0 && NoL > 0.0 ) {
		sheenPdf = NoL / PI;
	}

    // Weighted combination of all PDFs for MIS
	float totalPdf = weights.diffuse * diffusePdf +
		weights.specular * specularPdf +
		weights.clearcoat * clearcoatPdf +
		weights.transmission * transmissionPdf +
		weights.sheen * sheenPdf +
		weights.iridescence * diffusePdf; // Iridescence uses diffuse-like sampling

    // Power heuristic for MIS weight
	float misWeight = 1.0;
	if( totalPdf > 0.0 && selectedPdf > 0.0 ) {
		float selectedPdfSquared = selectedPdf * selectedPdf;
		float totalPdfSquared = totalPdf * totalPdf;
		misWeight = selectedPdfSquared / ( selectedPdfSquared + totalPdfSquared );
	}

	return misWeight;
}

// IMPROVEMENT: Multi-lobe MIS for complex materials
SamplingResult sampleMaterialWithMultiLobeMIS(
	vec3 V,
	vec3 N,
	RayTracingMaterial material,
	vec2 xi,
	inout uint rngState
) {
	SamplingResult result;

    // Calculate individual lobe weights
	MultiLobeWeights weights = calculateSamplingWeights( V, N, material );

    // Multi-importance sampling across different lobes
	float rand = RandomValue( rngState );
	float cumulativeDiffuse = weights.diffuse;
	float cumulativeSpecular = cumulativeDiffuse + weights.specular;
	float cumulativeClearcoat = cumulativeSpecular + weights.clearcoat;
	float cumulativeTransmission = cumulativeClearcoat + weights.transmission;
	float cumulativeSheen = cumulativeTransmission + weights.sheen;
	float cumulativeIridescence = cumulativeSheen + weights.iridescence;

	vec3 sampledDirection;
	float lobePdf;

	if( rand < cumulativeDiffuse ) {
        // Diffuse sampling
		sampledDirection = ImportanceSampleCosine( N, xi );
		lobePdf = max( dot( N, sampledDirection ), 0.0 ) / PI;
		result.pdf = lobePdf * weights.diffuse;

	} else if( rand < cumulativeSpecular ) {
        // Specular sampling
		vec3 H = ImportanceSampleGGX( N, material.roughness, xi );
		sampledDirection = reflect( - V, H );

		if( dot( N, sampledDirection ) > 0.0 ) {
			float NoH = max( dot( N, H ), 0.0 );
			float VoH = max( dot( V, H ), 0.0 );
			float NoV = max( dot( N, V ), 0.0 );

			float D = DistributionGGX( NoH, material.roughness );
			float G1 = GeometrySchlickGGX( NoV, material.roughness );
			lobePdf = D * G1 * VoH / ( NoV * 4.0 );
		} else {
			lobePdf = 0.0;
		}
		result.pdf = lobePdf * weights.specular;

	} else if( rand < cumulativeClearcoat && material.clearcoat > 0.0 ) {
        // Clearcoat sampling
		vec3 H = ImportanceSampleGGX( N, material.clearcoatRoughness, xi );
		sampledDirection = reflect( - V, H );

		if( dot( N, sampledDirection ) > 0.0 ) {
			float NoH = max( dot( N, H ), 0.0 );
			float VoH = max( dot( V, H ), 0.0 );
			float NoV = max( dot( N, V ), 0.0 );

			float D = DistributionGGX( NoH, material.clearcoatRoughness );
			float G1 = GeometrySchlickGGX( NoV, material.clearcoatRoughness );
			lobePdf = D * G1 * VoH / ( NoV * 4.0 );
		} else {
			lobePdf = 0.0;
		}
		result.pdf = lobePdf * weights.clearcoat;

	} else if( rand < cumulativeTransmission && material.transmission > 0.0 ) {
        // Transmission sampling - simplified approach
		vec3 H = ImportanceSampleGGX( N, material.roughness, xi );
		vec3 refractionDir = refract( - V, H, 1.0 / material.ior );

		if( length( refractionDir ) > 0.0 ) {
			sampledDirection = normalize( refractionDir );
			float NoH = max( dot( N, H ), 0.0 );
			float VoH = max( dot( V, H ), 0.0 );

			float D = DistributionGGX( NoH, material.roughness );
			float G1 = GeometrySchlickGGX( max( dot( N, V ), 0.0 ), material.roughness );
			lobePdf = D * G1 * VoH / ( max( dot( N, V ), 0.0 ) * 4.0 );
		} else {
            // Total internal reflection - fallback to specular
			sampledDirection = reflect( - V, H );
			lobePdf = 0.1; // Small fallback PDF
		}
		result.pdf = lobePdf * weights.transmission;

	} else {
        // Fallback to diffuse sampling for sheen/iridescence
		sampledDirection = ImportanceSampleCosine( N, xi );
		lobePdf = max( dot( N, sampledDirection ), 0.0 ) / PI;
		result.pdf = lobePdf * ( weights.sheen + weights.iridescence );
	}

    // Calculate MIS weight considering all possible sampling strategies
	float misWeight = calculateMultiLobeMISWeight( sampledDirection, V, N, material, weights, result.pdf );
	result.pdf *= misWeight; // Apply MIS weight to the PDF
	result.direction = sampledDirection;
	result.value = evaluateMaterialResponse( V, sampledDirection, N, material );

	return result;
}

#endif // ENABLE_MULTI_LOBE_MIS