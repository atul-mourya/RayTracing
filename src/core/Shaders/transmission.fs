struct TransmissionResult {
	vec3 direction;    // New ray direction after transmission/reflection
	vec3 throughput;   // Color throughput including absorption
	bool didReflect;   // Whether the ray was reflected instead of transmitted
};

// Calculate wavelength-dependent IOR for dispersion
vec3 calculateDispersiveIOR( float baseIOR, float dispersionStrength ) {
    // Cauchy's equation coefficients
	float A = baseIOR;
	float B = dispersionStrength * 0.001; // Scale factor for dispersion strength

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

TransmissionResult handleTransmission(
	vec3 rayDir,           // Incident ray direction
	vec3 normal,           // Surface normal
	RayTracingMaterial material,
	bool entering,         // Whether ray is entering or exiting medium
	inout uint rngState   // Random number generator state
) {
	TransmissionResult result;
	result.throughput = vec3( 1.0 );

    // Setup initial IOR ratio
	float n1 = entering ? 1.0 : material.ior;
	float n2 = entering ? material.ior : 1.0;
	vec3 N = entering ? normal : - normal;

    // Calculate basic reflection/refraction parameters
	float cosThetaI = abs( dot( N, rayDir ) );
	float sinThetaT2 = ( n1 * n1 ) / ( n2 * n2 ) * ( 1.0 - cosThetaI * cosThetaI );
	bool totalInternalReflection = sinThetaT2 > 1.0;

    // Calculate Fresnel terms
	float F0 = pow( ( n1 - n2 ) / ( n1 + n2 ), 2.0 );
	float Fr = totalInternalReflection ? 1.0 : fresnelSchlick( cosThetaI, F0 );

    // Modify reflection probability based on transmission value
	float reflectProb = mix( Fr, Fr * ( 1.0 - material.transmission ), material.transmission );
	result.didReflect = totalInternalReflection || ( RandomValue( rngState ) < reflectProb );

	if( result.didReflect ) {
        // Handle reflection
		result.direction = reflect( rayDir, N );
		result.throughput = material.color.rgb;
	} else {
        // Handle transmission with potential dispersion
		if( material.dispersion > 0.0 ) {
            // Calculate wavelength-dependent IOR
			vec3 wavelengthIOR = calculateDispersiveIOR( material.ior, material.dispersion );

            // Randomly select wavelength channel
			float randWL = RandomValue( rngState );
			float selectIOR;

			if( randWL < 0.333 ) {
				selectIOR = wavelengthIOR.r;
				result.throughput = vec3( 1.5, 0.2, 0.2 ); // Boost red
			} else if( randWL < 0.666 ) {
				selectIOR = wavelengthIOR.g;
				result.throughput = vec3( 0.2, 1.5, 0.2 ); // Boost green
			} else {
				selectIOR = wavelengthIOR.b;
				result.throughput = vec3( 0.2, 0.2, 1.5 ); // Boost blue
			}

			float ratio = entering ? 1.0 / selectIOR : selectIOR;
			result.direction = refract( rayDir, N, ratio );

		} else {
            // Regular refraction without dispersion
			result.direction = refract( rayDir, N, n1 / n2 );
			result.throughput = mix( material.color.rgb, vec3( 1.0 ), material.transmission * 0.5 );
		}

        // Apply Beer's law absorption when entering medium
		if( entering && material.attenuationDistance > 0.0 ) {
			result.throughput *= calculateBeerLawAbsorption( material.attenuationColor, material.attenuationDistance, material.thickness );
		}

        // Apply transmission importance sampling factor
		result.throughput *= 1.0 / ( 1.0 - reflectProb );
	}

	return result;
}

vec3 sampleTransmissiveMaterial( inout Ray ray, vec3 normal, RayTracingMaterial material, inout uint rngState ) {
    // Determine if ray is entering or exiting the medium
	bool entering = dot( ray.direction, normal ) < 0.0;

    // Use common transmission handler
	TransmissionResult result = handleTransmission( ray.direction, normal, material, entering, rngState );

    // Update ray direction
	ray.direction = result.direction;

	return result.throughput;
}

struct TransparencyResult {
	bool continueRay;      // Whether the ray should continue or be processed normally
	vec3 throughput;       // Color modification for the ray
	float alpha;           // Alpha modification
};

TransparencyResult handleMaterialTransparency( RayTracingMaterial material, inout uint rngState ) {
	TransparencyResult result;
	result.continueRay = false;
	result.throughput = vec3( 1.0 );
	result.alpha = 1.0;

    // Handle different alpha modes according to glTF spec
	if( material.alphaMode == 0 ) { // OPAQUE
        // For opaque materials, ignore the alpha channel completely
        // Keep color but force alpha to 1.0
		result.throughput = material.color.rgb;
		result.alpha = 1.0;
		return result;
	} else if( material.alphaMode == 2 ) { // BLEND
		float finalAlpha = material.color.a * material.opacity;

        // Use stochastic transparency for blend mode
		if( RandomValue( rngState ) > finalAlpha ) {
			result.continueRay = true;
			result.throughput = vec3( 1.0 );  // No color modification when skipping
			result.alpha = 0.0;
			return result;
		}

		result.throughput = material.color.rgb;
		result.alpha = finalAlpha;
		return result;
	} else if( material.alphaMode == 1 ) { // MASK
		float cutoff = material.alphaTest > 0.0 ? material.alphaTest : 0.5;
		if( material.color.a < cutoff ) {
			result.continueRay = true;
			result.alpha = 0.0;
			return result;
		}
		result.throughput = material.color.rgb;
		result.alpha = 1.0;
		return result;
	}

    // Handle transmission if present
	if( material.transmission > 0.0 ) {
		if( RandomValue( rngState ) < material.transmission ) {
			result.continueRay = true;
			result.throughput = material.color.rgb;
			result.alpha = 1.0 - material.transmission;
			return result;
		}
	}

	return result;
}
