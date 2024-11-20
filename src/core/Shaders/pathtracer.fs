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

	float specularWeight = ( 1.0 - material.roughness ) * ( 0.5 + 0.5 * material.metalness );
	float diffuseWeight = ( 1.0 - specularWeight ) * ( 1.0 - material.metalness );

    // Normalize weights
	float total = specularWeight + diffuseWeight;
	diffuseWeight /= total;

	// decide between diffuse and specular based on material properties
	if( RandomValue( rngState ) < diffuseWeight ) {
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

    // Calculate Fresnel term using Schlick's approximation
	float cosTheta = abs( dot( - ray.direction, normal ) );
	float F0 = pow( ( n1 - n2 ) / ( n1 + n2 ), 2.0 ); // Fresnel reflectance at normal incidence
	float fresnel = fresnelSchlick( cosTheta, F0 );

    // Energy conservation factor
	float energyFactor = ( n2 * n2 ) / ( n1 * n1 );

	if( length( refractDir ) < 0.001 || RandomValue( rngState ) < fresnel ) {
        // Handle total internal reflection or fresnel reflection
		ray.direction = reflectDir;
		return material.color.rgb;
	} else {
		ray.direction = refractDir;
		if( entering ) {
            // Handle absorption when entering the medium
			vec3 absorption = ( vec3( 1.0 ) - material.color.rgb ) * material.thickness * 0.5;
			return exp( - absorption * hitInfo.dst ) * energyFactor;
		} else {
            // Handle exit from medium with color contribution
			return mix( vec3( 1.0 ), material.color.rgb, 0.5 ) * energyFactor;
		}
	}
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

    // Clearcoat layer
	float clearcoatD = DistributionGGX( N, H, material.clearcoatRoughness );
	float clearcoatG = GeometrySmith( N, V, L, material.clearcoatRoughness );
	float clearcoatF = fresnelSchlick( VoH, 0.04 );
	vec3 clearcoatBRDF = vec3( clearcoatD * clearcoatG * clearcoatF ) / ( 4.0 * NoV * NoL );

    // Calculate attenuation for base layer
	float baseAttenuation = calculateLayerAttenuation( material.clearcoat, VoH );

    // Base layer (using existing BRDF evaluation)
	vec3 baseBRDF = evaluateBRDF( V, L, N, material );

    // Combine layers
	return clearcoatBRDF * material.clearcoat + baseBRDF * baseAttenuation;
}

// Improved clearcoat sampling function
vec3 sampleClearcoat( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec4 randomSample, out vec3 L, out float pdf, inout uint rngState ) {
	vec3 N = hitInfo.normal;
	vec3 V = - ray.direction;

    // Choose between sampling clearcoat or base layer
	float clearcoatProb = material.clearcoat * 0.2; // Adjust weight based on clearcoat strength
	bool sampleClearcoat = RandomValue( rngState ) < clearcoatProb;

	vec3 H;
	if( sampleClearcoat ) {
        // Sample clearcoat microfacet normal
		H = ImportanceSampleGGX( N, material.clearcoatRoughness, randomSample.xy );
	} else {
        // Sample base layer
		if( material.metalness > 0.0 ) {
			H = ImportanceSampleGGX( N, material.roughness, randomSample.xy );
		} else {
            // For dielectric materials, use cosine weighted sampling
			H = ImportanceSampleCosine( N, randomSample.xy );
		}
	}

    // Calculate reflection direction
	L = reflect( - V, H );

    // Calculate PDFs
	float NoV = max( dot( N, V ), 0.001 );
	float NoL = max( dot( N, L ), 0.001 );
	float NoH = max( dot( N, H ), 0.001 );
	float VoH = max( dot( V, H ), 0.001 );

	float clearcoatPDF = 0.0;
	float basePDF = 0.0;

    // Calculate clearcoat PDF
	if( material.clearcoat > 0.0 ) {
		float D = DistributionGGX( N, H, material.clearcoatRoughness );
		clearcoatPDF = ( D * NoH ) / ( 4.0 * VoH ) * clearcoatProb;
	}

    // Calculate base layer PDF
	if( material.metalness > 0.0 ) {
		float D = DistributionGGX( N, H, material.roughness );
		basePDF = ( D * NoH ) / ( 4.0 * VoH ) * ( 1.0 - clearcoatProb );
	} else {
		basePDF = NoL / PI * ( 1.0 - clearcoatProb );
	}

    // Combined PDF using MIS
	pdf = clearcoatPDF + basePDF;
	pdf = max( pdf, 0.001 ); // Ensure PDF is never zero

    // Evaluate full BRDF
	return evaluateLayeredBRDF( V, L, N, material );
}

bool handleRussianRoulette( uint depth, vec3 rayColor, float randomValue, RayTracingMaterial material ) {

	uint minBounces = uint( mix( 3.0, 5.0, max( luminance( material.color.rgb ), material.metalness ) ) );
	float importanceValue = max( luminance( rayColor ), max( material.metalness, material.transmission ) );
	float rrProb = mix( importanceValue, 1.0, float( depth < minBounces ) );
	float depthProb = float( depth < minBounces );
	rrProb = sqrt( rrProb );
	rrProb = max( rrProb, depthProb );
	rrProb = min( rrProb, 1.0 );

	if( randomValue > rrProb ) {
		return false;
	}

	rayColor *= min( 1.0 / rrProb, 20.0 );
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

	for( int i = 0; i <= maxBounceCount; i ++ ) {
		HitInfo hitInfo = traverseBVH( ray, stats );
		depth ++;

		if( ! hitInfo.didHit ) {
			// Environment lighting
			vec3 envColor = sampleBackgroundLighting( i, ray.direction );
			radiance += reduceFireflies( envColor * throughput * ( i == 0 ? 1.0 : environmentIntensity ), 5.0 );

			// return vec4(envColor, 1.0);
			break;
		}

		RayTracingMaterial material = hitInfo.material;
		material.color = sampleAlbedoTexture( material, hitInfo.uv );

		// Handle opacity
		if( material.opacity < 1.0 ) {
			if( RandomValue( rngState ) < material.opacity ) {
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
			brdfValue = sampleClearcoat( ray, hitInfo, material, randomSample, L, pdf, rngState );
		} else {
			brdfValue = sampleBRDF( V, N, material, randomSample.xy, L, pdf, rngState );
		}
		// return vec4(brdfValue, 1.0);

		// Indirect lighting using MIS
		IndirectLightingResult indirectResult = calculateIndirectLightingMIS( V, N, material, brdfValue, pdf, L, sampleIndex, i, rngState );
		// Update throughput
		// throughput *= indirectResult.throughput;
		throughput *= reduceFireflies( indirectResult.throughput, 5.0 );

		// Update ray for next bounce
		ray.origin = hitInfo.hitPoint + N * 0.001;
		ray.direction = indirectResult.direction;

		// Direct lighting using MIS
		// Calculate direct lighting using Multiple Importance Sampling
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, L, brdfValue, pdf, rngState, stats );
		// radiance += mix( vec3( 0.0 ), directLight, material.color.a ) * throughput * 3.14;
		radiance += reduceFireflies( directLight * throughput, 5.0 );
		// return vec4(directLight, 1.0);

		// Calculate emitted light
		vec3 emittedLight = sampleEmissiveMap( material, hitInfo.uv );
		radiance += emittedLight * throughput * PI * 10.0; // added PI * 10.0 to compensate for low intensity

		alpha *= material.color.a;

		// Russian roulette path termination
		if( ! handleRussianRoulette( depth, throughput, randomSample.z, material ) ) {
			break;
		}
	}
	return vec4( max( radiance, vec3( 0.0 ) ), alpha );  // Ensure non-negative output
}

bool shouldRenderPixel( ) {
	ivec2 pixelCoord = ivec2( gl_FragCoord.xy );

	if( renderMode == 0 ) { // Regular rendering

		return true;

	} else if( renderMode == 1 ) { // Checkered rendering

		int frameNumber = int( frame );
		int n = checkeredFrameInterval; // n x n blocks, n frame cycle

        // Calculate which block this pixel belongs to
		int blockX = pixelCoord.x / n;
		int blockY = pixelCoord.y / n;

        // Calculate position within the block
		int pixelXInBlock = pixelCoord.x % n;
		int pixelYInBlock = pixelCoord.y % n;

        // Determine which frame in the cycle we're on
		int cycleFrame = frameNumber % ( n * n );

        // Calculate the rendering order within the block
		int renderOrder = ( pixelYInBlock * n + pixelXInBlock );

        // Determine if this pixel should be rendered in this frame
		bool shouldRender = ( renderOrder == cycleFrame );

        // Alternate the pattern for odd blocks
		if( ( blockX + blockY ) % 2 == 1 ) {
			shouldRender = ! shouldRender;
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

			vec2 jitterSample = getRandomSample( gl_FragCoord.xy, rayIndex, 0, seed, - 1 );

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

	// pixel.color.rgb = toneMapACESFilmic(pixel.color.rgb);
	// pixel.color.rgb = gammaCorrection(pixel.color.rgb);
	pixel.color.rgb = applyDithering( pixel.color.rgb, gl_FragCoord.xy / resolution, 0.5 ); // 0.5 is the dithering amount

	gl_FragColor = vec4( pixel.color.rgb, 1.0 );
}