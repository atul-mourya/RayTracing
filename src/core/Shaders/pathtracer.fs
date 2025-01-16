precision highp float;

// Uniform declarations
uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform bool showBackground;
uniform sampler2D previousFrameTexture;
uniform int renderMode; // 0: Regular, 1: Tiled
uniform int tiles; // number of tiles
uniform int visMode;
uniform float debugVisScale;
uniform bool useAdaptiveSampling;

// Include statements
#include common.fs
#include struct.fs
#include random.fs
#include rayintersection.fs
#include environment.fs
#include bvhtraverse.fs
#include texture_sampling.fs
#include fresnel.fs
#include brdfs.fs
#include transmission.fs
#include lights.fs

// Global variables
ivec2 stats; // num triangle tests, num bounding box tests
float pdf;

BRDFSample sampleBRDF( vec3 V, vec3 N, RayTracingMaterial material, vec2 xi, inout uint rngState ) {

	BRDFWeights weights = calculateBRDFWeights( material );
	BRDFSample result;

	float rand = xi.x;
	vec3 H;

    // Cumulative probabilities
	float cumulativeDiffuse = weights.diffuse;
	float cumulativeSpecular = cumulativeDiffuse + weights.specular;
	float cumulativeSheen = cumulativeSpecular + weights.sheen;
	float cumulativeClearcoat = cumulativeSheen + weights.clearcoat;
    // transmission is last: cumulativeClearcoat + weights.transmission should equal 1.0

	if( rand < cumulativeDiffuse ) {

        // Sample diffuse BRDF
		result.direction = ImportanceSampleCosine( N, xi );
		result.pdf = max( dot( N, result.direction ), 0.0 ) / PI;

	} else if( rand < cumulativeSpecular ) {

		// Transform view vector to local space
		mat3 TBN = constructTBN( N );
		vec3 localV = transpose( TBN ) * V;

		// Sample VNDF in local space
		vec3 localH = sampleGGXVNDF( localV, material.roughness, xi );

		// Transform half vector back to world space
		vec3 H = TBN * localH;

		// Calculate reflection direction and PDF
		float NoV = max( dot( N, V ), 0.001 );
		float NoH = max( dot( N, H ), 0.001 );
		float VoH = max( dot( V, H ), 0.001 );

		float D = DistributionGGX( N, H, material.roughness );
		float G1 = GeometrySchlickGGX( NoV, material.roughness );

		result.direction = reflect( - V, H );
		result.pdf = D * G1 * VoH / ( NoV * 4.0 );

	} else if( rand < cumulativeSheen ) {

        // Sample sheen BRDF
		H = ImportanceSampleGGX( N, material.sheenRoughness, xi );
		float NoH = max( dot( N, H ), 0.0 );
		float VoH = max( dot( V, H ), 0.0 );

		result.direction = reflect( - V, H );
		result.pdf = SheenDistribution( N, H, material.sheenRoughness ) * NoH / ( 4.0 * VoH );

	} else if( rand < cumulativeClearcoat ) {

        // Sample clearcoat
		float clearcoatRoughness = max( material.clearcoatRoughness, 0.089 );
		H = ImportanceSampleGGX( N, clearcoatRoughness, xi );
		float NoH = max( dot( N, H ), 0.0 );
		float VoH = max( dot( V, H ), 0.0 );

		result.direction = reflect( - V, H );
		float D = DistributionGGX( N, H, clearcoatRoughness );
		float G1 = GeometrySchlickGGX( max( dot( N, V ), 0.001 ), clearcoatRoughness );
		result.pdf = D * G1 * VoH / ( max( dot( N, V ), 0.001 ) * 4.0 );

	} else {

        // Sample transmission
		float ior = material.ior;
		bool entering = dot( V, N ) < 0.0;
		float eta = entering ? 1.0 / ior : ior;

        // For dispersion, randomly select wavelength
		if( material.dispersion > 0.0 ) {
			float randWL = RandomValue( rngState );
			float B = material.dispersion * 0.001;
			if( randWL < 0.333 ) {
				eta = entering ? 1.0 / ( ior + B / 0.4225 ) : ( ior + B / 0.4225 ); // Red
			} else if( randWL < 0.666 ) {
				eta = entering ? 1.0 / ( ior + B / 0.2809 ) : ( ior + B / 0.2809 ); // Green
			} else {
				eta = entering ? 1.0 / ( ior + B / 0.1936 ) : ( ior + B / 0.1936 ); // Blue
			}
		}

		result.direction = refract( - V, entering ? N : - N, eta );
        // Simplified PDF for transmission
		result.pdf = 1.0; // This is a simplification, could be improved

	}

    // Ensure the PDF is never zero
	result.pdf = max( result.pdf, 0.001 );
	result.value = evaluateBRDF( V, result.direction, N, material );

	return result;
}

// Helper function to calculate energy conservation for layered materials
float calculateLayerAttenuation( float clearcoat, float VoH ) {
    // Fresnel term for clearcoat layer (using f0 = 0.04 for dielectric)
	float F = fresnelSchlick( VoH, 0.04 );
    // Attenuate base layer by clearcoat layer's reflection
	return ( 1.0 - clearcoat * F );
}

// Evaluate both clearcoat and base layer BRDFs
vec3 evaluateLayeredBRDF( vec3 V, vec3 L, vec3 N, RayTracingMaterial material ) {
	vec3 H = normalize( V + L );
	float NoL = max( dot( N, L ), 0.001 );
	float NoV = max( dot( N, V ), 0.001 );
	float NoH = max( dot( N, H ), 0.001 );
	float VoH = max( dot( V, H ), 0.001 );

    // Base F0 calculation with specular parameters
	vec3 baseF0 = vec3( 0.04 );
	vec3 F0 = mix( baseF0 * material.specularColor, material.color.rgb, material.metalness );
	F0 *= material.specularIntensity;

	float D = DistributionGGX( N, H, material.roughness );
	float G = GeometrySmith( N, V, L, material.roughness );
	vec3 F = fresnelSchlick( VoH, F0 );
	vec3 baseBRDF = ( D * G * F ) / ( 4.0 * NoV * NoL );

    // Add diffuse component for non-metallic surfaces
	vec3 diffuse = material.color.rgb * ( 1.0 - material.metalness ) / PI;
	vec3 baseLayer = diffuse + baseBRDF;

    // Clearcoat layer (using constant IOR of 1.5 -> F0 = 0.04)
	float clearcoatRoughness = max( material.clearcoatRoughness, 0.089 );
	float clearcoatD = DistributionGGX( N, H, clearcoatRoughness );
	float clearcoatG = GeometrySmith( N, V, L, clearcoatRoughness );
	float clearcoatF = fresnelSchlick( VoH, 0.04 );
	float clearcoatBRDF = ( clearcoatD * clearcoatG * clearcoatF ) / ( 4.0 * NoV * NoL );

    // Energy conservation
	float attenuation = calculateLayerAttenuation( material.clearcoat, VoH );

	return baseLayer * attenuation + vec3( clearcoatBRDF ) * material.clearcoat;
}

// Improved clearcoat sampling function
vec3 sampleClearcoat( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec2 randomSample, out vec3 L, out float pdf, inout uint rngState ) {
	vec3 N = hitInfo.normal;
	vec3 V = - ray.direction;

    // Clamp clearcoat roughness to avoid artifacts
	float clearcoatRoughness = max( material.clearcoatRoughness, 0.089 );
	float baseRoughness = max( material.roughness, 0.089 );

    // Calculate sampling weights based on material properties
	float specularWeight = ( 1.0 - baseRoughness ) * ( 0.5 + 0.5 * material.metalness );
	float clearcoatWeight = material.clearcoat * ( 1.0 - clearcoatRoughness );
	float diffuseWeight = ( 1.0 - specularWeight ) * ( 1.0 - material.metalness );

    // Normalize weights
	float total = specularWeight + clearcoatWeight + diffuseWeight;
	specularWeight /= total;
	clearcoatWeight /= total;
	diffuseWeight /= total;

    // Choose which layer to sample
	float rand = RandomValue( rngState );
	vec3 H;

	if( rand < clearcoatWeight ) {
        // Sample clearcoat layer
		H = ImportanceSampleGGX( N, clearcoatRoughness, randomSample );
		L = reflect( - V, H );
	} else if( rand < clearcoatWeight + specularWeight ) {
        // Sample base specular
		H = ImportanceSampleGGX( N, baseRoughness, randomSample );
		L = reflect( - V, H );
	} else {
        // Sample diffuse
		L = ImportanceSampleCosine( N, randomSample );
		H = normalize( V + L );
	}

    // Calculate PDFs for both layers
	float NoV = max( dot( N, V ), 0.001 );
	float NoL = max( dot( N, L ), 0.001 );
	float NoH = max( dot( N, H ), 0.001 );
	float VoH = max( dot( V, H ), 0.001 );

    // Calculate individual PDFs
	float clearcoatPDF = DistributionGGX( N, H, clearcoatRoughness ) * NoH / ( 4.0 * VoH ) * clearcoatWeight;
	float specularPDF = DistributionGGX( N, H, baseRoughness ) * NoH / ( 4.0 * VoH ) * specularWeight;
	float diffusePDF = NoL / PI * diffuseWeight;

    // Combined PDF using MIS
	pdf = clearcoatPDF + specularPDF + diffusePDF;
	pdf = max( pdf, 0.001 ); // Ensure PDF is never zero

    // Evaluate complete BRDF
	return evaluateLayeredBRDF( V, L, N, material );
}

bool handleRussianRoulette( uint depth, vec3 rayColor, RayTracingMaterial material, uint seed ) {
    // OPTIMIZATION: Early exit for very dark paths
	float pathIntensity = max( max( rayColor.r, rayColor.g ), rayColor.b );
	if( pathIntensity < 0.01 && depth > 2u )
		return false;

	uint minBounces = uint( mix( 3.0, 5.0, max( luminance( material.color.rgb ), material.metalness ) ) );

	float rrProb = clamp( pathIntensity, 0.05, 1.0 );
	if( depth < minBounces )
		rrProb = 1.0;

	float randomValue = RandomValue( seed );
	if( randomValue > rrProb ) {
		return false;
	}

	rayColor *= 1.0 / rrProb;
	return true;
}

vec3 sampleBackgroundLighting( int bounceIndex, vec3 direction ) {

	if( bounceIndex == 0 && ! showBackground ) {
		return vec3( 0.0 );
	}

	return sampleEnvironment( direction, bounceIndex );

}

vec4 Trace( Ray ray, inout uint rngState, int sampleIndex, int pixelIndex ) {
	vec3 radiance = vec3( 0.0 );
	vec3 throughput = vec3( 1.0 );
	uint depth = 0u;
	float alpha = 1.0;

	// Store initial ray for helper visualization
	Ray initialRay = ray;

	for( int i = 0; i <= maxBounceCount; i ++ ) {
		HitInfo hitInfo = traverseBVH( ray, stats );
		depth ++;

		if( ! hitInfo.didHit ) {
			// Environment lighting
			vec3 envColor = sampleBackgroundLighting( i, ray.direction );
			radiance += reduceFireflies( envColor * throughput * ( i == 0 ? 1.0 : environmentIntensity ), 1.0 );

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

		// Handle transparent materials with transmission
		if( material.transmission > 0.0 ) {
			vec3 transmissionThroughput = sampleTransmissiveMaterial( ray, hitInfo, material, rngState );
			throughput *= transmissionThroughput;
			alpha *= ( 1.0 - material.transmission ) * material.color.a;
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
			continue;
		}

		// Calculate tangent space and perturb normal
		vec3 tangent = normalize( cross( hitInfo.normal, vec3( 0.0, 1.0, 0.0 ) ) );
		vec3 bitangent = normalize( cross( hitInfo.normal, tangent ) );
		hitInfo.normal = perturbNormal( hitInfo.normal, tangent, bitangent, hitInfo.uv, material );

		material.metalness = sampleMetalnessMap( material, hitInfo.uv );
		material.roughness = sampleRoughnessMap( material, hitInfo.uv );
		material.roughness = clamp( material.roughness, 0.05, 1.0 );
		material.sheenRoughness = clamp( material.sheenRoughness, 0.05, 1.0 );

		vec2 randomSample = getRandomSample( gl_FragCoord.xy, sampleIndex, i, rngState, - 1 );

		vec3 V = - ray.direction; // View direction, negative means pointing towards camera
		vec3 N = hitInfo.normal; // Normal at hit point

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

		// Calculate emitted light
		vec3 emittedLight = sampleEmissiveMap( material, hitInfo.uv );
		radiance += emittedLight * throughput * PI;

		// Indirect lighting using MIS
		IndirectLightingResult indirectResult = calculateIndirectLighting( V, N, material, brdfSample, sampleIndex, i, rngState );
		throughput *= reduceFireflies( indirectResult.throughput, 1.0 );

		// Direct lighting using MIS
		// Calculate direct lighting using Multiple Importance Sampling
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, brdfSample, sampleIndex, i, rngState, stats );
		radiance += reduceFireflies( directLight * throughput, 1.0 );
		// return vec4(directLight, 1.0);

		// Update ray for next bounce
		ray.origin = hitInfo.hitPoint + N * 0.001;
		ray.direction = brdfSample.direction;

		// Russian roulette path termination
		if( ! handleRussianRoulette( depth, throughput, material, rngState ) ) {
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
#include adaptiveSampling.fs

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
		int samplesCount = useAdaptiveSampling ? adaptiveSamplingMax : numRaysPerPixel;

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
			} else if( useAdaptiveSampling ) {
				_sample = adaptivePathTrace( ray, seed, pixelIndex );
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

	gl_FragColor = vec4( pixel.color.rgb, pixel.color.a );
}