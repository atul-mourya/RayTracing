precision highp float;

// Uniform declarations
uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform bool showBackground;
uniform int checkeredFrameInterval;
uniform sampler2D previousFrameTexture;
uniform int renderMode; // 0: Regular, 1: Checkered, 2: Tiled
uniform int tiles; // number of tiles
uniform int visMode;
uniform float debugVisScale;
uniform bool useAdaptiveSampling;
uniform int adaptiveSamplingMin;
uniform int adaptiveSamplingMax;
uniform float varianceThreshold;

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
#include lights.fs

// Global variables
ivec2 stats; // num triangle tests, num bounding box tests
float pdf;

vec3 sampleBRDF( vec3 V, vec3 N, RayTracingMaterial material, vec2 xi, out vec3 L, out float pdf, inout uint rngState ) {
	
	float diffuseRatio = 0.5 * ( 1.0 - material.metalness );

	if( RandomValue( rngState ) < diffuseRatio ) {
		// Sample diffuse BRDF
		L = ImportanceSampleCosine( N, xi );
		pdf = max( dot( N, L ), 0.0 ) / PI;
	} else {
		// Sample specular BRDF
		vec3 H = ImportanceSampleGGX( N, material.roughness, xi );
		L = reflect( - V, H );
		float NoH = max( dot( N, H ), 0.0 );
		float VoH = max( dot( V, H ), 0.0 );
		pdf = DistributionGGX( N, H, material.roughness ) * NoH / ( 4.0 * VoH );
	}

	// Ensure the PDF is never zero
	pdf = max( pdf, 0.001 );

	// Evaluate BRDF
	return evaluateBRDF( V, L, N, material );
}

vec3 sampleTransmissiveMaterial( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, uint rngState ) {

	bool entering = dot( ray.direction, hitInfo.normal ) < 0.0;
	float n1 = entering ? 1.0 : material.ior;
	float n2 = entering ? material.ior : 1.0;
	vec3 normal = entering ? hitInfo.normal : - hitInfo.normal;

	vec3 reflectDir = reflect( ray.direction, normal );
	vec3 refractDir = refract( ray.direction, normal, n1 / n2 );

	float cosTheta = abs( dot( - ray.direction, normal ) );
	float fresnel = fresnelSchlick( cosTheta, 0.04 );

	if( length( refractDir ) < 0.001 || RandomValue( rngState ) < fresnel ) {
		ray.direction = reflectDir;
		return material.color.rgb;
	} else {
		ray.direction = refractDir;
		if( entering ) {
			vec3 absorption = ( vec3( 1.0 ) - material.color.rgb ) * material.thickness * 0.5;
			return exp( - absorption * hitInfo.dst );
		}
		return mix( vec3( 1.0 ), material.color.rgb, 0.5 );
	}
	
}

vec3 sampleClearCoat( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec4 randomSample, out vec3 L, out float pdf, inout uint rngState ) {
	vec3 N = hitInfo.normal;
	vec3 V = - ray.direction;

	// Sample microfacet normal for clear coat layer
	vec2 Xi = randomSample.xy;
	vec3 H = ImportanceSampleGGX( N, material.clearcoatRoughness, Xi );
	L = reflect( - V, H );

	float NoL = max( dot( N, L ), 0.0 );
	float NoH = max( dot( N, H ), 0.0 );
	float NoV = max( dot( N, V ), 0.0 );
	float VoH = max( dot( V, H ), 0.0 );

	// Specular BRDF for clear coat
	float D = DistributionGGX( N, H, material.clearcoatRoughness );
	float G = GeometrySmith( N, V, L, material.clearcoatRoughness );
	float F = fresnelSchlick( VoH, 0.04 ); // Fresnel term for clear coat (approximate with 0.04 as F0)
	vec3 clearcoatBRDF = vec3( D * G * F ) / ( 4.0 * NoV * NoL + 0.001 );

	pdf = ( D * NoH ) / ( 4.0 * VoH );

	// Blend with base layer BRDF
	vec3 baseBRDF;
	float basePDF;
	baseBRDF = sampleBRDF( V, N, material, randomSample.zw, L, basePDF, rngState );

	// Compute final BRDF and PDF
	vec3 finalBRDF = mix( baseBRDF, clearcoatBRDF, material.clearcoat * F );
	pdf = mix( basePDF, pdf, material.clearcoat * F );

	return finalBRDF;
}

bool handleRussianRoulette( uint depth, vec3 rayColor, float randomValue ) {
	uint minBounces = 5u;
	float depthProb = float( depth < minBounces );
	float rrProb = luminance( rayColor );
	rrProb = sqrt( rrProb );
	rrProb = max( rrProb, depthProb );
	rrProb = min( rrProb, 1.0 );

	if( randomValue > rrProb ) {
		return false;
	}

	rayColor *= min( 1.0 / rrProb, 20.0 );
	return true;
}

vec3 sampleBackgroundLighting(int bounceIndex, vec3 direction) {

	if (bounceIndex == 0 && !showBackground) {
        return vec3(0.0);
    }
    
    return sampleEnvironment(direction, bounceIndex);

}

vec4 Trace( Ray ray, inout uint rngState, int sampleIndex, int pixelIndex ) {
	vec3 radiance = vec3( 0.0 );
	vec3 throughput = vec3( 1.0 );
	uint depth = 0u;
	float alpha = 1.0;

	for( int i = 0; i <= maxBounceCount; i ++ ) {
		HitInfo hitInfo = traverseBVH( ray, stats );
		depth ++;

		if( ! hitInfo.didHit ) {
			// Environment lighting
			vec3 envColor = sampleBackgroundLighting(i, ray.direction);
			radiance += reduceFireflies( envColor * throughput * (i == 0 ? 1.0 : environmentIntensity), 5.0 );

			// return vec4(envColor, 1.0);
			break;
		}

		RayTracingMaterial material = hitInfo.material;
		material.color = sampleAlbedoTexture( material, hitInfo.uv );

		// Handle opacity
		if( material.opacity < 1.0) {
			if( RandomValue(rngState) < material.opacity ) {
				throughput *= material.color.rgb;
				alpha *= material.opacity;
				ray.origin = hitInfo.hitPoint + ray.direction * 0.001;

				continue;
			}
		}

		// Handle alpha blending
		float surfaceAlpha = material.color.a;
		if( surfaceAlpha < 1.0 ) {
			radiance = mix( radiance, material.color.rgb * throughput, surfaceAlpha );
			throughput *= ( 1.0 - surfaceAlpha );
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

		// Handle transparent materials
		if( material.transmission > 0.0 ) {
			throughput *= sampleTransmissiveMaterial( ray, hitInfo, material, rngState );
			alpha *= ( 1.0 - material.transmission ) * material.color.a;
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
			continue;
		}

		vec4 randomSample = getRandomSample4( gl_FragCoord.xy, sampleIndex, i, rngState );

		vec3 V = - ray.direction;
		vec3 N = hitInfo.normal;
		vec3 L; // Light direction
		vec3 brdfValue;

		// Handle clear coat
		if( material.clearcoat > 0.0 ) {
			brdfValue = sampleClearCoat( ray, hitInfo, material, randomSample, L, pdf, rngState );
		} else {
			brdfValue = sampleBRDF( V, N, material, randomSample.xy, L, pdf, rngState );
		}
		// return vec4(brdfValue, 1.0);


		// Indirect lighting using MIS
		vec2 indirectSample = getRandomSample( gl_FragCoord.xy, sampleIndex, i + 1, rngState, -1 );
		vec3 cosSampleDir = cosineWeightedSample( N, indirectSample );
		float cosPDF = cosineWeightedPDF( max( dot( N, cosSampleDir ), 0.0 ) );
		vec3 cosBRDF = evaluateBRDF( V, cosSampleDir, N, material );

		float brdfPDF = max( pdf, 0.001 );  // Ensure BRDF PDF is never zero

		float cosWeight = powerHeuristic( cosPDF, brdfPDF );
		float brdfWeight = powerHeuristic( brdfPDF, cosPDF );

		// Choose between cosine and BRDF sampling
		vec3 chosenDir;
		float chosenPDF;
		vec3 chosenBRDF;
		float chosenWeight;

		if( RandomValue( rngState ) < 0.5 ) {
			chosenDir = cosSampleDir;
			chosenPDF = cosPDF;
			chosenBRDF = cosBRDF;
			chosenWeight = cosWeight;
		} else {
			chosenDir = L;
			chosenPDF = brdfPDF;
			chosenBRDF = brdfValue;
			chosenWeight = brdfWeight;
		}

		// Update ray for next bounce
		ray.origin = hitInfo.hitPoint + N * 0.001;
		ray.direction = chosenDir;

		// Update throughput and alpha
		float NoL = max( dot( N, chosenDir ), 0.0 );
		vec3 f = chosenBRDF * NoL * chosenWeight / max( chosenPDF, 0.001 );
		throughput *= clamp( f, vec3( 0.0 ), vec3( 1.0 ) );  // Ensure energy conservation
		alpha *= material.color.a;

		// Firefly reduction
		throughput = reduceFireflies( throughput, 5.0 );

		// Direct lighting using MIS
		// Calculate direct lighting using Multiple Importance Sampling
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, L, brdfValue, pdf, rngState, stats );
		// radiance += mix( vec3( 0.0 ), directLight, material.color.a ) * throughput * 3.14;
		radiance += reduceFireflies( directLight * throughput, 5.0 );
		// return vec4(directLight, 1.0);

		// Calculate emitted light
		vec3 emittedLight = sampleEmissiveMap( material, hitInfo.uv );
		radiance += emittedLight * throughput * PI * 10.0; // added PI * 10.0 to compensate for low intensity

		// Russian roulette path termination
		if( ! handleRussianRoulette( depth, throughput, randomSample.z ) ) {
			break;
		}
	}
	return vec4( max( radiance, vec3( 0.0 ) ), alpha );  // Ensure non-negative output
}

vec4 TraceDebugMode( vec3 rayOrigin, vec3 rayDir ) {
	Ray ray;
	ray.origin = rayOrigin;
	ray.direction = rayDir;
	HitInfo hitInfo = traverseBVH( ray, stats );
	
	switch( visMode ) {
		case 1: {
			// Triangle test count vis
			float triVis = float( stats.x ) / debugVisScale;
			return triVis < 1.0 ? vec4( vec3( triVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
		}
		case 2: {
			// Box test count vis
			float boxVis = float( stats.y ) / debugVisScale;
			return boxVis < 1.0 ? vec4( vec3( boxVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
		}
		case 3: {
			// Distance
			return vec4( vec3( length( rayOrigin - hitInfo.hitPoint ) / debugVisScale ), 1.0 );
		}
		case 4: {
			// Normal
			if( ! hitInfo.didHit )
				return vec4( 0.0, 0.0, 0.0, 1.0 );
			return vec4( vec3( hitInfo.normal * 0.5 + 0.5 ), 1.0 );
		}
		default: {
			// Invalid test mode
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
	}
}

bool shouldRenderPixel( ) {
	ivec2 pixelCoord = ivec2( gl_FragCoord.xy );

	if( renderMode == 0 ) { // Regular rendering

		return true;

	} else if( renderMode == 1 ) { // Checkered rendering

		int frameNumber = int(frame);
        int n = checkeredFrameInterval; // n x n blocks, n frame cycle

        // Calculate which block this pixel belongs to
        int blockX = pixelCoord.x / n;
        int blockY = pixelCoord.y / n;

        // Calculate position within the block
        int pixelXInBlock = pixelCoord.x % n;
        int pixelYInBlock = pixelCoord.y % n;

        // Determine which frame in the cycle we're on
        int cycleFrame = frameNumber % (n * n);

        // Calculate the rendering order within the block
        int renderOrder = (pixelYInBlock * n + pixelXInBlock);

        // Determine if this pixel should be rendered in this frame
        bool shouldRender = (renderOrder == cycleFrame);

        // Alternate the pattern for odd blocks
        if ((blockX + blockY) % 2 == 1) {
            shouldRender = !shouldRender;
        }

        return shouldRender;

	} else if( renderMode == 2 ) { // Tiled rendering

		ivec2 tileCount = ivec2( resolution ) / ( ivec2( resolution ) / tiles );
		ivec2 tileCoord = pixelCoord / ( ivec2( resolution ) / tiles );
		int totalTiles = tileCount.x * tileCount.y;
		int currentTile = int( frame ) % totalTiles;

		int tileIndex = tileCoord.y * tileCount.x + tileCoord.x;
		return tileIndex == currentTile;

	}

	return true; // Default to rendering all pixels
}

void main( ) {

	vec2 pixelSize = 1.0 / resolution;
	vec2 screenPosition = ( gl_FragCoord.xy / resolution ) * 2.0 - 1.0;

	Pixel pixel;
	pixel.color = vec4( 0.0 );
	pixel.variance = 0.0;
	pixel.samples = 0;

	vec4 squaredMean = vec4( 0.0 );
	uint seed = uint(gl_FragCoord.x) + uint(gl_FragCoord.y) * uint(resolution.x) + frame * uint(resolution.x) * uint(resolution.y);
	int pixelIndex = int( gl_FragCoord.y ) * int( resolution.x ) + int( gl_FragCoord.x );

	bool shouldRender = shouldRenderPixel( );

	if( shouldRender ) {
		int samplesCount = useAdaptiveSampling ? adaptiveSamplingMax : numRaysPerPixel;

		for( int rayIndex = 0; rayIndex < samplesCount; rayIndex ++ ) {
			vec4 _sample = vec4( 0.0 );

			vec2 jitterSample = getRandomSample( gl_FragCoord.xy, rayIndex, 0, seed, -1 );

			if( visMode == 5 ) {
				// to be refactored
				gl_FragColor = vec4( jitterSample, 0.0, 1.0 );
				// float grayscale = length( jitterSample ) * 0.7071067811865476; // 0.7071... is 1/sqrt(2)
				// gl_FragColor = vec4( vec3( grayscale ), 1.0 );
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

			if( useAdaptiveSampling ) {
				squaredMean += _sample * _sample;

				// Calculate variance after minimum samples
				if( pixel.samples >= adaptiveSamplingMin ) {
					pixel.variance = calculateVariance( pixel.color / float( pixel.samples ), squaredMean / float( pixel.samples ), pixel.samples );

					// Check if we've reached the desired quality
					if( pixel.variance < varianceThreshold ) {
						break;
					}
				}
			}
		}

		pixel.color /= float( pixel.samples );

	} else {
		// For pixels that are not rendered in this frame, use the color from the previous frame
		pixel.color = texture2D( previousFrameTexture, gl_FragCoord.xy / resolution );
	}

	// pixel.color.rgb = toneMapACESFilmic(pixel.color.rgb);
	// pixel.color.rgb = gammaCorrection(pixel.color.rgb);
	pixel.color.rgb = applyDithering(pixel.color.rgb, gl_FragCoord.xy / resolution, 0.5); // 0.5 is the dithering amount



	gl_FragColor = vec4( pixel.color.rgb, 1.0 );
}