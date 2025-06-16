precision highp float;
precision highp sampler2DArray;

out vec4 fragColor; 

// Uniform declarations remain the same
uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform bool showBackground;
uniform float backgroundIntensity; // Add backgroundIntensity uniform
uniform int renderMode; // 0: Regular, 1: Tiled
uniform int tiles; // number of tiles
uniform int visMode;
uniform float debugVisScale;
uniform sampler2D adaptiveSamplingTexture; // Contains sampling data from AdaptiveSamplingPass
uniform sampler2D previousFrameTexture; // Texture from the previous frame
uniform sampler2D accumulatedFrameTexture; // texture of the accumulated frame for temporal anti-aliasing
uniform bool useAdaptiveSampling;
uniform int adaptiveSamplingMax;
uniform float fireflyThreshold;

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
#include bvhtraverse.fs
#include texture_sampling.fs
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

    // Compute BRDF weights and classification if not already cached
	if( ! pathState.weightsComputed ) {
		pathState.brdfWeights = calculateBRDFWeights( material );
		pathState.weightsComputed = true;
	}

	if( ! pathState.classificationCached ) {
		pathState.materialClass = classifyMaterial( material );
		pathState.classificationCached = true;
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

// Estimate path contribution potential
float estimatePathContribution( vec3 throughput, vec3 direction, RayTracingMaterial material, PathState pathState ) {
	float throughputStrength = maxComponent( throughput );

    // Use cached material classification if available
	MaterialClassification mc;
	if( pathState.classificationCached ) {
		mc = pathState.materialClass;
	} else {
		mc = classifyMaterial( material );
	}

    // Fast material importance using classification
	float materialImportance = mc.complexityScore;

    // Direction importance calculation
	float directionImportance = 0.5; // Default value

    // Only calculate environment importance if it's enabled and useful
	if( enableEnvironmentLight && useEnvMapIS ) {
        // Fast approximation using simplified PDF calculation
		directionImportance = min( calculateEnvironmentPDF( direction, 0.0 ) * 0.1, 1.0 );
	}

	return throughputStrength * mix( materialImportance, directionImportance, 0.5 );
}

// Russian Roulette with vectorized operations
bool handleRussianRoulette( int depth, vec3 throughput, RayTracingMaterial material, vec3 rayDirection, uint seed, PathState pathState ) {
    // Always continue for first few bounces
	if( depth < 3 ) {
		return true;
	}

    // Get throughput strength using shared function
	float throughputStrength = maxComponent( throughput );

    // Quick rejection for very dark paths
	if( throughputStrength < 0.001 && depth > 5 ) {
		return false;
	}

    // Use cached material classification
	MaterialClassification mc;
	if( pathState.classificationCached ) {
		mc = pathState.materialClass;
	} else {
		mc = classifyMaterial( material );
	}

    // Fast material importance using pre-computed complexity score
	float materialImportance = mc.complexityScore;

    // Additional importance for special materials
	if( mc.isEmissive ) {
		materialImportance += 0.4;
	}

	materialImportance = clamp( materialImportance, 0.0, 1.0 );

    // Determine minimum bounces based on material importance
	int minBounces = materialImportance > 0.5 ? 5 : 3;

	if( depth < minBounces ) {
		return true;
	}

    // Use cached path importance if available
	float pathContribution;
	if( pathState.classificationCached && pathState.weightsComputed ) {
		pathContribution = pathState.pathImportance;
	} else {
		pathContribution = estimatePathContribution( throughput, rayDirection, material, pathState );
	}

    // Adaptive continuation probability
	float rrProb;

	if( depth < 5 ) {
        // For early bounces, use path contribution directly
		rrProb = clamp( pathContribution, 0.1, 0.95 );
	} else if( depth < 8 ) {
        // For medium depth, blend between contribution and throughput
		float simpleProb = clamp( throughputStrength, 0.05, 0.9 );
		rrProb = mix( simpleProb, pathContribution, 0.5 );
	} else {
        // For deep paths, be more aggressive with termination
		rrProb = clamp( throughputStrength * 0.5, 0.02, 0.7 );
	}

    // Boost probability for important materials
	if( materialImportance > 0.5 ) {
		rrProb = mix( rrProb, 1.0, materialImportance * 0.3 );
	}

    // Apply smooth depth-based decay
	float depthFactor = exp( - float( depth - minBounces ) * 0.15 );
	rrProb *= depthFactor;

    // Ensure minimum probability
	rrProb = max( rrProb, 0.02 );

    // Make the RR test
	// Hash the seed to avoid bias
	uint hashedSeed = pcg_hash( seed );
	uint threshold = uint( rrProb * 4294967295.0 );
	return hashedSeed < threshold;
}

vec4 sampleBackgroundLighting( int bounceIndex, vec3 direction ) {
	if( bounceIndex == 0 ) {
        // Primary rays: use background intensity scaling
		if( showBackground ) {
			return sampleEnvironment( direction ) * backgroundIntensity;
		} else {
			return vec4( 0.0 );
		}
	} else {
        // Secondary rays: use enhanced environment contribution with LOD
        // OPTIMIZED: When IS is enabled, use slightly higher quality for early bounces
		if( useEnvMapIS && bounceIndex <= 2 ) {
			return getEnvironmentContribution( direction, bounceIndex );
		} else {
			return getEnvironmentContribution( direction, bounceIndex );
		}
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

vec4 Trace( Ray ray, inout uint rngState, int rayIndex, int pixelIndex ) {

	vec3 radiance = vec3( 0.0 );
	vec3 throughput = vec3( 1.0 );
	float alpha = 1.0;

    // Store initial ray for helper visualization
    // Ray initialRay = ray;

    // Initialize media stack
	MediumStack mediumStack;
	mediumStack.depth = 0;

    // Initialize render state
	RenderState state;
	state.transmissiveTraversals = transmissiveBounces;

    // Initialize path state for caching
	PathState pathState;
	pathState.weightsComputed = false;

	for( int bounceIndex = 0; bounceIndex <= maxBounceCount; bounceIndex ++ ) {
        // Update state for this bounce
		state.traversals = maxBounceCount - bounceIndex;
		state.firstRay = ( bounceIndex == 0 ) && ( state.transmissiveTraversals == transmissiveBounces );

		HitInfo hitInfo = traverseBVH( ray, stats );

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
			pathState.materialCache = createMaterialCache( N, V, material, matSamples );
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

        // Add emissive contribution
		radiance += matSamples.emissive * throughput;

        // Get importance sampling info with caching
		if( ! pathState.weightsComputed || bounceIndex == 0 ) {
			pathState.samplingInfo = getImportanceSamplingInfo( material, bounceIndex );
		}

        // Indirect lighting using MIS with cached sampling info
		IndirectLightingResult indirectResult = calculateIndirectLighting( V, N, material, brdfSample, rayIndex, bounceIndex, rngState, pathState.samplingInfo );
		throughput *= indirectResult.throughput * indirectResult.misWeight;

        // Add direct lighting contribution with cached material data
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, brdfSample, rayIndex, bounceIndex, rngState, stats );
		radiance += regularizePathContribution( directLight * throughput, throughput, float( bounceIndex ) );

        // Prepare for next bounce
		ray.origin = hitInfo.hitPoint + N * 0.001;
		ray.direction = indirectResult.direction;

        // Check if path contribution is becoming negligible
		float maxThroughput = max( max( throughput.r, throughput.g ), throughput.b );
		if( maxThroughput < 0.001 && bounceIndex > 2 ) {
			break; // Path contribution too small, terminate early
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

bool shouldRenderPixel( ) {

	if( renderMode == 1 ) { // Tiled rendering

		ivec2 tileCount = ivec2( resolution ) / ( ivec2( resolution ) / tiles );
		ivec2 tileCoord = ivec2( gl_FragCoord.xy ) / ( ivec2( resolution ) / tiles );
		int totalTiles = tileCount.x * tileCount.y;
		int currentTile = int( frame ) % totalTiles;

		int tileIndex = tileCoord.y * tileCount.x + tileCoord.x;
		return tileIndex == currentTile;

	}

	return true; // Default to rendering all pixels that is Regular rendering
}

#include debugger.fs

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

	// Fast conversion without branching
	int samples = int( normalizedSamples * float( adaptiveSamplingMax ) + 0.5 );

	// Clamp to valid range
	return clamp( samples, 1, adaptiveSamplingMax );
}

void main( ) {

	vec2 screenPosition = ( gl_FragCoord.xy / resolution ) * 2.0 - 1.0;

	Pixel pixel;
	pixel.color = vec4( 0.0 );
	pixel.samples = 0;

	uint baseSeed = getDecorrelatedSeed( gl_FragCoord.xy, 0, frame );
	int pixelIndex = int( gl_FragCoord.y ) * int( resolution.x ) + int( gl_FragCoord.x );

	bool shouldRender = shouldRenderPixel( );

	if( shouldRender ) {
		int samplesCount = numRaysPerPixel;

		if( frame > 2u && useAdaptiveSampling ) {
			samplesCount = getRequiredSamples( pixelIndex );
			if( samplesCount == 0 ) {
                // Use the previous frame's color (it's converged or temporarily skipped)
				fragColor = texture( accumulatedFrameTexture, gl_FragCoord.xy / resolution );
				return;
			}
		}

		for( int rayIndex = 0; rayIndex < samplesCount; rayIndex ++ ) {
			uint seed = pcg_hash( baseSeed + uint( rayIndex ) );

            // Use stratified sampling for better distribution
			vec2 stratifiedJitter = getStratifiedSample( gl_FragCoord.xy, rayIndex, samplesCount, seed );

			if( visMode == 5 ) {
				fragColor = vec4( stratifiedJitter, 1.0, 1.0 );
				return;
			}

			vec2 jitter = ( stratifiedJitter - 0.5 ) * ( 2.0 / resolution );
			vec2 jitteredScreenPosition = screenPosition + jitter;

			Ray ray = generateRayFromCamera( jitteredScreenPosition, seed );

			vec4 _sample;
			if( visMode > 0 ) {
				_sample = TraceDebugMode( ray.origin, ray.direction );
			} else {
				_sample = Trace( ray, seed, rayIndex, pixelIndex );
			}

			pixel.color += _sample;
			pixel.samples ++;

		}

		pixel.color /= float( pixel.samples );

	} else {
        // For pixels that are not rendered in this frame, use the color from the previous frame
		pixel.color = texture( previousFrameTexture, gl_FragCoord.xy / resolution );
	}

    // pixel.color.rgb = applyDithering( pixel.color.rgb, gl_FragCoord.xy / resolution, 0.5 ); // 0.5 is the dithering amount
    // pixel.color.rgb = dithering( pixel.color.rgb, seed );

	fragColor = vec4( pixel.color.rgb, 1.0 );
}