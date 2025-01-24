precision highp float;

// Uniform declarations remain the same
uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform bool showBackground;
uniform int renderMode; // 0: Regular, 1: Tiled
uniform int tiles; // number of tiles
uniform int visMode;
uniform float debugVisScale;
uniform sampler2D adaptiveSamplingTexture; // Contains sampling data from AdaptiveSamplingPass
uniform sampler2D previousFrameTexture; // Texture from the previous frame
uniform sampler2D accumulatedFrameTexture; // texture of the accumulated frame for temporal anti-aliasing
uniform bool useAdaptiveSampling;

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
BRDFSample sampleBRDF( vec3 V, vec3 N, RayTracingMaterial material, vec2 xi, inout uint rngState ) {

	BRDFWeights weights = calculateBRDFWeights( material );
	BRDFSample result;

	float rand = xi.x;
	vec3 H;

	float cumulativeDiffuse = weights.diffuse;
	if( rand < cumulativeDiffuse ) {
        // Diffuse sampling
		result.direction = ImportanceSampleCosine( N, xi );
		result.pdf = max( dot( N, result.direction ), 0.0 ) * PI_INV;
		result.value = evaluateBRDF( V, result.direction, N, material );
		return result;
	}

	float cumulativeSpecular = cumulativeDiffuse + weights.specular;
	if( rand < cumulativeSpecular ) {
        // specular sampling
		mat3 TBN = constructTBN( N );
		vec3 localV = transpose( TBN ) * V;
		vec3 localH = sampleGGXVNDF( localV, material.roughness, xi );
		H = TBN * localH;

		float NoV = max( dot( N, V ), 0.001 );
		float NoH = max( dot( N, H ), 0.001 );
		float VoH = max( dot( V, H ), 0.001 );

		float D = DistributionGGX( NoH, material.roughness );
		float G1 = GeometrySchlickGGX( NoV, material.roughness );

		result.direction = reflect( - V, H );
		result.pdf = D * G1 * VoH / ( NoV * 4.0 );
		result.value = evaluateBRDF( V, result.direction, N, material );
		return result;
	}

    // Continue with other BRDFs following the same pattern...
	float cumulativeSheen = cumulativeSpecular + weights.sheen;
	float cumulativeClearcoat = cumulativeSheen + weights.clearcoat;

	if( rand < cumulativeSheen ) {
        // sheen sampling
		H = ImportanceSampleGGX( N, material.sheenRoughness, xi );
		float NoH = max( dot( N, H ), 0.0 );
		float VoH = max( dot( V, H ), 0.0 );
		result.direction = reflect( - V, H );
		result.pdf = SheenDistribution( NoH, material.sheenRoughness ) * NoH / ( 4.0 * VoH );
	} else if( rand < cumulativeClearcoat ) {
        // clearcoat sampling
		float clearcoatRoughness = max( material.clearcoatRoughness, 0.089 );
		H = ImportanceSampleGGX( N, clearcoatRoughness, xi );
		float NoH = max( dot( N, H ), 0.0 );
		float VoH = max( dot( V, H ), 0.0 );
		float NoV = max( dot( N, V ), 0.001 );
		result.direction = reflect( - V, H );
		float D = DistributionGGX( NoH, clearcoatRoughness );
		float G1 = GeometrySchlickGGX( NoV, clearcoatRoughness );
		result.pdf = D * G1 * VoH / ( NoV * 4.0 );
	} else {
        // transmission sampling
		float eta = material.ior;
		bool entering = dot( V, N ) < 0.0;
		eta = entering ? 1.0 / eta : eta;

		if( material.dispersion > 0.0 ) {
			float randWL = RandomValue( rngState );
			float B = material.dispersion * 0.001;
			float dispersionOffset = B / ( randWL < 0.333 ? 0.4225 : ( randWL < 0.666 ? 0.2809 : 0.1936 ) );
			eta = entering ? 1.0 / ( eta + dispersionOffset ) : ( eta + dispersionOffset );
		}

		result.direction = refract( - V, entering ? N : - N, eta );
		result.pdf = 1.0;
	}

	result.pdf = max( result.pdf, MIN_PDF );
	result.value = evaluateBRDF( V, result.direction, N, material );
	return result;
}

// Russian Roulette with vectorized operations
bool handleRussianRoulette( int depth, vec3 rayColor, RayTracingMaterial material, uint seed ) {
    // Early exit for very dark paths
	float pathIntensity = max( max( rayColor.r, rayColor.g ), rayColor.b );
	if( pathIntensity < 0.01 && depth > 2 )
		return false;

	float materialIntensity = max( luminance( material.color.rgb ), material.metalness );
	int minBounces = int( mix( 3.0, 5.0, materialIntensity ) );

	float rrProb = depth < minBounces ? 1.0 : clamp( pathIntensity, 0.05, 1.0 );
	if( RandomValue( seed ) > rrProb )
		return false;

	rayColor *= 1.0 / rrProb;
	return true;
}

vec4 sampleBackgroundLighting( int bounceIndex, vec3 direction ) {

	if( bounceIndex == 0 && ! showBackground ) {
		return vec4( 0.0, 0.0, 0.0, 0.0 );
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
			radiance += reduceFireflies( envColor.rgb * throughput * ( bounceIndex == 0 ? 1.0 : environmentIntensity ), 1.0 );
			alpha *= envColor.a;
			// return vec4(envColor, 1.0);
			break;
		}

		RayTracingMaterial material = hitInfo.material;
		material.color = sampleAlbedoTexture( material, hitInfo.uv );

		// Handle material transparency
		TransparencyResult transparencyResult = handleMaterialTransparency( material, material.color, rngState );

		if( transparencyResult.continueRay ) {
			throughput *= transparencyResult.throughput;
			alpha *= transparencyResult.alpha;
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
			continue;
		}

		alpha *= transparencyResult.alpha;

		vec3 N = hitInfo.normal;

		// Calculate tangent space and perturb normal
		vec3 tangent = normalize( cross( N, vec3( 0.0, 1.0, 0.0 ) ) );
		vec3 bitangent = cross( N, tangent );
		N = perturbNormal( N, tangent, bitangent, hitInfo.uv, material );

		material.metalness = sampleMetalnessMap( material, hitInfo.uv );
		material.roughness = clamp( sampleRoughnessMap( material, hitInfo.uv ), MIN_ROUGHNESS, MAX_ROUGHNESS );
		material.sheenRoughness = clamp( material.sheenRoughness, MIN_ROUGHNESS, MAX_ROUGHNESS );

		// Handle transparent materials with transmission
		if( material.transmission > 0.0 ) {
			vec3 transmissionThroughput = sampleTransmissiveMaterial( ray, hitInfo, material, rngState );
			throughput *= transmissionThroughput;
			alpha *= ( 1.0 - material.transmission ) * material.color.a;
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
			continue;
		}

		vec2 randomSample = getRandomSample( gl_FragCoord.xy, rayIndex, bounceIndex, rngState, - 1 );

		vec3 V = - ray.direction; // View direction, negative means pointing towards camera

		BRDFSample brdfSample;
		// Handle clear coat
		if( material.clearcoat > 0.0 ) {
			vec3 L;
			float pdf;
			brdfSample.value = sampleClearcoat( ray, hitInfo, material, randomSample, L, pdf, rngState );
			brdfSample.direction = L;
			brdfSample.pdf = pdf;
		} else {
			brdfSample = sampleBRDF( V, N, material, randomSample, rngState );
		}

        // Add emissive contribution
		radiance += sampleEmissiveMap( material, hitInfo.uv ) * throughput * PI;

		// Indirect lighting using MIS
		IndirectLightingResult indirectResult = calculateIndirectLighting( V, N, material, brdfSample, rayIndex, bounceIndex, rngState );
		throughput *= reduceFireflies( indirectResult.throughput, 1.0 );

		// Direct lighting using MIS
		// Calculate direct lighting using Multiple Importance Sampling
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, brdfSample, rayIndex, bounceIndex, rngState, stats );
		radiance += reduceFireflies( directLight * throughput, 1.0 );
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
	ivec2 pixelCoord = ivec2( gl_FragCoord.xy );

	if( renderMode == 0 ) { // Regular rendering

		return true;

	} else if( renderMode == 1 ) { // Tiled rendering

		ivec2 tileCount = ivec2( resolution ) / ( ivec2( resolution ) / tiles );
		ivec2 tileCoord = pixelCoord / ( ivec2( resolution ) / tiles );
		int totalTiles = tileCount.x * tileCount.y;
		int currentTile = int( frame ) % totalTiles;

		int tileIndex = tileCoord.y * tileCount.x + tileCoord.x;
		return tileIndex == currentTile;

	}

	return true; // Default to rendering all pixels
}

#include debugger.fs

int getRequiredSamples( int pixelIndex ) {
	vec2 texCoord = gl_FragCoord.xy / resolution;
	return int( texture2D( adaptiveSamplingTexture, texCoord ).r );
}

void main( ) {

	vec2 pixelSize = 1.0 / resolution;
	vec2 screenPosition = ( gl_FragCoord.xy / resolution ) * 2.0 - 1.0;

	Pixel pixel;
	pixel.color = vec4( 0.0 );
	pixel.variance = 0.0;
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
				pixel.color = texture2D( accumulatedFrameTexture, gl_FragCoord.xy / resolution );
				gl_FragColor = vec4( pixel.color.rgb, 1.0 );
				return;
			}
		}

		for( int rayIndex = 0; rayIndex < samplesCount; rayIndex ++ ) {

			vec4 _sample = vec4( 0.0 );
			vec2 jitterSample = getRandomSample( gl_FragCoord.xy, rayIndex, 0, seed, 5 );

			if( visMode == 5 ) {
				gl_FragColor = vec4( jitterSample, 1.0, 1.0 );
				return;
			}

			vec2 jitter = ( jitterSample - 0.5 ) * 2.0 * pixelSize;
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
		pixel.color = texture2D( previousFrameTexture, gl_FragCoord.xy / resolution );
	}

	// pixel.color.rgb = applyDithering( pixel.color.rgb, gl_FragCoord.xy / resolution, 0.5 ); // 0.5 is the dithering amount

	gl_FragColor = vec4( pixel.color.rgb, 1.0 );
}