precision highp float;

// Uniform declarations
uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform bool useBackground;
uniform int checkeredFrameInterval;
uniform sampler2D previousFrameTexture;
uniform int renderMode; // 0: Regular, 1: Checkered, 2: Tiled
uniform int tiles; // number of tiles
uniform int visMode;
uniform float debugVisScale;
uniform bool useAdaptiveSampling;
uniform int minSamples;
uniform int maxSamples;
uniform float varianceThreshold;

// Include statements
#include common.fs
#include struct.fs
#include random.fs
#include rayintersection.fs
#include environment.fs
#include bvhtraverse.fs
#include pbr.fs
#include lights.fs

// Global variables
ivec2 stats; // num triangle tests, num bounding box tests

// Function declarations
vec3 reduceFireflies( vec3 color, float maxValue );
void handleTransparentMaterial( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, inout uint rngState, inout vec3 rayColor, inout float alpha );
bool handleRussianRoulette( uint depth, vec3 rayColor, float randomValue );
vec3 ImportanceSampleCosine( vec3 N, vec2 xi );
vec3 sampleBRDF( vec3 V, vec3 N, RayTracingMaterial material, vec2 xi, out vec3 L, out float pdf, inout uint rngState );
vec3 handleClearCoat( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec4 blueNoise, out vec3 L, out float pdf, inout uint rngState );
vec4 Trace( Ray ray, inout uint rngState, int sampleIndex, int pixelIndex );
vec4 TraceDebugMode( vec3 rayOrigin, vec3 rayDir );
bool shouldRenderPixel( );
vec4 getPreviousFrameColor( vec2 coord );

// Function implementations
vec3 reduceFireflies( vec3 color, float maxValue ) {
	float luminance = dot( color, vec3( 0.299, 0.587, 0.114 ) );
	if( luminance > maxValue ) {
		color *= maxValue / luminance;
	}
	return color;
}

vec3 ImportanceSampleCosine( vec3 N, vec2 xi ) {
	// Create a local coordinate system where N is the Z axis
	vec3 T = normalize( cross( N, N.yzx + vec3( 0.1, 0.2, 0.3 ) ) );
	vec3 B = cross( N, T );

	// Cosine-weighted sampling
	float phi = 2.0 * PI * xi.x;
	float cosTheta = sqrt( 1.0 - xi.y );
	float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );

	// Convert from polar to Cartesian coordinates
	vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );

	// Transform the sampled direction to world space
	return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
}

vec3 sampleBRDF( vec3 V, vec3 N, RayTracingMaterial material, vec2 xi, out vec3 L, out float pdf, inout uint rngState ) {
	vec3 F0 = mix( vec3( 0.04 ), material.color.rgb, material.metalness );

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

void handleTransparentMaterial( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, inout uint rngState, inout vec3 rayColor, inout float alpha ) {

	bool entering = dot( ray.direction, hitInfo.normal ) < 0.0;
	float n1 = entering ? 1.0 : material.ior;
	float n2 = entering ? material.ior : 1.0;
	vec3 normal = entering ? hitInfo.normal : - hitInfo.normal;

	vec3 reflectDir = reflect( ray.direction, normal );
	vec3 refractDir = refract( ray.direction, normal, n1 / n2 );

	float cosTheta = abs( dot( - ray.direction, normal ) );
	float fresnel = fresnelSchlick( cosTheta, 0.04 );

	// if( RandomValue( rngState ) < fresnel ) {
	// 	// Reflect
	// 	ray.direction = reflectDir;
	// 	rayColor *= material.color.rgb;
	// } else {
    //     // Refract
    //     ray.direction = refractDir;

    //     // Modify the color absorption calculation
    //     // if (entering) {
    //     //     vec3 absorption = (vec3(1.0) - material.color.rgb) * material.thickness * 0.1;
    //     //     rayColor *= exp(-absorption * hitInfo.dst);
    //     // } else {
    //         // Add a slight tint when exiting
    //         rayColor *= mix(vec3(1.0), material.color.rgb, 0.5);
    //     // }
    // }

	if( length( refractDir ) < 0.001 || RandomValue( rngState ) < fresnel ) {
		ray.direction = reflectDir;
		rayColor *= material.color.rgb;
	} else {
		ray.direction = refractDir;
		if( entering ) {
			vec3 absorption = ( vec3( 1.0 ) - material.color.rgb ) * material.thickness * 0.5;
			rayColor *= exp( - absorption * hitInfo.dst );
		}
		rayColor *= mix( vec3( 1.0 ), material.color.rgb, 0.5 );
	}

	alpha *= ( 1.0 - material.transmission ) * material.color.a;
	ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
}

vec3 handleClearCoat( inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec4 blueNoise, out vec3 L, out float pdf, inout uint rngState ) {
	vec3 N = hitInfo.normal;
	vec3 V = - ray.direction;

	// Sample microfacet normal for clear coat layer
	vec2 Xi = blueNoise.xy;
	vec3 H = ImportanceSampleGGX( N, material.clearCoatRoughness, Xi );
	L = reflect( - V, H );

	float NoL = max( dot( N, L ), 0.0 );
	float NoH = max( dot( N, H ), 0.0 );
	float NoV = max( dot( N, V ), 0.0 );
	float VoH = max( dot( V, H ), 0.0 );

	// Fresnel term for clear coat (approximate with 0.04 as F0)
	float F = fresnelSchlick( VoH, 0.04 );

	// Specular BRDF for clear coat
	float D = DistributionGGX( N, H, material.clearCoatRoughness );
	float G = GeometrySmith( N, V, L, material.clearCoatRoughness );
	vec3 clearCoatBRDF = vec3( D * G * F ) / ( 4.0 * NoV * NoL + 0.001 );

	pdf = ( D * NoH ) / ( 4.0 * VoH );

	// Blend with base layer BRDF
	vec3 baseBRDF;
	float basePDF;
	baseBRDF = sampleBRDF( V, N, material, blueNoise.zw, L, basePDF, rngState );

	// Compute final BRDF and PDF
	vec3 finalBRDF = mix( baseBRDF, clearCoatBRDF, material.clearCoat * F );
	pdf = mix( basePDF, pdf, material.clearCoat * F );

	return finalBRDF;
}

bool handleRussianRoulette( uint depth, vec3 rayColor, float randomValue ) {
	uint minBounces = 3u;
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

vec4 Trace( Ray ray, inout uint rngState, int sampleIndex, int pixelIndex ) {
	vec3 incomingLight = vec3( 0.0 );
	vec3 throughput = vec3( 1.0 );
	uint depth = 0u;
	float alpha = 1.0;

	for( int i = 0; i <= maxBounceCount; i ++ ) {
		HitInfo hitInfo = traverseBVH( ray, stats );
		depth ++;

		if( ! hitInfo.didHit ) {
			// Environment lighting
			if( ! useBackground && i == 0 ) {
				// For primary rays (camera rays), return black
				incomingLight += vec3( 0.0 );
			} else {
				// For secondary rays (reflections, refractions), sample the environment normally
				vec3 envLight = sampleEnvironment( ray.direction ) * throughput;
				incomingLight += reduceFireflies( envLight, 5.0 );
			}
			break;
		}

		RayTracingMaterial material = hitInfo.material;
		material.color = sampleAlbedoTexture( material, hitInfo.uv );

		// Handle alpha testing
		if( RandomValue( rngState ) > material.color.a ) {
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
			handleTransparentMaterial( ray, hitInfo, material, rngState, throughput, alpha );
			continue;
		}

		// Sample BRDF
		vec4 blueNoise = sampleBlueNoise( gl_FragCoord.xy + vec2( float( sampleIndex ) * 13.37, float( sampleIndex ) * 31.41 + float( i ) * 71.71 ) );

		vec3 V = - ray.direction;
		vec3 N = hitInfo.normal;
		vec3 L;
		float pdf;
		vec3 brdfValue = sampleBRDF( V, N, material, blueNoise.xy, L, pdf, rngState );
		// return vec4(brdfValue, 1.0);

		// Handle clear coat
		if( material.clearCoat > 0.0 ) {
			brdfValue = handleClearCoat( ray, hitInfo, material, blueNoise, L, pdf, rngState );
		}

		// Calculate direct lighting using Multiple Importance Sampling
		vec3 directLight = calculateDirectLightingMIS( hitInfo, V, L, brdfValue, pdf, stats );
		incomingLight += reduceFireflies( directLight * throughput, 5.0 );

		// Calculate emitted light
		vec3 emittedLight = sampleEmissiveMap( material, hitInfo.uv );
		incomingLight += reduceFireflies( emittedLight * throughput, 5.0 );

		// Update throughput and alpha
		float NoL = max( dot( N, L ), 0.0 );
		throughput *= brdfValue * NoL / pdf;
		alpha *= material.color.a;

		// Russian roulette path termination
		if( ! handleRussianRoulette( depth, throughput, blueNoise.z ) ) {
			break;
		}

		// Prepare for next bounce
		ray.origin = hitInfo.hitPoint + L * 0.001;
		ray.direction = L;
	}
	return vec4( incomingLight, alpha );
}

vec4 TraceDebugMode( vec3 rayOrigin, vec3 rayDir ) {
	Ray ray;
	ray.origin = rayOrigin;
	ray.direction = rayDir;
	HitInfo hitInfo = traverseBVH( ray, stats );

	// Triangle test count vis
	if( visMode == 1 ) {
		float triVis = float( stats.x ) / debugVisScale;
		return triVis < 1.0 ? vec4( vec3( triVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
	}
	// Box test count vis
	else if( visMode == 2 ) {
		float boxVis = float( stats.y ) / debugVisScale;
		return boxVis < 1.0 ? vec4( vec3( boxVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
	}
	// Distance
	else if( visMode == 3 ) {
		return vec4( vec3( length( rayOrigin - hitInfo.hitPoint ) / debugVisScale ), 1.0 );
	}
	// Normal
	else if( visMode == 4 ) {
		if( ! hitInfo.didHit )
			return vec4( 0.0, 0.0, 0.0, 1.0 );
		return vec4( vec3( hitInfo.normal * 0.5 + 0.5 ), 1.0 );
	}
	return vec4( 1.0, 0.0, 1.0, 1.0 ); // Invalid test mode
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
		int cycleFrame = frameNumber % n;

		// Determine if this pixel should be rendered in this frame
		bool shouldRender = false;

		if( ( blockX + blockY ) % 2 == 0 ) {
			// "White" blocks
			shouldRender = ( pixelXInBlock + pixelYInBlock ) % n == cycleFrame;
		} else {
			// "Black" blocks
			shouldRender = ( pixelXInBlock + pixelYInBlock + 1 ) % n == cycleFrame;
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

vec4 getPreviousFrameColor( vec2 coord ) {
	return texture2D( previousFrameTexture, coord / resolution );
}

void main( ) {

	vec2 pixelSize = 1.0 / resolution;
	vec2 screenPosition = ( gl_FragCoord.xy / resolution ) * 2.0 - 1.0;

	Pixel pixel;
	pixel.color = vec4( 0.0 );
	pixel.variance = 0.0;
	pixel.samples = 0;

	vec4 squaredMean = vec4( 0.0 );
	uint seed = uint( gl_FragCoord.x ) * uint( gl_FragCoord.y ) * frame;
	int pixelIndex = int( gl_FragCoord.y ) * int( resolution.x ) + int( gl_FragCoord.x );

	bool shouldRender = shouldRenderPixel( );

	if( shouldRender ) {
		int samplesCount = useAdaptiveSampling ? maxSamples : numRaysPerPixel;

		for( int rayIndex = 0; rayIndex < samplesCount; rayIndex ++ ) {
			vec4 _sample = vec4( 0.0 );

			// Use blue noise for initial ray direction
			vec4 blueNoise = sampleBlueNoise( gl_FragCoord.xy + vec2( float( rayIndex ) * 13.37, float( rayIndex ) * 31.41 ) );
			vec2 jitter = ( blueNoise.xy - 0.5 ) * 2.0 * pixelSize;
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
				if( pixel.samples >= minSamples ) {
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
		pixel.color = getPreviousFrameColor( gl_FragCoord.xy );
	}

	gl_FragColor = vec4( pixel.color.rgb, 1.0 );
}