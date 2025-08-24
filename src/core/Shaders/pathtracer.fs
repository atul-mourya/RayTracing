precision highp float;
precision highp sampler2DArray;

// MRT outputs (no longer conditional)
layout( location = 0 ) out vec4 gColor;        // RGB + alpha
layout( location = 1 ) out vec4 gNormalDepth;  // Normal(RGB) + depth(A)

uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform bool showBackground;
uniform float backgroundIntensity; // Add backgroundIntensity uniform
uniform int renderMode; // 0: Regular, 1: Tiled (but handled via scissor now)
uniform int visMode;
uniform float debugVisScale;
uniform sampler2D adaptiveSamplingTexture; // Contains sampling data from AdaptiveSamplingPass
uniform bool useAdaptiveSampling;
uniform int adaptiveSamplingMax;
uniform float fireflyThreshold;
uniform bool enableDOF;

uniform sampler2D triangleTexture;
uniform sampler2D materialTexture;
uniform sampler2D bvhTexture;

uniform ivec2 triangleTexSize;
uniform ivec2 materialTexSize;
uniform ivec2 bvhTexSize;

#ifdef ENABLE_ACCUMULATION
uniform sampler2D previousAccumulatedTexture;
uniform bool enableAccumulation;
uniform float accumulationAlpha;
uniform bool cameraIsMoving;
uniform bool hasPreviousAccumulated;
#endif

struct RenderState {
	int traversals;               // Remaining general bounces
	int transmissiveTraversals;   // Remaining transmission-specific bounces
	bool firstRay;                // Whether this is the first ray in the path
};

uniform int transmissiveBounces;  // Controls the number of allowed transmission bounces

// Include statements
#include struct.fs
#include common.fs
#include rayintersection.fs
#include environment.fs
#include random.fs
#include texture_sampling.fs
#include displacement.fs
#include bvhtraverse.fs
#include fresnel.fs
#include brdfs.fs
#include transmission.fs
#include clearcoat.fs
#include lights.fs

// Global variables
ivec2 stats; // num triangle tests, num bounding box tests
float pdf;

// BRDF sampling with early exits and optimized math
DirectionSample generateSampledDirection( vec3 V, vec3 N, RayTracingMaterial material, vec2 xi, inout uint rngState, inout PathState pathState ) {

    // Compute material classification if not already cached
	if( ! pathState.classificationCached ) {
		pathState.materialClass = classifyMaterial( material );
		pathState.classificationCached = true;
	}

    // Compute BRDF weights using cached classification
	if( ! pathState.weightsComputed ) {
		pathState.brdfWeights = calculateBRDFWeights( material, pathState.materialClass );
		pathState.weightsComputed = true;
	}

	BRDFWeights weights = pathState.brdfWeights;
	DirectionSample result;

	float rand = xi.x;
	vec2 directionSample = vec2( xi.y, RandomValue( rngState ) ); // Get fresh second dimension
	vec3 H;

    // Cumulative probability approach for sampling selection
	float cumulativeDiffuse = weights.diffuse;
	float cumulativeSpecular = cumulativeDiffuse + weights.specular;
	float cumulativeSheen = cumulativeSpecular + weights.sheen;
	float cumulativeClearcoat = cumulativeSheen + weights.clearcoat;

    // Diffuse sampling
	if( rand < cumulativeDiffuse ) {
		result.direction = ImportanceSampleCosine( N, directionSample );
		float NoL = clamp( dot( N, result.direction ), 0.0, 1.0 );
		result.pdf = NoL * PI_INV;
		result.value = evaluateMaterialResponse( V, result.direction, N, material );
		return result;
	}

	float NoV = clamp( dot( N, V ), 0.001, 1.0 );

    // Specular sampling
	if( rand < cumulativeSpecular ) {
        // Use TBN construction only when needed (optimization)
		mat3 TBN = constructTBN( N );
		vec3 localV = transpose( TBN ) * V;

        // Use VNDF sampling for better quality
		vec3 localH = sampleGGXVNDF( localV, material.roughness, xi );
		H = TBN * localH;

		float NoH = clamp( dot( N, H ), 0.001, 1.0 );
		float VoH = clamp( dot( V, H ), 0.001, 1.0 );

		float D = DistributionGGX( NoH, material.roughness );
		float G1 = GeometrySchlickGGX( NoV, material.roughness );

		result.direction = reflect( - V, H );
		result.pdf = D * G1 * VoH / ( NoV * 4.0 );
		result.value = evaluateMaterialResponse( V, result.direction, N, material );
		return result;
	}

    // Sheen sampling
	if( rand < cumulativeSheen ) {
		H = ImportanceSampleGGX( N, material.sheenRoughness, xi );
		float NoH = clamp( dot( N, H ), 0.0, 1.0 );
		float VoH = clamp( dot( V, H ), 0.0, 1.0 );
		result.direction = reflect( - V, H );
		result.pdf = SheenDistribution( NoH, material.sheenRoughness ) * NoH / ( 4.0 * VoH );
	}
    // Clearcoat sampling
	else if( rand < cumulativeClearcoat ) {
		float clearcoatRoughness = clamp( material.clearcoatRoughness, 0.089, 1.0 );
		H = ImportanceSampleGGX( N, clearcoatRoughness, xi );
		float NoH = clamp( dot( N, H ), 0.0, 1.0 );
		float VoH = clamp( dot( V, H ), 0.0, 1.0 );
		result.direction = reflect( - V, H );
		float D = DistributionGGX( NoH, clearcoatRoughness );
		float G1 = GeometrySchlickGGX( NoV, clearcoatRoughness );
		result.pdf = D * G1 * VoH / ( NoV * 4.0 );
	}
    // Transmission sampling
	else {
        // Use the shared microfacet transmission sampling function
		bool entering = dot( V, N ) < 0.0;
		MicrofacetTransmissionResult mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState );

        // Set the direction and PDF from the result
		result.direction = mtResult.direction;
		result.pdf = mtResult.pdf;
	}

    // Ensure minimum PDF value to prevent NaN/Inf
	result.pdf = max( result.pdf, MIN_PDF );
	result.value = evaluateMaterialResponse( V, result.direction, N, material );
	return result;
}

// Enhanced path contribution estimation with improved caching - OPTIMIZED
float estimatePathContribution( vec3 throughput, vec3 direction, RayTracingMaterial material, PathState pathState ) {
	float throughputStrength = maxComponent( throughput );

    // Use cached material classification with automatic caching
	MaterialClassification mc;
	if( pathState.classificationCached ) {
		mc = pathState.materialClass;
	} else {
		mc = classifyMaterial( material );
		// Auto-cache the classification for future use
		pathState.materialClass = mc;
		pathState.classificationCached = true;
	}

    // Enhanced material importance with interaction bonuses
	float materialImportance = mc.complexityScore;
	
	// Add interaction complexity bonuses for high-value material combinations
	if( mc.isMetallic && mc.isSmooth ) materialImportance += 0.15;
	if( mc.isTransmissive && mc.hasClearcoat ) materialImportance += 0.12;
	if( mc.isEmissive ) materialImportance += 0.1;
	
	materialImportance = clamp( materialImportance, 0.0, 1.0 );

    // Optimized direction importance calculation
	float directionImportance = 0.5; // Default value

    // Only calculate environment importance if beneficial
	if( enableEnvironmentLight && useEnvMapIS && throughputStrength > 0.01 ) {
        // Fast approximation using simplified PDF calculation - avoid expensive operations
		float cosTheta = clamp( direction.y, 0.0, 1.0 ); // Assume y-up environment
		directionImportance = mix( 0.3, 0.8, cosTheta * cosTheta ); // Squared for better distribution
	}

    // Enhanced weighting with throughput consideration
	float throughputWeight = smoothstep( 0.001, 0.1, throughputStrength );
	return throughputStrength * mix( materialImportance * 0.7, directionImportance, 0.3 ) * throughputWeight;
}

// Russian Roulette with enhanced material importance and optimized sampling - OPTIMIZED
bool handleRussianRoulette( int depth, vec3 throughput, RayTracingMaterial material, vec3 rayDirection, uint seed, PathState pathState ) {
    // Always continue for first few bounces
	if( depth < 3 ) {
		return true;
	}

    // Get throughput strength using shared function
	float throughputStrength = maxComponent( throughput );

    // Enhanced early rejection with better threshold
	if( throughputStrength < 0.0008 && depth > 4 ) {
		return false;
	}

    // Use cached material classification with fallback
	MaterialClassification mc;
	if( pathState.classificationCached ) {
		mc = pathState.materialClass;
	} else {
		mc = classifyMaterial( material );
		// Cache the result for potential future use
		pathState.materialClass = mc;
		pathState.classificationCached = true;
	}

    // Enhanced material importance with path-dependent adjustments
	float materialImportance = mc.complexityScore;

    // Boost importance for special materials based on path depth
	if( mc.isEmissive && depth < 6 ) {
		materialImportance += 0.3; // Emissive materials are important early in path
	}
	if( mc.isTransmissive && depth < 5 ) {
		materialImportance += 0.25; // Transmission effects fade with depth
	}
	if( mc.isMetallic && mc.isSmooth && depth < 4 ) {
		materialImportance += 0.2; // Perfect reflectors important early
	}

	materialImportance = clamp( materialImportance, 0.0, 1.0 );

    // Dynamic minimum bounces based on material complexity
	int minBounces = 3;
	if( materialImportance > 0.6 ) minBounces = 5;
	else if( materialImportance > 0.4 ) minBounces = 4;

	if( depth < minBounces ) {
		return true;
	}

    // Enhanced path importance calculation with caching
	float pathContribution;
	if( pathState.classificationCached && pathState.weightsComputed ) {
		pathContribution = pathState.pathImportance;
	} else {
		pathContribution = estimatePathContribution( throughput, rayDirection, material, pathState );
		// Cache the path importance for consistency
		pathState.pathImportance = pathContribution;
	}

    // Improved adaptive continuation probability with smoother transitions
	float rrProb;
	float adaptiveFactor = materialImportance * 0.4 + throughputStrength * 0.6;

	if( depth < 6 ) {
        // For early-medium bounces, use enhanced weighting
		rrProb = clamp( adaptiveFactor * 1.2, 0.15, 0.95 );
	} else if( depth < 10 ) {
        // For medium depth, blend with path contribution
		float baseProb = clamp( throughputStrength * 0.8, 0.08, 0.85 );
		rrProb = mix( baseProb, pathContribution, 0.6 );
	} else {
        // For deep paths, be more aggressive but consider material importance
		rrProb = clamp( throughputStrength * 0.4 + materialImportance * 0.1, 0.03, 0.6 );
	}

    // Enhanced material-specific boosts
	if( materialImportance > 0.5 ) {
		float boostFactor = ( materialImportance - 0.5 ) * 0.6; // More aggressive boost
		rrProb = mix( rrProb, 1.0, boostFactor );
	}

    // Smoother depth-based decay with material consideration
	float depthDecay = 0.12 + materialImportance * 0.08; // Slower decay for important materials
	float depthFactor = exp( - float( depth - minBounces ) * depthDecay );
	rrProb *= depthFactor;

    // Enhanced minimum probability based on material
	float minProb = mc.isEmissive ? 0.04 : 0.02;
	rrProb = max( rrProb, minProb );

    // Use the optimized Russian Roulette sampling for better quality
	float rrSample = getRussianRouletteSample( gl_FragCoord.xy, 0, depth, seed );
	return rrSample < rrProb;
}

vec4 sampleBackgroundLighting( int bounceIndex, vec3 direction ) {
	if( bounceIndex == 0 && ! showBackground ) {
		return vec4( 0.0 );
	}

    // Primary rays
	vec4 envColor = sampleEnvironment( direction ) * environmentIntensity; // hardcoded multiplier for testing

	if( bounceIndex == 0 ) {
		// Primary rays: always use full resolution for background
		return envColor * backgroundIntensity;
	} else {
        // Secondary rays
		return envColor * 2.0;
	}
}

vec3 regularizePathContribution( vec3 contribution, vec3 throughput, float pathLength ) {
    // Calculate throughput variation factor (path-specific logic)
	float throughputMax = maxComponent( throughput );
	float throughputMin = minComponent( throughput );

    // Calculate path "unusualness" factor with better metric
	float throughputVariation = ( throughputMax + 0.001 ) / ( throughputMin + 0.001 );

    // Path variation context multiplier
	float variationMultiplier = 1.0 / ( 1.0 + log( 1.0 + throughputVariation ) * pathLength * 0.1 );

    // Use shared firefly threshold calculation
	float threshold = calculateFireflyThreshold( fireflyThreshold, variationMultiplier, int( pathLength ) // Convert pathLength to bounce index approximation
	);

    // Apply consistent soft suppression
	return applySoftSuppressionRGB( contribution, threshold, 0.5 );
}

vec4 Trace( Ray ray, inout uint rngState, int rayIndex, int pixelIndex, out vec3 objectNormal, out vec3 objectColor, out float objectID ) {

	vec3 radiance = vec3( 0.0 );
	vec3 throughput = vec3( 1.0 );
	float alpha = 1.0;

	// Initialize edge detection variables
	objectNormal = vec3( 0.0 );
	objectColor = vec3( 0.0 );
	objectID = - 1000.0;

    // Store initial ray for helper visualization
    // Ray initialRay = ray;

    // Initialize media stack
	MediumStack mediumStack;
	mediumStack.depth = 0;

    // Initialize render state
	RenderState state;
	state.transmissiveTraversals = transmissiveBounces;

    // Enhanced path state initialization for better caching - OPTIMIZED
	PathState pathState;
	pathState.weightsComputed = false;
	pathState.classificationCached = false;
	pathState.texturesLoaded = false;
	pathState.pathImportance = 0.0; // Initialize path importance cache

	for( int bounceIndex = 0; bounceIndex <= maxBounceCount; bounceIndex ++ ) {
        // Update state for this bounce
		state.traversals = maxBounceCount - bounceIndex;
		state.firstRay = ( bounceIndex == 0 ) && ( state.transmissiveTraversals == transmissiveBounces );

		HitInfo hitInfo = traverseBVH( ray, stats, false );

		if( ! hitInfo.didHit ) {
            // Environment lighting
			vec4 envColor = sampleBackgroundLighting( bounceIndex, ray.direction );
			radiance += regularizePathContribution( envColor.rgb * throughput, throughput, float( bounceIndex ) );
			alpha *= envColor.a;
            // return vec4(envColor, 1.0);
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
			// Convert height sample from [0,1] to [-0.5, 0.5] for better displacement
			float displacementHeight = (heightSample - 0.5) * material.displacementScale;
			vec3 displacement = N * displacementHeight;
			hitInfo.hitPoint += displacement;
			
			// Calculate displaced normal but blend with original to preserve material characteristics
			if( material.displacementScale > 0.01 ) {
				vec3 displacedNormal = calculateDisplacedNormal( hitInfo.hitPoint, N, hitInfo.uv, material );
				// Blend displaced normal with original based on roughness to preserve material characteristics
				float blendFactor = clamp( material.displacementScale * 0.5, 0.1, 0.8 );
				// Reduce blend factor for rough materials to preserve their surface characteristics
				blendFactor *= (1.0 - material.roughness * 0.5);
				N = normalize( mix( N, displacedNormal, blendFactor ) );
			}
		}

        // Handle transparent materials with transmission
		MaterialInteractionResult interaction = handleMaterialTransparency( ray, hitInfo.hitPoint, N, material, rngState, state, mediumStack );

		if( interaction.continueRay ) {
			// Handle both transmissive interactions and alpha skips as "free" bounces
			if( ( interaction.isTransmissive || interaction.isAlphaSkip ) && state.transmissiveTraversals > 0 ) {
				// Decrement transmissive bounces counter
				state.transmissiveTraversals --;

				// Don't increment the main bounce counter (effectively giving a "free" bounce)
				if( state.transmissiveTraversals > 0 ) {
					bounceIndex --;
				}
			}

			// Update ray and continue
			throughput *= interaction.throughput;
			alpha *= interaction.alpha;
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
			ray.direction = interaction.direction;

			// Reset path state for new material
			pathState.weightsComputed = false;
			continue;
		}

        // Apply transparency alpha
		alpha *= interaction.alpha;

		vec2 randomSample = getRandomSample( gl_FragCoord.xy, rayIndex, bounceIndex, rngState, - 1 );

		vec3 V = - ray.direction; // View direction, negative means pointing towards camera
		material.sheenRoughness = clamp( material.sheenRoughness, MIN_ROUGHNESS, MAX_ROUGHNESS );

        // Create material cache if not already created
		if( ! pathState.weightsComputed ) {
			pathState.materialCache = createMaterialCache( N, V, material, matSamples, pathState.materialClass );
			pathState.texturesLoaded = true;
		}

		DirectionSample brdfSample;
        // Handle clear coat
		if( material.clearcoat > 0.0 ) {
			vec3 L;
			float pdf;
			brdfSample.value = sampleClearcoat( ray, hitInfo, material, randomSample, L, pdf, rngState );
			brdfSample.direction = L;
			brdfSample.pdf = pdf;
		} else {
			brdfSample = generateSampledDirection( V, N, material, randomSample, rngState, pathState );
		}

        // Get importance sampling info with caching
		if( ! pathState.weightsComputed || bounceIndex == 0 ) {
			pathState.samplingInfo = getImportanceSamplingInfo( material, bounceIndex, pathState.materialClass );
		}

        // Add emissive contribution
		radiance += matSamples.emissive * throughput;

        // Indirect lighting using MIS with cached sampling info
		IndirectLightingResult indirectResult = calculateIndirectLighting( V, N, material, brdfSample, rayIndex, bounceIndex, rngState, pathState.samplingInfo );
		throughput *= indirectResult.throughput * indirectResult.misWeight;

		// Early ray termination - check immediately after throughput update
		float maxThroughput = max( max( throughput.r, throughput.g ), throughput.b );
		if( maxThroughput < 0.001 && bounceIndex > 2 ) {
			break; // Path contribution too small, terminate early
		}

        // Add direct lighting contribution with cached material data
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, brdfSample, rayIndex, bounceIndex, rngState, stats );
		radiance += regularizePathContribution( directLight * throughput, throughput, float( bounceIndex ) );

        // Prepare for next bounce
		ray.origin = hitInfo.hitPoint + N * 0.001;
		ray.direction = indirectResult.direction;

		if( bounceIndex == 0 && hitInfo.didHit ) {
			objectNormal = N; // Surface normal from first hit
			objectColor = material.color.rgb; // Surface color
			objectID = float( hitInfo.materialIndex ); // Material/object identifier
		}

        // Russian roulette path termination
		if( ! handleRussianRoulette( bounceIndex, throughput, material, ray.direction, rngState, pathState ) ) {
			break;
		}
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

	// Final firefly reduction pass for accumulated radiance
	if( fireflyThreshold > 0.0 ) {
		float globalThreshold = fireflyThreshold * 2.0; // More lenient for final result
		radiance = applySoftSuppressionRGB( radiance, globalThreshold, 0.3 );
	}

	return vec4( max( radiance, vec3( 0.0 ) ), alpha );  // Ensure non-negative output
}

vec3 dithering( vec3 color, uint seed ) {
    //Calculate grid position
	float grid_position = RandomValue( seed );

    //Shift the individual colors differently, thus making it even harder to see the dithering pattern
	vec3 dither_shift_RGB = vec3( 0.25 / 255.0, - 0.25 / 255.0, 0.25 / 255.0 );

    //modify shift according to grid position.
	dither_shift_RGB = mix( 2.0 * dither_shift_RGB, - 2.0 * dither_shift_RGB, grid_position );

    //shift the color by dither_shift
	return color + dither_shift_RGB;
}

int getRequiredSamples( int pixelIndex ) {
	vec2 texCoord = gl_FragCoord.xy / resolution;
	vec4 samplingData = texture( adaptiveSamplingTexture, texCoord );

	// Early exit for converged pixels
	if( samplingData.b > 0.5 ) {
		return 0;
	}

	// Get normalized sample count
	float normalizedSamples = samplingData.r;

	// Stable conversion with minimum guarantee  
	float targetSamples = normalizedSamples * float( adaptiveSamplingMax );
	int samples = int( floor( targetSamples + 0.5 ) ); // More stable rounding

	// Ensure minimum samples and valid range
	return clamp( samples, 1, adaptiveSamplingMax );
}

// Helper function to linearize depth for MRT
float linearizeDepth( float depth ) {
    // Simple linear depth - you can adjust near/far as needed
	float near = 0.1;
	float far = 1000.0;
	float z = depth * 2.0 - 1.0;
	return ( 2.0 * near * far ) / ( far + near - z * ( far - near ) ) / far;
}

#include debugger.fs

void main( ) {

	vec2 screenPosition = ( gl_FragCoord.xy / resolution ) * 2.0 - 1.0;

	Pixel pixel;
	pixel.color = vec4( 0.0 );
	pixel.samples = 0;

	uint baseSeed = getDecorrelatedSeed( gl_FragCoord.xy, 0, frame );
	int pixelIndex = int( gl_FragCoord.y ) * int( resolution.x ) + int( gl_FragCoord.x );

	// MRT data
	vec3 worldNormal = vec3( 0.0, 0.0, 1.0 );
	float linearDepth = 1.0;

	int samplesCount = numRaysPerPixel;

	if( frame > 2u && useAdaptiveSampling ) {
		samplesCount = getRequiredSamples( pixelIndex );
		if( samplesCount == 0 ) {
			// Pixel is converged - use accumulated result
			#ifdef ENABLE_ACCUMULATION
			if( enableAccumulation && hasPreviousAccumulated ) {
				gColor = texture( previousAccumulatedTexture, gl_FragCoord.xy / resolution );
			} else {
				// No accumulation available, still need to render at least 1 sample
				samplesCount = 1;
			}
			#else
			// No accumulation enabled, render at least 1 sample
			samplesCount = 1;
			#endif
			
			if( samplesCount == 0 ) {
				// Always output normal/depth for MRT even for converged pixels
				gNormalDepth = vec4( 0.5, 0.5, 1.0, 1.0 );
				return;
			}
		}
	}

	vec3 objectNormal = vec3( 0.0 );
	vec3 objectColor = vec3( 0.0 );
	float objectID = - 1000.0;
	float pixelSharpness = 0.0;

	for( int rayIndex = 0; rayIndex < samplesCount; rayIndex ++ ) {
		uint seed = pcg_hash( baseSeed + uint( rayIndex ) );

		vec2 stratifiedJitter = getStratifiedSample( gl_FragCoord.xy, rayIndex, samplesCount, seed );

		if( visMode == 5 ) {
			gColor = vec4( stratifiedJitter, 1.0, 1.0 );
			gNormalDepth = vec4( 0.5, 0.5, 1.0, 1.0 );
			return;
		}

		vec2 jitter = ( stratifiedJitter - 0.5 ) * ( 2.0 / resolution );
		vec2 jitteredScreenPosition = screenPosition + jitter;

		Ray ray = generateRayFromCamera( jitteredScreenPosition, seed );

		vec4 _sample;
		if( visMode > 0 ) {
			_sample = TraceDebugMode( ray.origin, ray.direction );
		} else {
			vec3 sampleNormal, sampleColor;
			float sampleID;
			_sample = Trace( ray, seed, rayIndex, pixelIndex, sampleNormal, sampleColor, sampleID );

			// Accumulate edge detection data from primary rays
			if( rayIndex == 0 ) {
				objectNormal = sampleNormal;
				objectColor = sampleColor;
				objectID = sampleID;

				// Set MRT data from first hit
				worldNormal = normalize( sampleNormal );
				linearDepth = linearizeDepth( gl_FragCoord.z );
			}
		}

		pixel.color += _sample;
		pixel.samples ++;

	}

	pixel.color /= float( pixel.samples );

	// Edge Detection
	float edge0 = 0.2;
	float edge1 = 0.6;

	float difference_Nx = fwidth( objectNormal.x );
	float difference_Ny = fwidth( objectNormal.y );
	float difference_Nz = fwidth( objectNormal.z );
	float normalDifference = smoothstep( edge0, edge1, difference_Nx ) +
		smoothstep( edge0, edge1, difference_Ny ) +
		smoothstep( edge0, edge1, difference_Nz );

	float objectDifference = min( fwidth( objectID ), 1.0 );
	float colorDifference = ( fwidth( objectColor.r ) + fwidth( objectColor.g ) + fwidth( objectColor.b ) ) > 0.0 ? 1.0 : 0.0;

	// Mark pixel as edge if any edge condition is met
	if( colorDifference > 0.0 || normalDifference >= 0.9 || objectDifference >= 1.0 ) {
		pixelSharpness = 1.0;
	}

	pixel.color = vec4( pixel.color.rgb, pixelSharpness );

	// Temporal accumulation logic
	vec3 finalColor = pixel.color.rgb;

	#ifdef ENABLE_ACCUMULATION
	if( enableAccumulation && ! cameraIsMoving && frame > 1u && hasPreviousAccumulated ) {

		// Get previous accumulated color
		vec3 previousColor = texture( previousAccumulatedTexture, gl_FragCoord.xy / resolution ).rgb;
		finalColor = previousColor + ( pixel.color.rgb - previousColor ) * accumulationAlpha;

	}
	#endif

    // pixel.color.rgb = applyDithering( pixel.color.rgb, gl_FragCoord.xy / resolution, 0.5 ); // 0.5 is the dithering amount
    // pixel.color.rgb = dithering( pixel.color.rgb, seed );

	// Clean MRT output
	gColor = vec4( finalColor, 1.0 );
	gNormalDepth = vec4( worldNormal * 0.5 + 0.5, linearDepth );
}