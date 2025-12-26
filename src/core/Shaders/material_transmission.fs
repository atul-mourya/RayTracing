// ===== TRANSMISSION & REFRACTION (Conditional Compilation) =====
// Note: This file handles both volumetric transmission AND opacity-based transparency
#if defined(ENABLE_TRANSMISSION) || defined(ENABLE_TRANSPARENCY)

struct TransmissionResult {
	vec3 direction;    // New ray direction after transmission/reflection
	vec3 throughput;   // Color throughput including absorption
	bool didReflect;   // Whether the ray was reflected instead of transmitted
};

struct MaterialInteractionResult {
	bool continueRay;          // Whether the ray should continue without further BRDF evaluation
	bool isTransmissive;       // Flag to indicate this was a transmissive interaction
	bool isAlphaSkip;          // Flag to indicate this was an alpha skip (new)
	vec3 direction;            // New ray direction if continuing
	vec3 throughput;           // Color modification for the ray
	float alpha;               // Alpha modification
};

// Maximum number of nested media
#define MAX_MEDIA_STACK 4

struct Medium {
	float ior;
	vec3 attenuationColor;
	float attenuationDistance;
	float dispersion;
};

struct MediumStack {
	Medium media[ MAX_MEDIA_STACK ];
	int depth;
};

float getCurrentMediumIOR( MediumStack mediumStack ) {
	if( mediumStack.depth <= 0 ) {
		return 1.0; // Air/vacuum
	}
	return mediumStack.media[ mediumStack.depth ].ior;
}

// Calculate wavelength-dependent IOR for dispersion using proper Cauchy dispersion equation
vec3 calculateDispersiveIOR( float baseIOR, float dispersionStrength ) {
    // Cauchy's equation coefficients - maximum strength for dramatic prism effects
	float A = baseIOR;
	float B = dispersionStrength * 0.03; // Match spectral sampling for consistency
    
    // Standard CIE wavelengths for RGB (in micrometers) - more accurate values
	const vec3 wavelengths = vec3( 0.7000, 0.5461, 0.4358 ); // Red, Green, Blue
    
    // Apply Cauchy's equation: n(λ) = A + B/λ²
	vec3 dispersiveIOR = A + B / ( wavelengths * wavelengths );
    
    // Ensure IOR values are physically reasonable (> 1.0 for real materials)
	return max( dispersiveIOR, vec3( 1.001 ) );
}

// Enhanced spectral sampling for realistic dispersion
struct SpectralSample {
    float wavelength;    // Wavelength in nanometers
    float ior;          // IOR at this wavelength
    vec3 colorWeight;   // Color contribution weight
};

// Convert wavelength to RGB using proper spectral sensitivity curves
vec3 wavelengthToRGB( float wavelength ) {
    vec3 color = vec3( 0.0 );
    
    // Full visible spectrum with proper color science
    if( wavelength >= 380.0 && wavelength < 440.0 ) {
        // Violet
        float t = ( wavelength - 380.0 ) / 60.0;
        color = vec3( 0.6 + 0.4 * ( 1.0 - t ), 0.0, 1.0 );
    } else if( wavelength >= 440.0 && wavelength < 490.0 ) {
        // Blue
        float t = ( wavelength - 440.0 ) / 50.0;
        color = vec3( 0.6 * ( 1.0 - t ), 0.0, 1.0 );
    } else if( wavelength >= 490.0 && wavelength < 510.0 ) {
        // Blue-Cyan
        float t = ( wavelength - 490.0 ) / 20.0;
        color = vec3( 0.0, t, 1.0 );
    } else if( wavelength >= 510.0 && wavelength < 580.0 ) {
        // Cyan-Green-Yellow
        float t = ( wavelength - 510.0 ) / 70.0;
        if( t < 0.5 ) {
            // Cyan to Green
            float t2 = t * 2.0;
            color = vec3( 0.0, 1.0, 1.0 - t2 );
        } else {
            // Green to Yellow
            float t2 = ( t - 0.5 ) * 2.0;
            color = vec3( t2, 1.0, 0.0 );
        }
    } else if( wavelength >= 580.0 && wavelength < 645.0 ) {
        // Yellow-Orange-Red
        float t = ( wavelength - 580.0 ) / 65.0;
        color = vec3( 1.0, 1.0 - t, 0.0 );
    } else if( wavelength >= 645.0 && wavelength <= 700.0 ) {
        // Red
        float t = ( wavelength - 645.0 ) / 55.0;
        color = vec3( 1.0, 0.0, 0.0 );
    }
    
    // Apply intensity falloff at spectrum edges
    if( wavelength < 420.0 ) {
        float falloff = ( wavelength - 380.0 ) / 40.0;
        color *= falloff;
    } else if( wavelength > 680.0 ) {
        float falloff = ( 700.0 - wavelength ) / 20.0;
        color *= falloff;
    }
    
    return color;
}

SpectralSample sampleWavelengthForDispersion( float baseIOR, float dispersionStrength, float random ) {
    SpectralSample _sample;
    
    // Map random value to visible spectrum (380-700nm) with better distribution
    _sample.wavelength = mix( 380.0, 700.0, random );
    
    // Convert to micrometers for Cauchy equation
    float wlMicron = _sample.wavelength / 1000.0;
    
    // Strong IOR calculation for dramatic dispersion
    float A = baseIOR;
    float B = dispersionStrength * 0.03; // Even stronger for maximum visibility
    _sample.ior = A + B / ( wlMicron * wlMicron );
    
    // PURE SATURATED spectral colors - no mixing or muddiness
    vec3 colorWeight = vec3( 0.0 );
    float wl = _sample.wavelength;
    
    // Pure primary and secondary colors with sharp transitions
    if( wl >= 380.0 && wl < 420.0 ) {
        // Deep Violet - PURE
        colorWeight = vec3( 0.9, 0.0, 1.0 );
    } else if( wl >= 420.0 && wl < 480.0 ) {
        // Blue - PURE
        colorWeight = vec3( 0.0, 0.0, 1.0 );
    } else if( wl >= 480.0 && wl < 500.0 ) {
        // Cyan - PURE
        colorWeight = vec3( 0.0, 1.0, 1.0 );
    } else if( wl >= 500.0 && wl < 530.0 ) {
        // Green - PURE
        colorWeight = vec3( 0.0, 1.0, 0.0 );
    } else if( wl >= 530.0 && wl < 570.0 ) {
        // Yellow - PURE
        colorWeight = vec3( 1.0, 1.0, 0.0 );
    } else if( wl >= 570.0 && wl < 620.0 ) {
        // Orange - PURE
        colorWeight = vec3( 1.0, 0.5, 0.0 );
    } else if( wl >= 620.0 && wl <= 700.0 ) {
        // Red - PURE
        colorWeight = vec3( 1.0, 0.0, 0.0 );
    }
    
    // Maximum saturation - no dampening
    colorWeight = pow( colorWeight, vec3( 0.4 ) ); // Extreme saturation
    colorWeight = clamp( colorWeight, vec3( 0.0 ), vec3( 2.0 ) ); // Allow oversaturation
    
    _sample.colorWeight = colorWeight;
    
    return _sample;
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

float calculateShadowTransmittance(
	vec3 rayDir,
	vec3 normal,
	RayTracingMaterial material,
	bool entering
) {
    // Simplified transmission for shadow rays
    // Assumes air-to-material transitions only (no nested media tracking)
    // This is sufficient for shadow calculations and much faster

	float n1 = entering ? 1.0 : material.ior;
	float n2 = entering ? material.ior : 1.0;

	float cosThetaI = abs( dot( normal, rayDir ) );
	float sinThetaT2 = ( n1 * n1 ) / ( n2 * n2 ) * ( 1.0 - cosThetaI * cosThetaI );

    // Handle total internal reflection
	if( sinThetaT2 > 1.0 ) {
		return 0.0; // No transmission through TIR
	}

    // Calculate Fresnel reflectance
	float F0 = iorToFresnel0( n2, n1 );
	float Fr = fresnelSchlick( cosThetaI, F0 );

    // Base transmission: what gets through after Fresnel reflection
	float baseTransmission = ( 1.0 - Fr ) * material.transmission;

    // Apply Beer's law absorption for exiting rays
	if( ! entering && material.attenuationDistance > 0.0 ) {
		vec3 absorption = calculateBeerLawAbsorption( material.attenuationColor, material.attenuationDistance, material.thickness );
		baseTransmission *= ( absorption.r + absorption.g + absorption.b ) / 3.0;
	}

	return clamp( baseTransmission, 0.0, 1.0 );
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

    // For smooth surfaces with dispersion, use perfect refraction with spectral IOR
	if( roughness <= 0.05 && dispersion > 0.0 ) {
        // Perfect smooth dispersion - no microfacet blur
		result.halfVector = N;
		result.didReflect = false;

        // Compute IOR ratio with dispersion
		float eta = ior;
		float etaRatio = entering ? ( 1.0 / eta ) : eta;

        // Handle dispersion with spectral sampling
		SpectralSample spectralSample = sampleWavelengthForDispersion( ior, dispersion, RandomValue( rngState ) );
		etaRatio = entering ? ( 1.0 / spectralSample.ior ) : spectralSample.ior;

        // Perfect refraction using surface normal
		vec3 refractDir = refract( - V, N, etaRatio );

        // Check for total internal reflection
		if( dot( refractDir, refractDir ) < 0.001 ) {
			result.direction = reflect( - V, N );
			result.didReflect = true;
			result.pdf = 1.0;
		} else {
			result.direction = refractDir;
			result.pdf = 1.0;
		}

		return result;
	}

    // Use minimum roughness to avoid numerical issues for rough surfaces
	float transmissionRoughness = max( MIN_ROUGHNESS, roughness );

    // Sample the microfacet normal with GGX distribution
	vec3 H = ImportanceSampleGGX( N, transmissionRoughness, xi );
	result.halfVector = H;

    // Compute IOR ratio based on whether ray is entering or exiting
	float eta = ior;
	float etaRatio = entering ? ( 1.0 / eta ) : eta;

    // Handle dispersion with improved spectral sampling
	if( dispersion > 0.0 ) {
        // Use spectral sampling for physically accurate dispersion
		SpectralSample spectralSample = sampleWavelengthForDispersion( ior, dispersion, RandomValue( rngState ) );
		etaRatio = entering ? ( 1.0 / spectralSample.ior ) : spectralSample.ior;
	}

    // Compute refracted direction using the sampled half-vector
	float HoV = clamp( dot( H, V ), 0.001, 1.0 );
	vec3 refractDir = refract( - V, H, etaRatio );

    // Check for total internal reflection
	if( dot( refractDir, refractDir ) < 0.001 ) {
        // TIR occurred, use reflection instead
		result.direction = reflect( - V, H );
		result.didReflect = true;

        // Calculate PDF for reflection (standard GGX sampling)
		float NoH = clamp( dot( N, H ), 0.001, 1.0 );
		float VoH = clamp( dot( V, H ), 0.001, 1.0 );
		result.pdf = calculateGGXPDF( NoH, VoH, transmissionRoughness );
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
	inout uint rngState,    // Random number generator state
	MediumStack mediumStack
) {
	TransmissionResult result;
	result.throughput = vec3( 1.0 );

    // Setup surface normal based on ray direction
	vec3 N = entering ? normal : - normal;

    // Incident direction (points toward the surface)
	vec3 V = - rayDir;

    // // Calculate IOR values for Fresnel calculation
	// float n1 = entering ? 1.0 : material.ior;
	// float n2 = entering ? material.ior : 1.0;

	// Get current medium IOR from stack
	float currentMediumIOR = getCurrentMediumIOR( mediumStack );

	// Calculate IOR transition properly
	float n1, n2;
	if( entering ) {
		// Ray entering new medium
		n1 = currentMediumIOR;      // From current medium
		n2 = material.ior;          // To new material
	} else {
		// Ray exiting current medium  
		n1 = material.ior;          // From current material

		// Determine what medium we're exiting into
		if( mediumStack.depth > 1 ) {
			// Exiting into previous medium on stack
			n2 = mediumStack.media[ mediumStack.depth - 1 ].ior;
		} else {
			// Exiting into air/vacuum
			n2 = 1.0;
		}
	}

    // Calculate basic reflection/refraction parameters
	float cosThetaI = abs( dot( N, rayDir ) );
	float sinThetaT2 = ( n1 * n1 ) / ( n2 * n2 ) * ( 1.0 - cosThetaI * cosThetaI );
	bool totalInternalReflection = sinThetaT2 > 1.0;

	float F0 = iorToFresnel0( n2, n1 );
	float Fr = totalInternalReflection ? 1.0 : fresnelSchlick( cosThetaI, F0 );

	float reflectProb;

	if( totalInternalReflection ) {
		reflectProb = 1.0; // Always reflect at TIR
	} else {
		// For dielectrics: balance Fresnel reflection with material transmission
		float dielectricReflect = Fr + ( 1.0 - Fr ) * ( 1.0 - material.transmission );
		// For metals: mostly reflect regardless of transmission setting
		float metallicReflect = 0.95;

		// Blend based on metalness
		float baseReflectProb = mix( dielectricReflect, metallicReflect, material.metalness );
		
		// FORCE more transmission for dispersive materials
		if( material.dispersion > 0.0 ) {
			// Dramatically reduce reflection probability for dispersive materials
			float dispersionBoost = clamp( material.dispersion * 0.1, 0.0, 0.8 );
			reflectProb = baseReflectProb * ( 1.0 - dispersionBoost );
		} else {
			reflectProb = baseReflectProb;
		}
	}

	// Conservative clamp to prevent excessive PDF compensation (limits max amplification to 20x)
	reflectProb = clamp( reflectProb, 0.05, 0.95 );

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
            // Use microfacet or perfect transmission function
			MicrofacetTransmissionResult mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState );

            // If TIR occurred during sampling, respect it
			if( mtResult.didReflect ) {
				result.direction = mtResult.direction;
				result.didReflect = true;
				result.throughput = material.color.rgb;
			} else {
				result.direction = mtResult.direction;

                // Handle dispersion coloring - DIRECT RAINBOW COLOR MAPPING
				if( material.dispersion > 0.0 ) {
					// Calculate refracted ray deviation from original direction
					vec3 originalDir = normalize( rayDir );
					vec3 refractedDir = normalize( result.direction );
					
					// Calculate angle-dependent dispersion factor
					float edgeFactor = 1.0 - abs( dot( N, originalDir ) );
					float deviationAngle = acos( clamp( dot( originalDir, refractedDir ), -1.0, 1.0 ) );
					
					// Create spatial variation using ray direction and normal (no position needed)
					vec3 combinedVec = normalize( originalDir + N );
					float spatialVariation = sin( combinedVec.x * 15.0 ) * cos( combinedVec.y * 12.0 ) * sin( combinedVec.z * 18.0 );
					
					// Add additional variation using refracted direction
					float refractVariation = sin( refractedDir.x * 8.0 + refractedDir.y * 6.0 + refractedDir.z * 10.0 );
					
					// Combine multiple factors for better color distribution
					float baseColorIndex = deviationAngle * material.dispersion * 3.0;
					float spatialBoost = spatialVariation * 0.3;
					float refractBoost = refractVariation * 0.2;
					float edgeBoost = edgeFactor * 0.4;
					
					// Create continuous color mapping across the prism
					float colorIndex = fract( baseColorIndex + spatialBoost + refractBoost + edgeBoost );
					
					// ROYGBIV spectrum mapping with smooth transitions
					vec3 rainbowColor;
					if( colorIndex < 0.143 ) {
						// Red zone
						float t = colorIndex / 0.143;
						rainbowColor = mix( vec3( 0.8, 0.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), t );
					} else if( colorIndex < 0.286 ) {
						// Red to Orange transition
						float t = ( colorIndex - 0.143 ) / 0.143;
						rainbowColor = mix( vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 0.6, 0.0 ), t );
					} else if( colorIndex < 0.429 ) {
						// Orange to Yellow transition
						float t = ( colorIndex - 0.286 ) / 0.143;
						rainbowColor = mix( vec3( 1.0, 0.6, 0.0 ), vec3( 1.0, 1.0, 0.0 ), t );
					} else if( colorIndex < 0.571 ) {
						// Yellow to Green transition
						float t = ( colorIndex - 0.429 ) / 0.142;
						rainbowColor = mix( vec3( 1.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), t );
					} else if( colorIndex < 0.714 ) {
						// Green to Blue transition
						float t = ( colorIndex - 0.571 ) / 0.143;
						rainbowColor = mix( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.4, 1.0 ), t );
					} else if( colorIndex < 0.857 ) {
						// Blue to Indigo transition
						float t = ( colorIndex - 0.714 ) / 0.143;
						rainbowColor = mix( vec3( 0.0, 0.4, 1.0 ), vec3( 0.3, 0.0, 0.8 ), t );
					} else {
						// Indigo to Violet transition
						float t = ( colorIndex - 0.857 ) / 0.143;
						rainbowColor = mix( vec3( 0.3, 0.0, 0.8 ), vec3( 0.6, 0.0, 1.0 ), t );
					}
					
					// Calculate dispersion strength with proper variation
					float normalizedDispersion = clamp( material.dispersion / 5.0, 0.0, 1.0 );
					float angleBoost = 1.0 + edgeFactor * 1.5;
					
					// Make dispersion visibility more gradual and directionally varied
					float baseVisibility = normalizedDispersion * angleBoost;
					float combinedVariation = spatialVariation + refractVariation;
					float spatialMod = 0.5 + 0.5 * sin( combinedVariation * 3.14159 );
					float dispersionVisibility = clamp( baseVisibility * spatialMod, 0.1, 0.8 );
					
					// Mix rainbow color with clear base for realistic prism effect
					result.throughput = mix( vec3( 1.0 ), rainbowColor, dispersionVisibility );
					
				} else {
					// No dispersion - pure white transmission
					result.throughput = vec3( 1.0 );
				}
			}
		} else {
            // Simple refraction for completely smooth, non-dispersive surfaces
			result.direction = refract( rayDir, N, n1 / n2 );
			result.throughput = vec3( 1.0 );  // Let common block apply color (line 512)
		}

        // Common transmission calculations
		if( ! result.didReflect ) {
            // Apply material color blending for transmission (reduced intensity to maintain energy conservation)
			result.throughput *= mix( material.color.rgb, vec3( 1.0 ), material.transmission * 0.2 );

            // Apply Beer's law absorption when entering medium
			if( entering && material.attenuationDistance > 0.0 ) {
				result.throughput *= calculateBeerLawAbsorption( material.attenuationColor, material.attenuationDistance, material.thickness );
			}

            // Apply PDF compensation for probabilistic transmission sampling
            // reflectProb is clamped to [0.05, 0.95] at line 394, so (1-reflectProb) ∈ [0.05, 0.95]
            // Using 0.05 clamp limits max amplification to 20x, significantly reducing fireflies
			result.throughput *= 1.0 / max( 1.0 - reflectProb, 0.05 );
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
	inout uint rngState,
	inout RenderState state,
	inout MediumStack mediumStack
) {
	MaterialInteractionResult result;
	result.continueRay = false;
	result.isTransmissive = false;  // Initialize to false
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

	float alphaRand = RandomValue( rngState );
	float transmissionRand = RandomValue( rngState );
	uint transmissionSeed = pcg_hash( rngState ); // For transmission calculations

	if( material.alphaMode == 2 ) { // BLEND
		float finalAlpha = material.color.a * material.opacity;

        // Use stochastic transparency for blend mode
		// For BLEND mode skip:
		if( alphaRand > finalAlpha ) {
			result.continueRay = true;
			result.direction = ray.direction;
			result.throughput = vec3( 1.0 );
			result.alpha = 0.0;
			result.isAlphaSkip = true;  // Mark as alpha skip
			return result;
		}

		result.alpha = finalAlpha;
	} else if( material.alphaMode == 1 ) { // MASK
		float cutoff = material.alphaTest > 0.0 ? material.alphaTest : 0.5;
		// For MASK mode skip:
		if( material.color.a < cutoff ) {
			result.continueRay = true;
			result.direction = ray.direction;
			result.throughput = vec3( 1.0 );
			result.alpha = 0.0;
			result.isAlphaSkip = true;  // Mark as alpha skip
			return result;
		}

		result.alpha = 1.0;
	}

    // -----------------------------------------------------------------
    // Step 3: Handle transmission if present
    // -----------------------------------------------------------------

    // Check if we have transmissive traversals left
	if( material.transmission > 0.0 && state.transmissiveTraversals > 0 ) {
        // Only apply transmission with probability equal to the transmission value
		if( transmissionRand < material.transmission ) {
            // Determine if ray is entering or exiting the medium
			bool entering = dot( ray.direction, normal ) < 0.0;

            // Use transmissionSeed for transmission calculations instead of rngState
			TransmissionResult transResult = handleTransmission( ray.direction, normal, material, entering, transmissionSeed, mediumStack );

            // Update medium stack
			// Only update medium stack if we actually transmitted (didn't get TIR/reflection)
			if( ! transResult.didReflect ) {
				if( entering ) {
					// Push new medium onto stack
					if( mediumStack.depth < MAX_MEDIA_STACK - 1 ) {
						mediumStack.depth ++;
						mediumStack.media[ mediumStack.depth ].ior = material.ior;
						mediumStack.media[ mediumStack.depth ].attenuationColor = material.attenuationColor;
						mediumStack.media[ mediumStack.depth ].attenuationDistance = material.attenuationDistance;
						mediumStack.media[ mediumStack.depth ].dispersion = material.dispersion;
					}
				} else {
					// Pop medium from stack
					if( mediumStack.depth > 0 ) {
						mediumStack.depth --;
					}
				}
			}

            // Apply the transmission result
			result.direction = transResult.direction;
			result.throughput = transResult.throughput;
			result.continueRay = true;
			result.isTransmissive = true;  // Mark as transmissive interaction
			result.alpha = 1.0 - material.transmission;

			return result;
		}
	}

    // If we get here, handle like a regular material
	return result;
}

#endif // ENABLE_TRANSMISSION || ENABLE_TRANSPARENCY
