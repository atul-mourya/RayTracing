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
uniform float fireflyThreshold;

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
DirectionSample generateSampledDirection( vec3 V, vec3 N, RayTracingMaterial material, vec2 xi, inout uint rngState ) {

	BRDFWeights weights = calculateBRDFWeights( material );
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
		bool entering = dot(V, N) < 0.0;
		MicrofacetTransmissionResult mtResult = sampleMicrofacetTransmission(
			V, N, material.ior, material.roughness, entering,
			material.dispersion, xi, rngState
		);
		
		// Set the direction and PDF from the result
		result.direction = mtResult.direction;
		result.pdf = mtResult.pdf;
	}

    // Ensure minimum PDF value to prevent NaN/Inf
	result.pdf = max( result.pdf, MIN_PDF );
	result.value = evaluateMaterialResponse( V, result.direction, N, material );
	return result;
}

// Russian Roulette with vectorized operations
bool handleRussianRoulette( int depth, vec3 rayColor, RayTracingMaterial material, uint seed ) {
    // Always continue for first few bounces
	if( depth < 2 )
		return true;

	// Calculate luminance for importance-based termination
	float lum = luminance( rayColor );

    // Quick rejection for very dark paths
	if( lum < 0.001 && depth > 3 )
		return false;

    // Adaptive minimum bounces based on material properties
    // More bounces for materials that contribute more to final image
	bool isImportantMaterial = material.transmission > 0.5 || material.metalness > 0.7 || material.emissive.r + material.emissive.g + material.emissive.b > 0.0;
	int minBounces = isImportantMaterial ? 4 : 3;

	if( depth < minBounces )
		return true;

    // Calculate continuation probability with bias toward brighter paths
	float rrProb = clamp( lum, 0.05, 0.95 );

    // Performance optimization: use bit operations for random test when possible
    // (some hardware may handle this better than floating point comparison)
	uint threshold = uint( rrProb * 4294967295.0 );
	uint randVal = seed; // Use the seed directly or mix it further if needed

	bool shouldContinue = randVal < threshold;

    // Apply throughput correction only if continuing
	if( shouldContinue ) {
		rayColor *= 1.0 / rrProb;
	}

	return shouldContinue;
}

vec4 sampleBackgroundLighting( int bounceIndex, vec3 direction ) {

	if( bounceIndex == 0 ) {

		return showBackground ? sampleEnvironment( direction ) * backgroundIntensity * PI_INV * 2.0 : vec4( 0.0 );
	}

	return sampleEnvironment( direction );

}

vec4 Trace( Ray ray, inout uint rngState, int rayIndex, int pixelIndex ) {
	vec3 radiance = vec3( 0.0 );
	vec3 throughput = vec3( 1.0 );
	float alpha = 1.0;

	// Store initial ray for helper visualization
	// Ray initialRay = ray;

	for( int bounceIndex = 0; bounceIndex <= maxBounceCount; bounceIndex ++ ) {
		HitInfo hitInfo = traverseBVH( ray, stats );

		if( ! hitInfo.didHit ) {
			// Environment lighting
			vec4 envColor = sampleBackgroundLighting( bounceIndex, ray.direction );
			radiance += reduceFireflies( envColor.rgb * throughput, fireflyThreshold );
			alpha *= envColor.a;
			// return vec4(envColor, 1.0);
			break;
		}

		RayTracingMaterial material = hitInfo.material;
		material.color = sampleAlbedoTexture( material, hitInfo.uv );

		// Calculate perturb normal
		vec3 N = sampleNormalMap( material, hitInfo.uv, hitInfo.normal );
		material.metalness = sampleMetalnessMap( material, hitInfo.uv );
		material.roughness = clamp( sampleRoughnessMap( material, hitInfo.uv ), MIN_ROUGHNESS, MAX_ROUGHNESS );

		// Handle transparent materials with transmission
		MaterialInteractionResult interaction = handleMaterialTransparency( ray, hitInfo.hitPoint, N, material, rngState );

		if( interaction.continueRay ) {
            // If the ray continues, update throughput and alpha
			throughput *= interaction.throughput;
			alpha *= interaction.alpha;
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
			ray.direction = interaction.direction;
			continue;
		}

        // Apply transparency alpha
		alpha *= interaction.alpha;

		vec2 randomSample = getRandomSample( gl_FragCoord.xy, rayIndex, bounceIndex, rngState, - 1 );

		vec3 V = - ray.direction; // View direction, negative means pointing towards camera
		material.sheenRoughness = clamp( material.sheenRoughness, MIN_ROUGHNESS, MAX_ROUGHNESS );

		DirectionSample brdfSample;
		// Handle clear coat
		if( material.clearcoat > 0.0 ) {
			vec3 L;
			float pdf;
			brdfSample.value = sampleClearcoat( ray, hitInfo, material, randomSample, L, pdf, rngState );
			brdfSample.direction = L;
			brdfSample.pdf = pdf;
		} else {
			brdfSample = generateSampledDirection( V, N, material, randomSample, rngState );
		}

        // Add emissive contribution
		radiance += sampleEmissiveMap( material, hitInfo.uv ) * throughput * PI;

		// Indirect lighting using MIS
		IndirectLightingResult indirectResult = calculateIndirectLighting( V, N, material, brdfSample, rayIndex, bounceIndex, rngState );
		throughput *= reduceFireflies( indirectResult.throughput, fireflyThreshold );

		// Add direct lighting contribution
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, brdfSample, rayIndex, bounceIndex, rngState, stats );
		radiance += reduceFireflies( directLight * throughput, fireflyThreshold );
		// return vec4(directLight, 1.0);

        // Prepare for next bounce
		ray.origin = hitInfo.hitPoint + N * 0.001;
		ray.direction = brdfSample.direction;

		// Russian roulette path termination
		if( ! handleRussianRoulette( bounceIndex, throughput, material, rngState ) ) {
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
	return int( texture( adaptiveSamplingTexture, texCoord ).r );
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
            // Get required samples from the adaptive sampling pass
			samplesCount = getRequiredSamples( pixelIndex );
			if( samplesCount == 0 ) {
                // Use the previous frame's color
				pixel.color = texture( accumulatedFrameTexture, gl_FragCoord.xy / resolution );
				fragColor = vec4( pixel.color.rgb, 1.0 );
				return;
			}
		}

		for( int rayIndex = 0; rayIndex < samplesCount; rayIndex ++ ) {

			vec4 _sample = vec4( 0.0 );
			vec2 jitterSample = getRandomSample( gl_FragCoord.xy, rayIndex, 0, seed, 5 );

			if( visMode == 5 ) {
				fragColor = vec4( jitterSample, 1.0, 1.0 );
				return;
			}

			vec2 jitter = ( jitterSample - 0.5 ) * ( 1.0 / resolution ) * 2.0;
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
