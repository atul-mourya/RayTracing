uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;
uniform float exposure;
uniform mat4 environmentMatrix;
uniform bool useEnvMapIS;
uniform sampler2D envCDF;    // Stores marginal and conditional CDFs
uniform vec2 envCDFSize;     // Size of the CDF texture

uniform bool useEnvMipMap;
uniform float envSamplingBias; // Bias for mip level selection
uniform int maxEnvSamplingBounce; // Maximum bounces for environment sampling

// Structure to store sampling results
struct EnvMapSample {
    vec3 direction;
    vec3 value;
    float pdf;
    float importance;
    float confidence;
};

// Lookup table for environment sampling quality based on bounce and material type
// Format: [diffuse, specular, metal, transmission] for each bounce level
const float ENV_QUALITY_TABLE[ 32 ] = float[ 32 ](
    // Bounce 0: Always highest quality for primary rays
    1.0, 1.0, 1.0, 1.0,
    // Bounce 1: High quality, slight reduction for transmission
    0.9, 1.0, 1.0, 0.8,
    // Bounce 2: Moderate quality reduction
    0.7, 0.9, 0.95, 0.6,
    // Bounce 3: More aggressive reduction
    0.5, 0.7, 0.8, 0.4,
    // Bounce 4: Significant reduction
    0.3, 0.5, 0.6, 0.2,
    // Bounce 5: Minimal quality
    0.2, 0.3, 0.4, 0.1,
    // Bounce 6: Very low quality
    0.1, 0.2, 0.3, 0.05,
    // Bounce 7: Minimal quality
    0.05, 0.1, 0.2, 0.02 
);

const float MIP_LEVEL_TABLE[ 8 ] = float[ 8 ]( 
    0.0,  // Bounce 0: Full resolution
    0.0,  // Bounce 1: Full resolution
    0.3,  // Bounce 2: Slight blur
    0.7,  // Bounce 3: Moderate blur
    1.0,  // Bounce 4: More blur
    1.3,  // Bounce 5: Significant blur
    1.5,  // Bounce 6: Heavy blur
    2.0   // Bounce 7+: Maximum blur
);

float getEnvironmentQuality( int bounce, MaterialClassification mc ) {
    int clampedBounce = clamp( bounce, 0, 7 );
    int baseIndex = clampedBounce * 4;

    // Direct lookup based on material classification
    if( mc.isTransmissive )
        return ENV_QUALITY_TABLE[ baseIndex + 3 ];
    if( mc.isMetallic )
        return ENV_QUALITY_TABLE[ baseIndex + 2 ];
    if( mc.isSmooth )
        return ENV_QUALITY_TABLE[ baseIndex + 1 ];
    return ENV_QUALITY_TABLE[ baseIndex ]; // diffuse/default
}

float getEnvironmentMipLevel( int bounce ) {
    return MIP_LEVEL_TABLE[ clamp( bounce, 0, 7 ) ];
}

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
    // Apply environment matrix rotation
    vec3 rotatedDir = ( environmentMatrix * vec4( direction, 0.0 ) ).xyz;

    // Clamp Y component to prevent singularities at poles
    rotatedDir.y = clamp( rotatedDir.y, - 0.99999, 0.99999 );

    float phi = atan( rotatedDir.z, rotatedDir.x );
    float theta = acos( clamp( rotatedDir.y, - 1.0, 1.0 ) );

    // Enhanced UV calculation with pole handling
    float u = phi * ( 0.5 * PI_INV ) + 0.5;
    float v = 1.0 - theta * PI_INV;

    // Clamp UV coordinates to valid range with small epsilon
    return clamp( vec2( u, v ), vec2( 1e-6 ), vec2( 1.0 - 1e-6 ) );
}

// Convert UV coordinates to direction (reverse of directionToUV)
vec3 uvToDirection( vec2 uv ) {
    // Clamp UV to prevent extreme pole values
    uv = clamp( uv, vec2( 1e-6 ), vec2( 1.0 - 1e-6 ) );

    float phi = uv.x * TWO_PI;
    float theta = ( 1.0 - uv.y ) * PI;

    // Clamp theta away from exact poles
    theta = clamp( theta, 1e-4, PI - 1e-4 );

    float sinTheta = sin( theta );
    vec3 localDir = vec3( sinTheta * cos( phi ), cos( theta ), sinTheta * sin( phi ) );

    // Apply inverse environment matrix rotation
    return normalize( ( transpose( environmentMatrix ) * vec4( localDir, 0.0 ) ).xyz );
}

vec4 sampleEnvironment( vec3 direction ) {
    if( ! enableEnvironmentLight ) {
        return vec4( 0.0 );
    }

    vec2 uv = directionToUV( direction );
    vec4 texSample = texture( environment, uv );

    texSample.rgb *= texSample.a;
    return texSample;
}

// Invert CDF with proper interpolation to prevent bright spot bias
float invertCDFWithInterpolation( sampler2D cdfTexture, float u, float v, float mipLevel, vec2 cdfSize, bool isMarginal ) {
    vec2 invSize = 1.0 / cdfSize;

    // For marginal CDF, sample from last row
    float sampleV = isMarginal ? ( cdfSize.y - 0.5 ) * invSize.y : v;

    // Enhanced binary search with bounds checking
    int left = 0;
    int right = int( cdfSize.x ) - 1;

    // Ensure we have valid bounds
    if( right <= 0 ) {
        return 0.5 * invSize.x;
    }

    // 12 iterations for better precision (covers up to 4096 entries)
    for( int i = 0; i < 12; i ++ ) {
        if( left >= right )
            break;

        int mid = ( left + right ) / 2;
        float sampleU = ( float( mid ) + 0.5 ) * invSize.x;
        float cdfValue = textureLod( cdfTexture, vec2( sampleU, sampleV ), mipLevel ).r;

        if( u <= cdfValue ) {
            right = mid;
        } else {
            left = mid + 1;
        }
    }

    // CRITICAL FIX: Add proper interpolation to prevent bias
    int finalIdx = clamp( left, 0, int( cdfSize.x ) - 1 );

    // Get CDF values at current and next positions for interpolation
    float currentU = ( float( finalIdx ) + 0.5 ) * invSize.x;
    float currentCDF = textureLod( cdfTexture, vec2( currentU, sampleV ), mipLevel ).r;

    // Only interpolate if we're not at the boundary and have a meaningful difference
    if( finalIdx < int( cdfSize.x ) - 1 && abs( u - currentCDF ) > 1e-6 ) {
        float nextU = ( float( finalIdx + 1 ) + 0.5 ) * invSize.x;
        float nextCDF = textureLod( cdfTexture, vec2( nextU, sampleV ), mipLevel ).r;

        float cdfDiff = nextCDF - currentCDF;
        if( abs( cdfDiff ) > 1e-6 ) {
            // Linear interpolation between the two CDF values
            float t = ( u - currentCDF ) / cdfDiff;
            t = clamp( t, 0.0, 1.0 );
            return mix( currentU, nextU, t );
        }
    }

    return currentU;
}

// Quality determination using lookup tables
void determineEnvSamplingQuality(
    int bounceIndex,
    RayTracingMaterial material,
    vec3 viewDirection,
    vec3 normal,
    out float mipLevel,
    out float adaptiveBias
) {
    // ALWAYS use highest quality for primary rays
    if( bounceIndex == 0 ) {
        mipLevel = 0.0;
        adaptiveBias = envSamplingBias;
        return;
    }

    if( ! useEnvMipMap ) {
        mipLevel = 0.0;
        adaptiveBias = envSamplingBias;
        return;
    }

    // Quality reduction for bounces beyond max sampling
    if( bounceIndex > maxEnvSamplingBounce ) {
        mipLevel = 2.0;
        adaptiveBias = 0.5;
        return;
    }

    // Use material classification for lookup table
    MaterialClassification mc = classifyMaterial( material );

    // Direct lookup from tables
    mipLevel = getEnvironmentMipLevel( bounceIndex );
    float qualityFactor = getEnvironmentQuality( bounceIndex, mc );

    // Simple bias calculation using quality factor
    adaptiveBias = envSamplingBias * ( 0.5 + 0.5 * qualityFactor );
}

// Single function that handles both IS and non-IS sampling
vec2 sampleEnvironmentUV( vec2 xi, float mipLevel, float importanceBias ) {
    if( ! useEnvMapIS ) {
        // Uniform sphere sampling
        float phi = TWO_PI * xi.x;
        float cosTheta = 1.0 - 2.0 * xi.y;
        float theta = acos( clamp( cosTheta, - 1.0, 1.0 ) );
        // OPTIMIZED: Pre-computed 1/(2π) and 1/π
        return vec2( phi * 0.159154943, 1.0 - theta * 0.318309886 );
    }

    // Use interpolated CDF inversion
    vec2 cdfSize = envCDFSize;

    // Validate CDF size to prevent issues
    if( cdfSize.x < 2.0 || cdfSize.y < 2.0 ) {
        // Fallback to uniform sampling if CDF is invalid
        float phi = TWO_PI * xi.x;
        float cosTheta = 1.0 - 2.0 * xi.y;
        float theta = acos( clamp( cosTheta, - 1.0, 1.0 ) );
        return vec2( phi * 0.159154943, 1.0 - theta * 0.318309886 );
    }

    // 2D CDF sampling with interpolation
    // Step 1: Sample marginal CDF to get u coordinate
    float u = invertCDFWithInterpolation( envCDF, xi.x, 0.0, mipLevel, cdfSize, true );

    // Step 2: Sample conditional CDF at the sampled u coordinate
    float v = invertCDFWithInterpolation( envCDF, xi.y, u, mipLevel, cdfSize, false );

    return vec2( u, v );
}

// Normal PDF calculation for cleaner pole handling
float calculateNormalPDF( vec2 uv, float mipLevel, float sinTheta ) {
    vec2 cdfSize = envCDFSize;
    vec2 invSize = 1.0 / cdfSize;

    // Validate CDF before sampling
    if( cdfSize.x < 2.0 || cdfSize.y < 2.0 ) {
        return 1.0 / ( 4.0 * PI );
    }

    // Sample PDFs from texture (G channel) with bilinear filtering
    float marginalPdf = textureLod( envCDF, vec2( uv.x, ( cdfSize.y - 0.5 ) * invSize.y ), mipLevel ).g;
    float conditionalPdf = textureLod( envCDF, uv, mipLevel ).g;

    // PDF validation with pole-aware limits
    marginalPdf = clamp( marginalPdf, 1e-6, 100.0 );
    conditionalPdf = clamp( conditionalPdf, 1e-6, 100.0 );

    // Apply Jacobian with enhanced precision
    float jacobian = sinTheta * TWO_PI * PI;
    jacobian = max( jacobian, 1e-5 ); // Higher minimum for pole regions

    float finalPdf = ( marginalPdf * conditionalPdf ) / jacobian;

    // Enhanced clamping to prevent both fireflies and undersampling near poles
    return clamp( finalPdf, 1e-5, 500.0 );
}

// Single PDF calculation function
float calculateEnvironmentPDF( vec3 direction, float mipLevel ) {
    // Fast path for uniform sampling
    if( ! useEnvMapIS ) {
        return 1.0 / ( 4.0 * PI );
    }

    // Importance sampling PDF calculation with enhanced pole handling
    vec2 uv = directionToUV( direction );

    // Calculate theta for Jacobian with enhanced precision
    float theta = ( 1.0 - uv.y ) * PI;

    // Enhanced pole singularity handling
    float sinTheta = sin( theta );

    // Progressive clamping near poles to prevent fireflies
    if( sinTheta <= 1e-4 ) {
        // Very close to poles - use conservative fallback
        return 1e-3;
    } else if( sinTheta <= 1e-3 ) {
        // Near poles - blend between fallback and normal calculation
        float blendFactor = ( sinTheta - 1e-4 ) / ( 1e-3 - 1e-4 );
        float normalPdf = calculateNormalPDF( uv, mipLevel, sinTheta );
        return mix( 1e-3, normalPdf, blendFactor );
    }

    return calculateNormalPDF( uv, mipLevel, sinTheta );
}

// Streamlined environment sampling
EnvMapSample sampleEnvironmentWithContext(
    vec2 xi,
    int bounceIndex,
    RayTracingMaterial material,
    vec3 viewDirection,
    vec3 normal
) {
    EnvMapSample result;

    if( ! enableEnvironmentLight ) {
        result.direction = vec3( 0.0, 1.0, 0.0 );
        result.value = vec3( 0.0 );
        result.pdf = 1.0;
        result.importance = 0.0;
        result.confidence = 1.0;
        return result;
    }

    // Quality determination
    float mipLevel, adaptiveBias;
    determineEnvSamplingQuality( bounceIndex, material, viewDirection, normal, mipLevel, adaptiveBias );

    // Single sampling call
    vec2 uv = sampleEnvironmentUV( xi, mipLevel, adaptiveBias );
    vec3 direction = uvToDirection( uv );

    // Environment value calculation with LOD
    vec4 envColor = textureLod( environment, uv, mipLevel );

    // Fallback handling
    if( length( envColor.rgb ) < 0.001 && mipLevel > 0.0 ) {
        envColor = texture( environment, uv );
    }

    // Single PDF calculation
    float pdf = calculateEnvironmentPDF( direction, mipLevel );

    // Environment value calculation
    vec3 envValue = envColor.rgb;

    // MUCH more lenient firefly control for IS
    float importance = luminance( envValue ) / max( pdf, 0.0001 );
    float confidence = 1.0;

    // Only clamp on deep bounces and be very conservative
    if( bounceIndex > 4 ) {
        float maxImportance = fireflyThreshold * 50.0; // Much higher threshold
        if( importance > maxImportance ) {
            float scale = sqrt( maxImportance / importance ); // Gentler scaling
            envValue *= scale;
            confidence = 0.7;
        }
    }

    confidence *= clamp( pdf * 1000.0, 0.1, 1.0 );
    confidence *= clamp( 1.0 - float( bounceIndex ) * 0.15, 0.2, 1.0 );

    result.direction = direction;
    result.value = envValue;
    result.pdf = pdf;
    result.importance = importance;
    result.confidence = confidence;

    return result;
}

// Entry point for PDF calculation
float envMapSamplingPDFWithContext(
    vec3 direction,
    int bounceIndex,
    RayTracingMaterial material,
    vec3 viewDirection,
    vec3 normal
) {
    float mipLevel, adaptiveBias;
    determineEnvSamplingQuality( bounceIndex, material, viewDirection, normal, mipLevel, adaptiveBias );
    return calculateEnvironmentPDF( direction, mipLevel );
}

bool shouldUseEnvironmentSampling( int bounceIndex, RayTracingMaterial material ) {
    if( ! enableEnvironmentLight )
        return false;
    if( bounceIndex > maxEnvSamplingBounce + 2 )
        return false;
    if( bounceIndex > 3 && material.transmission > 0.9 )
        return false;
    return true;
}
