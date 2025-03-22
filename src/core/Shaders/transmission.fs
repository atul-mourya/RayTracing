struct TransmissionResult {
	vec3 direction;    // New ray direction after transmission/reflection
	vec3 throughput;   // Color throughput including absorption
	bool didReflect;   // Whether the ray was reflected instead of transmitted
};

// Unified transparency and transmission result structure
struct MaterialInteractionResult {
	bool continueRay;      // Whether the ray should continue without further BRDF evaluation
	vec3 direction;        // New ray direction if continuing
	vec3 throughput;       // Color modification for the ray
	float alpha;           // Alpha modification
};

// Calculate wavelength-dependent IOR for dispersion
vec3 calculateDispersiveIOR( float baseIOR, float dispersionStrength ) {
    // Cauchy's equation coefficients
	float A = baseIOR;
	float B = dispersionStrength * 0.01; // Scale factor for dispersion strength

    // Wavelengths for RGB (in micrometers)
	const vec3 wavelengths = vec3( 0.6563, 0.5461, 0.4358 ); // Red, Green, Blue (precise wavelengths)

    // Apply Cauchy's equation: n(λ) = A + B/λ²
	return A + B / ( wavelengths * wavelengths );
}

// Apply Beer's law absorption
vec3 calculateBeerLawAbsorption( vec3 attenuationColor, float attenuationDistance, float thickness ) {
	if( attenuationDistance <= 0.0 )
		return vec3( 1.0 );

    // Convert RGB attenuation color to absorption coefficients
	vec3 absorption = - log( max( attenuationColor, vec3( 0.001 ) ) ) / attenuationDistance;

    // Apply Beer's law
	return exp( - absorption * thickness );
}

struct MicrofacetTransmissionResult {
	vec3 direction;        // Refracted/reflected direction
	vec3 halfVector;       // Sampled half-vector
	bool didReflect;       // Whether TIR occurred
	float pdf;             // PDF of the sampled direction
};

MicrofacetTransmissionResult sampleMicrofacetTransmission(
	vec3 V,                // View direction (pointing away from surface)
	vec3 N,                // Surface normal
	float ior,             // Material IOR
	float roughness,       // Material roughness
	bool entering,         // Whether ray is entering the medium
	float dispersion,      // Dispersion amount (0 = none)
	vec2 xi,               // Random sample values
	inout uint rngState    // RNG state for additional sampling
) {
	MicrofacetTransmissionResult result;

    // Use minimum roughness to avoid numerical issues
	float transmissionRoughness = max( 0.05, roughness );

    // Sample the microfacet normal with GGX distribution
	vec3 H = ImportanceSampleGGX( N, transmissionRoughness, xi );
	result.halfVector = H;

    // Compute IOR ratio based on whether ray is entering or exiting
	float eta = ior;
	float etaRatio = entering ? ( 1.0 / eta ) : eta;

    // Handle dispersion if enabled
	if( dispersion > 0.0 ) {
		float randWL = RandomValue( rngState );
		float B = dispersion * 0.001;
		float dispersionOffset = B / ( ( randWL < 0.333 ) ? 0.4225 : ( ( randWL < 0.666 ) ? 0.2809 : 0.1936 ) );
		etaRatio = entering ? ( 1.0 / ( eta + dispersionOffset ) ) : ( eta + dispersionOffset );
	}

    // Compute refracted direction using the sampled half-vector
	float HoV = clamp( dot( H, V ), 0.001, 1.0 );
	vec3 refractDir = refract( - V, H, etaRatio );

    // Check for total internal reflection
	if( dot( refractDir, refractDir ) < 0.001 ) {
        // TIR occurred, use reflection instead
		result.direction = reflect( - V, H );
		result.didReflect = true;

        // Calculate PDF for reflection
		float NoH = clamp( dot( N, H ), 0.001, 1.0 );
		float VoH = clamp( dot( V, H ), 0.001, 1.0 );
		float NoV = clamp( dot( N, V ), 0.001, 1.0 );
		float D = DistributionGGX( NoH, transmissionRoughness );
		float G1 = GeometrySchlickGGX( NoV, transmissionRoughness );
		result.pdf = D * G1 * VoH / ( NoV * 4.0 );
	} else {
        // Successful refraction
		result.direction = refractDir;
		result.didReflect = false;

        // Calculate proper PDF for microfacet transmission
		float NoH = clamp( dot( N, H ), 0.001, 1.0 );
		float HoL = clamp( dot( H, refractDir ), 0.001, 1.0 );
		float D = DistributionGGX( NoH, transmissionRoughness );

        // Account for change of measure due to refraction (Jacobian)
		float sqrtDenom = HoV + etaRatio * HoL;
		float jacobian = abs( HoL ) / ( sqrtDenom * sqrtDenom );

        // Final PDF for microfacet transmission
		result.pdf = D * NoH * jacobian;
	}

	return result;
}

TransmissionResult handleTransmission(
	vec3 rayDir,           // Incident ray direction
	vec3 normal,           // Surface normal
	RayTracingMaterial material,
	bool entering,         // Whether ray is entering or exiting medium
	inout uint rngState    // Random number generator state
) {
	TransmissionResult result;
	result.throughput = vec3( 1.0 );

    // Setup surface normal based on ray direction
	vec3 N = entering ? normal : - normal;

    // Incident direction (points toward the surface)
	vec3 V = - rayDir;

    // Calculate IOR values for Fresnel calculation
	float n1 = entering ? 1.0 : material.ior;
	float n2 = entering ? material.ior : 1.0;

    // Calculate basic reflection/refraction parameters
	float cosThetaI = abs( dot( N, rayDir ) );
	float sinThetaT2 = ( n1 * n1 ) / ( n2 * n2 ) * ( 1.0 - cosThetaI * cosThetaI );
	bool totalInternalReflection = sinThetaT2 > 1.0;

    // Calculate Fresnel term with roughness adjustment
	float F0 = pow( ( n1 - n2 ) / ( n1 + n2 ), 2.0 );
	float microfacetF0 = mix( F0, 0.5, material.roughness * material.roughness );
	float Fr = totalInternalReflection ? 1.0 : fresnelSchlick( cosThetaI, microfacetF0 );

    // Adjust reflection probability based on material transmission value
	float reflectProb = mix( Fr, Fr * ( 1.0 - material.transmission ), material.transmission );

    // Force reflection if TIR, otherwise probabilistically choose
	result.didReflect = totalInternalReflection || ( RandomValue( rngState ) < reflectProb );

    // Choose random sample for microfacet sampling
	vec2 xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );

	if( result.didReflect ) {
        // For reflection, we can either use perfect reflection or microfacet-based
		if( material.roughness > 0.05 ) {
            // Use microfacet reflection via our shared function
			MicrofacetTransmissionResult mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, 0.0, xi, rngState );
			result.direction = mtResult.direction;
		} else {
            // Perfect mirror reflection for smooth surfaces
			result.direction = reflect( rayDir, N );
		}
		result.throughput = material.color.rgb;
	} else {
        // For transmission/refraction
		if( material.roughness > 0.05 || material.dispersion > 0.0 ) {
            // Use shared microfacet transmission function
			MicrofacetTransmissionResult mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState );

            // If TIR occurred during microfacet sampling, respect it
			if( mtResult.didReflect ) {
				result.direction = mtResult.direction;
				result.didReflect = true;
			} else {
				result.direction = mtResult.direction;

                // Handle dispersion coloring
				if( material.dispersion > 0.0 ) {
					// Calculate wavelength-dependent IOR
					vec3 wavelengthIOR = calculateDispersiveIOR( material.ior, material.dispersion );

					// Randomly select wavelength channel
					float randWL = RandomValue( rngState );
					float selectIOR;

					// Calculate dispersion strength - stronger at edges
					float edgeFactor = 1.0 - abs( dot( N, rayDir ) );
					float dispersionVisibility = material.dispersion * edgeFactor * 2.0;

					// Base color to maintain energy conservation
					vec3 baseColor = mix( material.color.rgb, vec3( 1.0 ), material.transmission * 0.5 );

					if( randWL < 0.333 ) {
						selectIOR = wavelengthIOR.r;
						// Blend between full spectrum and red-heavy spectrum based on dispersion visibility
						result.throughput = mix( baseColor, baseColor * vec3( 1.5, 0.25, 0.25 ), dispersionVisibility );
					} else if( randWL < 0.666 ) {
						selectIOR = wavelengthIOR.g;
						// Blend between full spectrum and green-heavy spectrum
						result.throughput = mix( baseColor, baseColor * vec3( 0.25, 1.5, 0.25 ), dispersionVisibility );
					} else {
						selectIOR = wavelengthIOR.b;
						// Blend between full spectrum and blue-heavy spectrum
						result.throughput = mix( baseColor, baseColor * vec3( 0.25, 0.25, 1.5 ), dispersionVisibility );
					}

					float ratio = entering ? 1.0 / selectIOR : selectIOR;
					result.direction = refract( rayDir, N, ratio );

				}
			}
		} else {
            // Simple refraction for smooth, non-dispersive surfaces
			result.direction = refract( rayDir, N, n1 / n2 );
		}

        // Common transmission calculations
		if( ! result.didReflect ) {
            // Apply material color blending for transmission
			result.throughput *= mix( material.color.rgb, vec3( 1.0 ), material.transmission * 0.5 );

            // Apply Beer's law absorption when entering medium
			if( entering && material.attenuationDistance > 0.0 ) {
				result.throughput *= calculateBeerLawAbsorption( material.attenuationColor, material.attenuationDistance, material.thickness );
			}

            // Apply energy correction for sampling
			result.throughput *= 1.0 / max( 1.0 - reflectProb, 0.001 );
		}
	}

	return result;
}

// Handle all material transparency effects: alpha modes, transmission
MaterialInteractionResult handleMaterialTransparency(
	Ray ray,
	vec3 hitPoint,
	vec3 normal,
	RayTracingMaterial material,
	inout uint rngState
) {
	MaterialInteractionResult result;
	result.continueRay = false;
	result.direction = ray.direction;
	result.throughput = vec3( 1.0 );
	result.alpha = 1.0;

    // -----------------------------------------------------------------
    // Step 1: Fast path for completely opaque materials
    // -----------------------------------------------------------------

    // Quick early exit for fully opaque materials (most common case)
	if( material.alphaMode == 0 && material.transmission <= 0.0 ) {
		return result;
	}

    // -----------------------------------------------------------------
    // Step 2: Handle alpha modes according to glTF spec
    // -----------------------------------------------------------------

	if( material.alphaMode == 2 ) { // BLEND
		float finalAlpha = material.color.a * material.opacity;

        // Use stochastic transparency for blend mode
		if( RandomValue( rngState ) > finalAlpha ) {
            // Skip this surface entirely
			result.continueRay = true;
			result.direction = ray.direction;
			result.throughput = vec3( 1.0 );
			result.alpha = 0.0;
			return result;
		}

		result.alpha = finalAlpha;
	} else if( material.alphaMode == 1 ) { // MASK
		float cutoff = material.alphaTest > 0.0 ? material.alphaTest : 0.5;
		if( material.color.a < cutoff ) {
            // Skip this surface entirely
			result.continueRay = true;
			result.direction = ray.direction;
			result.throughput = vec3( 1.0 );
			result.alpha = 0.0;
			return result;
		}

		result.alpha = 1.0;
	}

    // -----------------------------------------------------------------
    // Step 3: Handle transmission if present
    // -----------------------------------------------------------------

	if( material.transmission > 0.0 ) {
        // Only apply transmission with probability equal to the transmission value
		if( RandomValue( rngState ) < material.transmission ) {
            // Determine if ray is entering or exiting the medium
			bool entering = dot( ray.direction, normal ) < 0.0;
			vec3 N = entering ? normal : - normal;

            // Use the pre-existing handleTransmission function for compatibility
            // This will eventually calculate the same thing internally
			TransmissionResult transResult = handleTransmission( ray.direction, normal, material, entering, rngState );

            // Apply the transmission result
			result.direction = transResult.direction;
			result.throughput = transResult.throughput;
			result.continueRay = true;
			result.alpha = 1.0 - material.transmission;

			return result;
		}
	}

    // If we get here, handle like a regular material
	return result;
}
