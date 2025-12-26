// =============================================================================
// MATERIAL EVALUATION
// =============================================================================
// This file contains BRDF evaluation functions that compute the material
// response to incident and outgoing light directions.

// -----------------------------------------------------------------------------
// Main Material Response Evaluation
// -----------------------------------------------------------------------------

vec3 evaluateMaterialResponse( vec3 V, vec3 L, vec3 N, RayTracingMaterial material ) {

	// Early exit for purely diffuse materials
	if( material.roughness > 0.98 && material.metalness < 0.02 &&
		material.transmission == 0.0 && material.clearcoat == 0.0 ) {
		return material.color.rgb * ( 1.0 - material.metalness ) * PI_INV;
	}

    // Calculate all dot products once
	DotProducts dots = computeDotProducts( N, V, L );

    // Surface BRDF evaluation only
    // Calculate base F0 with specular parameters
	vec3 F0 = mix( vec3( 0.04 ) * material.specularColor, material.color.rgb, material.metalness ) * material.specularIntensity;

	// Modify material color for dispersive materials to enhance color separation
	vec3 materialColor = material.color.rgb;
	if( material.dispersion > 0.0 && material.transmission > 0.5 ) {
		// For highly dispersive transmissive materials, boost color saturation
		float dispersionEffect = clamp( material.dispersion * 0.1, 0.0, 0.8 );
		// Convert to HSV-like saturation boost
		float maxComp = max( max( materialColor.r, materialColor.g ), materialColor.b );
		float minComp = min( min( materialColor.r, materialColor.g ), materialColor.b );
		if( maxComp > minComp ) {
			vec3 saturatedColor = ( materialColor - minComp ) / ( maxComp - minComp );
			materialColor = mix( materialColor, saturatedColor, dispersionEffect * 0.3 );
		}
	}

    // Add iridescence effect if enabled
#ifdef ENABLE_IRIDESCENCE
	if( material.iridescence > 0.0 ) {
        // Calculate thickness based on the range
		float thickness = mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, 0.5 );
		vec3 iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dots.VoH, thickness, F0 );
		F0 = mix( F0, iridescenceFresnel, material.iridescence );
	}
#endif // ENABLE_IRIDESCENCE

    // Precalculate shared terms
	float D = DistributionGGX( dots.NoH, material.roughness );
	float G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
	vec3 F = fresnelSchlick( dots.VoH, F0 );

	// Combined specular calculation with NaN protection
	vec3 specular = ( D * G * F ) / max( 4.0 * dots.NoV * dots.NoL, EPSILON );
	vec3 kD = ( vec3( 1.0 ) - F ) * ( 1.0 - material.metalness );
	vec3 diffuse = kD * materialColor * PI_INV;

	vec3 baseLayer = diffuse + specular;

    // Optimize sheen calculation
#ifdef ENABLE_SHEEN
	if( material.sheen > 0.0 ) {
		float sheenDist = SheenDistribution( dots.NoH, material.sheenRoughness );
		vec3 sheenTerm = material.sheenColor * material.sheen * sheenDist * dots.NoL;

        // Physically-based sheen attenuation
		float maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
		float sheenReflectance = material.sheen * maxSheen * sheenDist;
		float sheenAttenuation = 1.0 - clamp( sheenReflectance, 0.0, 1.0 );

		return baseLayer * sheenAttenuation + sheenTerm;
	}
#endif // ENABLE_SHEEN

	return baseLayer;
}

// -----------------------------------------------------------------------------
// Cached Material Response Evaluation (Optimized)
// -----------------------------------------------------------------------------

// Optimized material response evaluation using cache
vec3 evaluateMaterialResponseCached( vec3 V, vec3 L, vec3 N, RayTracingMaterial material, MaterialCache cache ) {
	if( cache.isPurelyDiffuse ) {
		return cache.diffuseColor;
	}

	vec3 H = normalize( V + L );
	float NoL = max( dot( N, L ), EPSILON );
	float NoH = max( dot( N, H ), EPSILON );
	float VoH = max( dot( V, H ), EPSILON );

	bool isTransmission = cache.NoV * NoL < 0.0;
	if( isTransmission && material.transmission > 0.0 ) {
		return evaluateMaterialResponse( V, L, N, material );
	}

	vec3 F0 = cache.F0;
#ifdef ENABLE_IRIDESCENCE
	if( material.iridescence > 0.0 ) {
		float thickness = mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, 0.5 );
		vec3 iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, VoH, thickness, F0 );
		F0 = mix( F0, iridescenceFresnel, material.iridescence );
	}
#endif // ENABLE_IRIDESCENCE

    // Use precomputed values
	float denom = ( NoH * NoH * ( cache.alpha2 - 1.0 ) + 1.0 );
	float D = cache.alpha2 / max( PI * denom * denom, EPSILON );

	float ggx1 = NoL / ( NoL * ( 1.0 - cache.k ) + cache.k );
	float ggx2 = cache.NoV / ( cache.NoV * ( 1.0 - cache.k ) + cache.k );
	float G = ggx1 * ggx2;

	vec3 F = fresnelSchlick( VoH, F0 );

    // Safer division for specular term
	float specularDenom = max( 4.0 * cache.NoV * NoL, EPSILON );
	vec3 specular = ( D * G * F ) / specularDenom;

    // Energy conservation: ensure diffuse + specular doesn't exceed 1
	vec3 kD = ( vec3( 1.0 ) - F ) * ( 1.0 - material.metalness );
	vec3 diffuse = kD * material.color.rgb * PI_INV;

    // Clamp specular to prevent fireflies
	specular = min( specular, vec3( 16.0 ) ); // Reasonable upper bound

	vec3 baseLayer = diffuse + specular;

#ifdef ENABLE_SHEEN
	if( material.sheen > 0.0 ) {
		float sheenDist = SheenDistribution( NoH, material.sheenRoughness );
		vec3 sheenTerm = material.sheenColor * material.sheen * sheenDist * NoL;
		float maxSheen = max( max( material.sheenColor.r, material.sheenColor.g ), material.sheenColor.b );
		float sheenReflectance = material.sheen * maxSheen * sheenDist;
		float sheenAttenuation = 1.0 - clamp( sheenReflectance, 0.0, 1.0 );

		return baseLayer * sheenAttenuation + sheenTerm;
	}
#endif // ENABLE_SHEEN

	return baseLayer;
}

// -----------------------------------------------------------------------------
// Layered BRDF Evaluation (for clearcoat)
// -----------------------------------------------------------------------------

// Helper function to calculate energy conservation for layered materials
float calculateLayerAttenuation( float clearcoat, float VoH ) {
    // Fresnel term for clearcoat layer (using f0 = 0.04 for dielectric)
	float F = fresnelSchlick( VoH, 0.04 );
    // Attenuate base layer by clearcoat layer's reflection
	return ( 1.0 - clearcoat * F );
}

// Evaluate both clearcoat and base layer BRDFs
vec3 evaluateLayeredBRDF( DotProducts dots, RayTracingMaterial material ) {

    // Base F0 calculation with specular parameters
	vec3 baseF0 = vec3( 0.04 );
	vec3 F0 = mix( baseF0 * material.specularColor, material.color.rgb, material.metalness );
	F0 *= material.specularIntensity;

	float D = DistributionGGX( dots.NoH, material.roughness );
	float G = GeometrySmith( dots.NoV, dots.NoL, material.roughness );
	vec3 F = fresnelSchlick( dots.VoH, F0 );
	vec3 baseBRDF = ( D * G * F ) / max( 4.0 * dots.NoV * dots.NoL, EPSILON );

    // Fresnel masking for diffuse component
	vec3 kD = ( vec3( 1.0 ) - F ) * ( 1.0 - material.metalness );
	vec3 diffuse = kD * material.color.rgb / PI;
	vec3 baseLayer = diffuse + baseBRDF;

    // Clearcoat layer
	float clearcoatRoughness = max( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS );
	float clearcoatD = DistributionGGX( dots.NoH, clearcoatRoughness );
	float clearcoatG = GeometrySmith( dots.NoV, dots.NoL, clearcoatRoughness );
	float clearcoatF = fresnelSchlick( dots.VoH, 0.04 );
	float clearcoatBRDF = ( clearcoatD * clearcoatG * clearcoatF ) /
		max( 4.0 * dots.NoV * dots.NoL, EPSILON );

    //  Energy conservation for clearcoat
	float clearcoatAttenuation = 1.0 - material.clearcoat * clearcoatF;

	return baseLayer * clearcoatAttenuation + vec3( clearcoatBRDF ) * material.clearcoat;
}