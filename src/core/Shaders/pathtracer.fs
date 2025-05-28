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
#include random.fs
#include rayintersection.fs
#include environment.fs
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

    // Compute BRDF weights only if not already cached
	if( ! pathState.weightsComputed ) {
		pathState.brdfWeights = calculateBRDFWeights( material );
		pathState.weightsComputed = true;
	}

	BRDFWeights weights = pathState.brdfWeights;
	DirectionSample result;

	float rand = xi.x;
	vec3 H;

    // Cumulative probability approach for sampling selection
	float cumulativeDiffuse = weights.diffuse;
	float cumulativeSpecular = cumulativeDiffuse + weights.specular;
	float cumulativeSheen = cumulativeSpecular + weights.sheen;
	float cumulativeClearcoat = cumulativeSheen + weights.clearcoat;
    // Transmission is the remainder

    // Diffuse sampling
	if( rand < cumulativeDiffuse ) {
		result.direction = ImportanceSampleCosine( N, xi );
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
float estimatePathContribution( vec3 throughput, vec3 direction, RayTracingMaterial material ) {
	float throughputStrength = maxComponent( throughput );

    // Consider material importance
	float materialImportance = 0.5;
	if( material.metalness > 0.7 || material.transmission > 0.3 ) {
		materialImportance = 0.8;
	} else if( material.roughness > 0.8 ) {
		materialImportance = 0.3;
	}

    // Consider direction importance (if pointing toward bright areas)
	float directionImportance = 0.5;
	if( enableEnvironmentLight && useEnvMapIS ) {
        // This will be higher for directions pointing toward bright environment areas
		directionImportance = min( envMapSamplingPDF( direction ) * 0.1, 1.0 );
	}

	return throughputStrength * mix( materialImportance, directionImportance, 0.5 );
}

// Russian Roulette with vectorized operations
bool handleRussianRoulette( int depth, vec3 throughput, RayTracingMaterial material, vec3 rayDirection, uint seed ) {
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

    // Determine material importance more precisely
	float materialImportance = 0.0;

    // High importance materials
	if( material.transmission > 0.3 ) {
		materialImportance += 0.3 * material.transmission;
	}
	if( material.metalness > 0.7 ) {
		materialImportance += 0.2 * material.metalness;
	}
	if( material.clearcoat > 0.5 ) {
		materialImportance += 0.1 * material.clearcoat;
	}
	if( dot( material.emissive, vec3( 1.0 ) ) > 0.0 ) {
		materialImportance += 0.4;
	}

	materialImportance = clamp( materialImportance, 0.0, 1.0 );

    // Determine minimum bounces based on material importance
	int minBounces = materialImportance > 0.5 ? 5 : 3;

	if( depth < minBounces ) {
		return true;
	}

    // Calculate path contribution estimate
	float pathContribution = estimatePathContribution( throughput, rayDirection, material );

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
	uint threshold = uint( rrProb * 4294967295.0 );
	return seed < threshold;
}

vec4 sampleBackgroundLighting( int bounceIndex, vec3 direction ) {

	if( bounceIndex == 0 ) {

		return showBackground ? sampleEnvironment( direction ) * backgroundIntensity * PI_INV * 2.0 : vec4( 0.0 );
	}

	return sampleEnvironment( direction );

}

vec3 regularizePathContribution( vec3 contribution, vec3 throughput, float pathLength ) {
    // Use shared maxComponent function
	float throughputMax = maxComponent( throughput );
	float throughputMin = minComponent( throughput );

    // Calculate path "unusualness" factor with better metric
	float throughputVariation = ( throughputMax + 0.001 ) / ( throughputMin + 0.001 );

    // Scale clamp threshold based on path length and throughput variation
	float clampFactor = 1.0 / ( 1.0 + log( 1.0 + throughputVariation ) * pathLength * 0.1 );
	float clampThreshold = fireflyThreshold * clampFactor;

    // Use shared luminance function
	float lum = luminance( contribution );

    // Apply smooth clamping for values near the threshold
	if( lum > clampThreshold ) {
        // Smooth transition using a softer curve
		float excess = lum - clampThreshold;
		float suppressionFactor = clampThreshold / ( clampThreshold + excess * 0.5 );
		return contribution * suppressionFactor;
	}

	return contribution;
}

vec4 Trace( Ray ray, inout uint rngState, int rayIndex, int pixelIndex ) {
	// Initialize environment rotation matrices once per pixel
    // This could also be done once per frame if environmentRotation is uniform
	if( rayIndex == 0 ) {
		initializeEnvironmentRotation( );
	}

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
		radiance += matSamples.emissive * throughput * PI;

        // Get importance sampling info with caching
		if( ! pathState.weightsComputed || bounceIndex == 0 ) {
			pathState.samplingInfo = getImportanceSamplingInfo( material, bounceIndex );
		}

        // Indirect lighting using MIS with cached sampling info
		IndirectLightingResult indirectResult = calculateIndirectLighting( V, N, material, brdfSample, rayIndex, bounceIndex, rngState, pathState.samplingInfo );
		throughput *= indirectResult.throughput;

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
		if( ! handleRussianRoulette( bounceIndex, throughput, material, ray.direction, rngState ) ) {
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

	uint seed = uint( gl_FragCoord.x ) + uint( gl_FragCoord.y ) * uint( resolution.x ) + frame * uint( resolution.x ) * uint( resolution.y );
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

		// Pre-calculate common values outside the loop
		vec2 invResolution = 1.0 / resolution;
		vec2 doubleInvResolution = 2.0 * invResolution;

		for( int rayIndex = 0; rayIndex < samplesCount; rayIndex ++ ) {

			vec4 _sample = vec4( 0.0 );
			vec2 jitterSample = getRandomSample( gl_FragCoord.xy, rayIndex, 0, seed, 3 );

			if( visMode == 5 ) {
				fragColor = vec4( jitterSample, 1.0, 1.0 );
				return;
			}

			vec2 jitter = ( jitterSample - 0.5 ) * doubleInvResolution;
			vec2 jitteredScreenPosition = screenPosition + jitter;

			Ray ray = generateRayFromCamera( jitteredScreenPosition, seed );

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