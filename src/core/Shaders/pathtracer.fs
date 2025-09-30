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

// Ray type enumeration for proper classification
const int RAY_TYPE_CAMERA = 0;        // Primary rays from camera
const int RAY_TYPE_REFLECTION = 1;     // Reflection rays
const int RAY_TYPE_TRANSMISSION = 2;   // Transmission/refraction rays
const int RAY_TYPE_DIFFUSE = 3;        // Diffuse indirect rays
const int RAY_TYPE_SHADOW = 4;         // Shadow rays

struct RenderState {
	int traversals;               // Remaining general bounces
	int transmissiveTraversals;   // Remaining transmission-specific bounces
	int rayType;                  // Current ray type (RAY_TYPE_*)
	bool isPrimaryRay;            // True only for camera rays (bounceIndex == 0)
	int actualBounceDepth;        // True depth without manipulation
};

uniform int transmissiveBounces;  // Controls the number of allowed transmission bounces

// Include statements - Core structures and utilities
#include struct.fs
#include common.fs
#include random.fs
#include environment.fs

// Texture sampling
#include texture_sampling.fs

// Geometry and scene traversal
#include rayintersection.fs
#include bvhtraverse.fs
#include displacement.fs

// Material system
#include fresnel.fs
#include material_properties.fs
#include material_evaluation.fs
#include material_sampling.fs
#include material_transmission.fs
#include clearcoat.fs

// Lighting system
#include lights_core.fs
#include lights_direct.fs
#include lights_sampling.fs
#include lights_indirect.fs

// Global variables
ivec2 stats; // num triangle tests, num bounding box tests
float pdf;

// OPTIMIZED: Consolidated material classification function with material change detection
MaterialClassification getOrCreateMaterialClassification( RayTracingMaterial material, int materialIndex, inout PathState pathState ) {
	// Only recompute classification if material actually changed or not cached yet
	if( ! pathState.classificationCached || pathState.lastMaterialIndex != materialIndex ) {
		pathState.materialClass = classifyMaterial( material );
		pathState.classificationCached = true;
		pathState.lastMaterialIndex = materialIndex;
		// Reset dependent caches when material changes
		pathState.weightsComputed = false;
		pathState.materialCacheCached = false;
	}
	return pathState.materialClass;
}

// BRDF sampling with early exits and optimized math
DirectionSample generateSampledDirection( vec3 V, vec3 N, RayTracingMaterial material, int materialIndex, vec2 xi, inout uint rngState, inout PathState pathState ) {

    // IMPROVEMENT: Use multi-lobe MIS for complex materials
	if( material.clearcoat > 0.1 || material.transmission > 0.1 || material.sheen > 0.1 || material.iridescence > 0.1 ) {
		return sampleMaterialWithMultiLobeMIS( V, N, material, xi, rngState );
	}

    // OPTIMIZED: Use consolidated classification function
	MaterialClassification mc = getOrCreateMaterialClassification( material, materialIndex, pathState );

    // OPTIMIZED: Compute BRDF weights using cached values when available
	if( ! pathState.weightsComputed ) {
		if( pathState.materialCacheCached ) {
			// Use precomputed cache values
			pathState.brdfWeights = calculateBRDFWeights( material, mc, pathState.materialCache );
		} else {
			// Create minimal temporary cache for BRDF calculations
			MaterialCache tempCache;
			tempCache.invRoughness = 1.0 - material.roughness;
			tempCache.metalFactor = 0.5 + 0.5 * material.metalness;
			tempCache.iorFactor = min( 2.0 / material.ior, 1.0 );
			tempCache.maxSheenColor = max( material.sheenColor.r, max( material.sheenColor.g, material.sheenColor.b ) );
			pathState.brdfWeights = calculateBRDFWeights( material, mc, tempCache );
		}
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

// Path tracing core
#include pathtracer_core.fs

// Enhanced path contribution estimation with improved caching - OPTIMIZED

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