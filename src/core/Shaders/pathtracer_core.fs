// =============================================================================
// PATH TRACER CORE
// =============================================================================
// This file contains the main path tracing loop (Trace function), Russian
// Roulette logic, and path state management for ray traversal.

// -----------------------------------------------------------------------------
// Path Contribution Estimation
// -----------------------------------------------------------------------------


// Ray type enumeration for proper classification
const int RAY_TYPE_CAMERA = 0;        // Primary rays from camera
const int RAY_TYPE_REFLECTION = 1;     // Reflection rays
const int RAY_TYPE_TRANSMISSION = 2;   // Transmission/refraction rays
const int RAY_TYPE_DIFFUSE = 3;        // Diffuse indirect rays
const int RAY_TYPE_SHADOW = 4;         // Shadow rays

uniform int totalTriangleCount;
uniform bool enableEmissiveTriangleSampling;

uniform int maxBounceCount;
uniform float backgroundIntensity;
uniform bool showBackground;
uniform int transmissiveBounces;  // Controls the number of allowed transmission bounces
uniform float fireflyThreshold;

float estimatePathContribution( vec3 throughput, vec3 direction, RayTracingMaterial material, int materialIndex, PathState pathState ) {
	float throughputStrength = maxComponent( throughput );

    // Use cached material classification
	MaterialClassification mc = getOrCreateMaterialClassification( material, materialIndex, pathState );

    // Enhanced material importance with interaction bonuses
	float materialImportance = mc.complexityScore;

	// Add interaction complexity bonuses for high-value material combinations
	if( mc.isMetallic && mc.isSmooth )
		materialImportance += 0.15;
	if( mc.isTransmissive && mc.hasClearcoat )
		materialImportance += 0.12;
	if( mc.isEmissive )
		materialImportance += 0.1;

	materialImportance = clamp( materialImportance, 0.0, 1.0 );

    // Optimized direction importance calculation
	float directionImportance = 0.5; // Default value

    // Only calculate environment importance if beneficial
	if( enableEnvironmentLight && useEnvMapIS && throughputStrength > 0.01 ) {
        // Fast approximation using simplified PDF calculation
		float cosTheta = clamp( direction.y, 0.0, 1.0 ); // Assume y-up environment
		directionImportance = mix( 0.3, 0.8, cosTheta * cosTheta );
	}

    // Enhanced weighting with throughput consideration
	float throughputWeight = smoothstep( 0.001, 0.1, throughputStrength );
	return throughputStrength * mix( materialImportance * 0.7, directionImportance, 0.3 ) * throughputWeight;
}

// -----------------------------------------------------------------------------
// Russian Roulette Path Termination
// -----------------------------------------------------------------------------

// Russian Roulette with enhanced material importance and optimized sampling
bool handleRussianRoulette( int depth, vec3 throughput, RayTracingMaterial material, int materialIndex, vec3 rayDirection, inout uint rngState, PathState pathState ) {
    // Always continue for first few bounces
	if( depth < 3 ) {
		return true;
	}

    // Get throughput strength
	float throughputStrength = maxComponent( throughput );

    // Enhanced early rejection
	if( throughputStrength < 0.0008 && depth > 4 ) {
		return false;
	}

    // Use consolidated classification function
	MaterialClassification mc = getOrCreateMaterialClassification( material, materialIndex, pathState );

    // Enhanced material importance with path-dependent adjustments
	float materialImportance = mc.complexityScore;

	// Boost importance for special materials based on path depth
	if( mc.isEmissive && depth < 6 ) {
		materialImportance += 0.3;
	}
	if( mc.isTransmissive && depth < 5 ) {
		materialImportance += 0.25;
	}
	if( mc.isMetallic && mc.isSmooth && depth < 4 ) {
		materialImportance += 0.2;
	}

	materialImportance = clamp( materialImportance, 0.0, 1.0 );

    // Dynamic minimum bounces based on material complexity
	int minBounces = 3;
	if( materialImportance > 0.6 )
		minBounces = 5;
	else if( materialImportance > 0.4 )
		minBounces = 4;

	if( depth < minBounces ) {
		return true;
	}

    // Enhanced path importance calculation with caching
	float pathContribution;
	if( pathState.classificationCached && pathState.weightsComputed ) {
		pathContribution = pathState.pathImportance;
	} else {
		pathContribution = estimatePathContribution( throughput, rayDirection, material, materialIndex, pathState );
		pathState.pathImportance = pathContribution;
	}

    // Improved adaptive continuation probability
	float rrProb;
	float adaptiveFactor = materialImportance * 0.4 + throughputStrength * 0.6;

	if( depth < 6 ) {
		rrProb = clamp( adaptiveFactor * 1.2, 0.15, 0.95 );
	} else if( depth < 10 ) {
		float baseProb = clamp( throughputStrength * 0.8, 0.08, 0.85 );
		rrProb = mix( baseProb, pathContribution, 0.6 );
	} else {
		rrProb = clamp( throughputStrength * 0.4 + materialImportance * 0.1, 0.03, 0.6 );
	}

    // Enhanced material-specific boosts
	if( materialImportance > 0.5 ) {
		float boostFactor = ( materialImportance - 0.5 ) * 0.6;
		rrProb = mix( rrProb, 1.0, boostFactor );
	}

    // Smoother depth-based decay
	float depthDecay = 0.12 + materialImportance * 0.08;
	float depthFactor = exp( - float( depth - minBounces ) * depthDecay );
	rrProb *= depthFactor;

    // Enhanced minimum probability
	float minProb = mc.isEmissive ? 0.04 : 0.02;
	rrProb = max( rrProb, minProb );

	float rrSample = RandomValue( rngState );
	return rrSample < rrProb;
}

// -----------------------------------------------------------------------------
// Background and Path Contribution Helpers
// -----------------------------------------------------------------------------

vec4 sampleBackgroundLighting( RenderState state, vec3 direction ) {
	// Only hide background for primary camera rays when showBackground is false
	if( state.isPrimaryRay && ! showBackground ) {
		return vec4( 0.0 );
	}

	vec4 envColor = sampleEnvironment( direction ) * environmentIntensity;

	// Use consistent background intensity scaling
	if( state.isPrimaryRay ) {
		// Primary camera rays: use user-controlled background intensity
		return envColor * backgroundIntensity;
	} else {
		// Secondary rays: use environment intensity for realistic lighting
		return envColor * 2.0;
	}
}

vec3 regularizePathContribution( vec3 contribution, vec3 throughput, float pathLength ) {
    // Calculate throughput variation factor
	float throughputMax = maxComponent( throughput );
	float throughputMin = minComponent( throughput );

    // Calculate path "unusualness" factor
	float throughputVariation = ( throughputMax + 0.001 ) / ( throughputMin + 0.001 );

    // Path variation context multiplier
	float variationMultiplier = 1.0 / ( 1.0 + log( 1.0 + throughputVariation ) * pathLength * 0.1 );

    // Use shared firefly threshold calculation
	float threshold = calculateFireflyThreshold( fireflyThreshold, variationMultiplier, int( pathLength ) );

    // Apply consistent soft suppression
	return applySoftSuppressionRGB( contribution, threshold, 0.5 );
}

// -----------------------------------------------------------------------------
// Main Path Tracing Loop
// -----------------------------------------------------------------------------

vec4 Trace( Ray ray, inout uint rngState, int rayIndex, int pixelIndex, out vec3 objectNormal, out vec3 objectColor, out float objectID ) {

	vec3 radiance = vec3( 0.0 );
	vec3 throughput = vec3( 1.0 );
	float alpha = 1.0;

	// Initialize edge detection variables
	objectNormal = vec3( 0.0 );
	objectColor = vec3( 0.0 );
	objectID = - 1000.0;

#if defined(ENABLE_TRANSMISSION) || defined(ENABLE_TRANSPARENCY)
    // Initialize media stack
	MediumStack mediumStack;
	mediumStack.depth = 0;
#endif // ENABLE_TRANSMISSION || ENABLE_TRANSPARENCY

    // Initialize render state
	RenderState state;
	state.transmissiveTraversals = transmissiveBounces;
	state.rayType = RAY_TYPE_CAMERA;
	state.isPrimaryRay = true;
	state.actualBounceDepth = 0;

    // Enhanced path state initialization for better caching
	PathState pathState;
	pathState.weightsComputed = false;
	pathState.classificationCached = false;
	pathState.materialCacheCached = false;
	pathState.texturesLoaded = false;
	pathState.pathImportance = 0.0;
	pathState.lastMaterialIndex = - 1;

	// Track effective bounces separately from transmissive bounces
	int effectiveBounces = 0;

	for( int bounceIndex = 0; bounceIndex <= maxBounceCount + transmissiveBounces; bounceIndex ++ ) {
        // Update state for this bounce
		state.traversals = maxBounceCount - effectiveBounces;
		state.isPrimaryRay = ( bounceIndex == 0 );
		state.actualBounceDepth = bounceIndex;

		// Check if we've exceeded our effective bounce budget
		if( effectiveBounces > maxBounceCount ) {
			break;
		}

		HitInfo hitInfo = traverseBVH( ray, stats, false );

		if( ! hitInfo.didHit ) {
            // ENVIRONMENT LIGHTING
			vec4 envColor = sampleBackgroundLighting( state, ray.direction );
			radiance += regularizePathContribution( envColor.rgb * throughput, throughput, float( bounceIndex ) );
			alpha *= envColor.a;
			break;
		}

		// Sample all textures in one batch
		MaterialSamples matSamples = sampleAllMaterialTextures( hitInfo.material, hitInfo.uv, hitInfo.normal );

        // Update material with samples
		RayTracingMaterial material = hitInfo.material;
		material.color = matSamples.albedo;
		material.metalness = matSamples.metalness;
		material.roughness = clamp( matSamples.roughness, MIN_ROUGHNESS, MAX_ROUGHNESS );
		vec3 N = matSamples.normal;

		// Apply displacement mapping if enabled
		if( material.displacementMapIndex >= 0 && material.displacementScale > 0.0 ) {
			float heightSample = sampleDisplacementMap( material.displacementMapIndex, hitInfo.uv, material.displacementTransform );
			float displacementHeight = ( heightSample - 0.5 ) * material.displacementScale;
			vec3 displacement = N * displacementHeight;
			hitInfo.hitPoint += displacement;

			if( material.displacementScale > 0.01 ) {
				vec3 displacedNormal = calculateDisplacedNormal( hitInfo.hitPoint, N, hitInfo.uv, material );
				float blendFactor = clamp( material.displacementScale * 0.5, 0.1, 0.8 );
				blendFactor *= ( 1.0 - material.roughness * 0.5 );
				N = normalize( mix( N, displacedNormal, blendFactor ) );
			}
		}

        // Handle transparent materials with transmission
#if defined(ENABLE_TRANSMISSION) || defined(ENABLE_TRANSPARENCY)
		MaterialInteractionResult interaction = handleMaterialTransparency( ray, hitInfo.hitPoint, N, material, rngState, state, mediumStack );

		if( interaction.continueRay ) {
			bool isFreeBounce = false;

			if( interaction.isTransmissive && state.transmissiveTraversals > 0 ) {
				state.transmissiveTraversals --;
				state.rayType = RAY_TYPE_TRANSMISSION;
				isFreeBounce = true;
			} else if( interaction.isAlphaSkip ) {
				isFreeBounce = true;
			}

			// Update ray and continue
			throughput *= interaction.throughput;
			alpha *= interaction.alpha;
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
			ray.direction = interaction.direction;

			state.isPrimaryRay = false;
			pathState.weightsComputed = false;

			if( ! isFreeBounce ) {
				effectiveBounces ++;
			}

			continue;
		}

        // Apply transparency alpha
		alpha *= interaction.alpha;
#endif // ENABLE_TRANSMISSION || ENABLE_TRANSPARENCY

		vec2 randomSample = getRandomSample( gl_FragCoord.xy, rayIndex, bounceIndex, rngState, - 1 );

		vec3 V = - ray.direction; // View direction
		material.sheenRoughness = clamp( material.sheenRoughness, MIN_ROUGHNESS, MAX_ROUGHNESS );

        // Create material cache if not already cached
		if( ! pathState.materialCacheCached ) {
			pathState.materialCache = createMaterialCache( N, V, material, matSamples, pathState.materialClass );
			pathState.materialCacheCached = true;
		}

		DirectionSample brdfSample;
        // Handle clear coat
#ifdef ENABLE_CLEARCOAT
		if( material.clearcoat > 0.0 ) {
			vec3 L;
			float pdf;
			brdfSample.value = sampleClearcoat( ray, hitInfo, material, randomSample, L, pdf, rngState );
			brdfSample.direction = L;
			brdfSample.pdf = pdf;
		} else {
			brdfSample = generateSampledDirection( V, N, material, hitInfo.materialIndex, randomSample, rngState, pathState );
		}
#else
		brdfSample = generateSampledDirection( V, N, material, hitInfo.materialIndex, randomSample, rngState, pathState );
#endif // ENABLE_CLEARCOAT

        // 1. EMISSIVE CONTRIBUTION
		if( length( matSamples.emissive ) > 0.0 ) {
			radiance += matSamples.emissive * throughput;
		}

		// Update hitInfo for direct lighting
		hitInfo.material = material;
		hitInfo.normal = N;

		// 2. DIRECT LIGHTING
		vec3 directLight = calculateDirectLightingUnified( hitInfo, V, brdfSample, rayIndex, bounceIndex, rngState, stats );

		// Apply firefly suppression to regular direct lighting
		radiance += regularizePathContribution( directLight * throughput, throughput, float( bounceIndex ) );

		// 2b. EMISSIVE TRIANGLE DIRECT LIGHTING (separate to bypass firefly suppression)
		// Emissive contributions are not fireflies - they're legitimate bright samples from area lights
		if( enableEmissiveTriangleSampling && totalTriangleCount > 0 ) {
			vec3 emissiveContribution = calculateEmissiveTriangleContribution(
				hitInfo.hitPoint,
				hitInfo.normal,
				V,
				material,
				totalTriangleCount,
				bounceIndex,
				rngState,
				stats
			);
			// Add directly without firefly suppression
			radiance += emissiveContribution * throughput;
		}

		// Get importance sampling info with caching
		if( ! pathState.weightsComputed || bounceIndex == 0 ) {
			pathState.samplingInfo = getImportanceSamplingInfo( material, bounceIndex, pathState.materialClass );
		}

        // 3. INDIRECT LIGHTING
		IndirectLightingResult indirectResult = calculateIndirectLighting( V, N, material, brdfSample, rayIndex, bounceIndex, rngState, pathState.samplingInfo );
		throughput *= indirectResult.throughput * indirectResult.misWeight;

		// Early ray termination
		float maxThroughput = max( max( throughput.r, throughput.g ), throughput.b );
		if( maxThroughput < 0.001 && bounceIndex > 2 ) {
			break;
		}

        // Prepare for next bounce
		ray.origin = hitInfo.hitPoint + N * 0.001;
		ray.direction = indirectResult.direction;

		state.isPrimaryRay = false;

		// Determine ray type based on material interaction
		if( material.metalness > 0.7 && material.roughness < 0.3 ) {
			state.rayType = RAY_TYPE_REFLECTION;
		} else if( material.transmission > 0.5 ) {
			state.rayType = RAY_TYPE_TRANSMISSION;
		} else {
			state.rayType = RAY_TYPE_DIFFUSE;
		}

		if( bounceIndex == 0 && hitInfo.didHit ) {
			objectNormal = N;
			objectColor = material.color.rgb;
			objectID = float( hitInfo.materialIndex );
		}

        // 4. RUSSIAN ROULETTE
		if( ! handleRussianRoulette( state.actualBounceDepth, throughput, material, hitInfo.materialIndex, ray.direction, rngState, pathState ) ) {
			break;
		}

		// Increment effective bounces
		effectiveBounces ++;
	}

	// #if MAX_AREA_LIGHTS > 0
    // bool helperVisible = false;
    // vec3 helperColor = vec3(0.0);

    // for(int i = 0; i < MAX_AREA_LIGHTS / 13; i++) {
    //     AreaLight light = getAreaLight(i);
    //     if(light.intensity <= 0.0) continue;

    //     bool didHit = false;
    //     vec3 currentHelperColor = evaluateAreaLightHelper(light, initialRay, didHit);
    //     if(didHit) {
    //         helperVisible = true;
    //         helperColor = currentHelperColor;
    //         break;
    //     }
    // }

    // // If helper is visible, blend it with the final result
    // if(helperVisible) {
    //     // Apply a semi-transparent overlay of the helper
    //     radiance = mix(radiance, helperColor, 0.5);
    // }
    // #endif

	return vec4( radiance, alpha );
}