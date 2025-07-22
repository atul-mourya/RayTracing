uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;
uniform float exposure;
uniform mat4 environmentMatrix;
uniform bool useEnvMapIS;
uniform sampler2D envCDF;    // Stores marginal and conditional CDFs
uniform vec2 envCDFSize;     // Size of the CDF texture

uniform bool useEnvMipMap;
uniform float envSamplingBias;
uniform int maxEnvSamplingBounce;

// Structure to store sampling results
struct EnvMapSample {
    vec3 direction;
    vec3 value;
    float pdf;
    float importance;
    float confidence;
};

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
    // Apply environment matrix rotation
    vec3 rotatedDir = ( environmentMatrix * vec4( direction, 0.0 ) ).xyz;
    float phi = atan( rotatedDir.z, rotatedDir.x );
    float theta = acos( clamp( rotatedDir.y, - 1.0, 1.0 ) );
    return vec2( phi * ( 0.5 * PI_INV ) + 0.5, 1.0 - theta * PI_INV );
}

// Convert UV coordinates to direction (reverse of directionToUV)
vec3 uvToDirection( vec2 uv ) {
    float phi = uv.x * TWO_PI; // 2π
    float theta = ( 1.0 - uv.y ) * PI;

    float sinTheta = sin( theta );
    vec3 localDir = vec3( sinTheta * cos( phi ), cos( theta ), sinTheta * sin( phi ) );

    // Apply inverse environment matrix rotation
    return ( transpose( environmentMatrix ) * vec4( localDir, 0.0 ) ).xyz;
}

vec4 sampleEnvironment( vec3 direction ) {
    if( ! enableEnvironmentLight ) {
        return vec4( 0.0 );
    }

    vec2 uv = directionToUV( direction );
    vec4 texSample = texture( environment, uv );

    float intensityScale = environmentIntensity * exposure;

    // Keep values in linear space, just apply basic intensity control
    float lumValue = luminance( texSample.rgb ) * intensityScale;

    // Softer scale for very bright areas to prevent harsh clipping
    if( lumValue > 1.0 ) {
        intensityScale *= 1.0 / ( 1.0 + log( lumValue ) );
    }

    texSample.rgb *= intensityScale * texSample.a;
    return texSample;
}

// Invert CDF using fixed iteration binary search for better GPU performance
float invertCDF( sampler2D cdfTexture, float u, float v, float mipLevel, vec2 cdfSize, bool isMarginal ) {
    vec2 invSize = 1.0 / cdfSize;

    // For marginal CDF, sample from last row
    float sampleV = isMarginal ? ( cdfSize.y - 0.5 ) * invSize.y : v;

    // Fixed iteration binary search (no while loops for GPU efficiency)
    int left = 0;
    int right = int( cdfSize.x ) - 1;

    // 10 iterations covers up to 1024 entries, sufficient for most CDFs
    for( int i = 0; i < 10; i ++ ) {
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

    // Simplified return (skip interpolation for performance)
    int idx = clamp( left, 0, int( cdfSize.x ) - 1 );
    return ( float( idx ) + 0.5 ) * invSize.x;
}

// Enhanced quality determination
void determineEnvSamplingQuality(
    int bounceIndex,
    RayTracingMaterial material,
    vec3 viewDirection,
    vec3 normal,
    out float mipLevel,
    out float adaptiveBias
) {
    mipLevel = 0.0;
    adaptiveBias = envSamplingBias;

    // ALWAYS use highest quality for primary rays
    if( bounceIndex == 0 ) {
        return;
    }

    if( ! useEnvMipMap )
        return;

    // Quality reduction for higher bounces
    if( bounceIndex > maxEnvSamplingBounce ) {
        mipLevel = 1.5; // More conservative than before
        adaptiveBias = 0.8; // Less aggressive bias
        return;
    }

    // Material analysis using linear combinations
    float materialComplexity = 0.4 * float( material.metalness > 0.7 ) +
        0.3 * float( material.roughness < 0.3 ) +
        0.2 * float( material.clearcoat > 0.5 ) -
        0.3 * float( material.transmission > 0.5 );

    float viewAngle = abs( dot( viewDirection, normal ) );
    float grazingFactor = 1.0 - viewAngle;

    float qualityFactor = clamp( materialComplexity + grazingFactor * 0.3, 0.0, 1.0 );
    qualityFactor /= ( 1.0 + float( bounceIndex ) * 0.4 );

    // Quality level assignment using step functions
    float q1 = step( 0.8, qualityFactor );
    float q2 = step( 0.6, qualityFactor ) * ( 1.0 - q1 );
    float q3 = step( 0.4, qualityFactor ) * ( 1.0 - q1 - q2 );
    float q4 = step( 0.2, qualityFactor ) * ( 1.0 - q1 - q2 - q3 );

    mipLevel = q1 * 0.0 + q2 * 0.3 + q3 * 0.7 + q4 * 1.0 + ( 1.0 - q1 - q2 - q3 - q4 ) * 1.5;

    // Enhanced bias calculation using linear combination
    float biasMultiplier = 1.0 +
        0.2 * float( material.metalness > 0.7 || material.roughness < 0.3 ) -
        0.1 * float( material.roughness > 0.8 );
    adaptiveBias = envSamplingBias * biasMultiplier;
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

    // Importance sampling with proper CDF inversion
    vec2 cdfSize = envCDFSize;

    // 2D CDF sampling
    // Step 1: Sample marginal CDF to get u coordinate
    float u = invertCDF( envCDF, xi.x, 0.0, mipLevel, cdfSize, true );

    // Step 2: Sample conditional CDF at the sampled u coordinate
    float v = invertCDF( envCDF, xi.y, u, mipLevel, cdfSize, false );

    return vec2( u, v );
}

// Single PDF calculation function
float calculateEnvironmentPDF( vec3 direction, float mipLevel ) {
    // Fast path for uniform sampling
    if( ! useEnvMapIS ) {
        return 1.0 / ( 4.0 * PI );
    }

    // Importance sampling PDF calculation
    vec2 uv = directionToUV( direction );

    // Calculate theta for Jacobian
    float theta = ( 1.0 - uv.y ) * PI;
    float sinTheta = sin( theta );

    // Handle singularities at poles
    if( sinTheta <= EPSILON ) {
        return EPSILON;
    }

    vec2 cdfSize = envCDFSize;
    vec2 invSize = 1.0 / cdfSize;

    // Sample PDFs from texture (G channel)
    float marginalPdf = textureLod( envCDF, vec2( uv.x, ( cdfSize.y - 0.5 ) * invSize.y ), mipLevel ).g;
    float conditionalPdf = textureLod( envCDF, uv, mipLevel ).g;

    // Apply Jacobian for spherical coordinates
    float jacobian = sinTheta * TWO_PI * PI;  // 2π²

    return max( ( marginalPdf * conditionalPdf ) / jacobian, EPSILON );
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
    vec3 envValue = envColor.rgb * environmentIntensity;

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

vec4 sampleEnvironmentLOD( vec3 direction, float mipLevel ) {
    if( ! enableEnvironmentLight )
        return vec4( 0.0 );

    vec2 uv = directionToUV( direction );
    vec4 texSample = textureLod( environment, uv, mipLevel );
    float intensityScale = environmentIntensity * exposure;
    float lumValue = luminance( texSample.rgb ) * intensityScale;

    if( lumValue > 1.0 ) {
        float mipFactor = 1.0 + mipLevel * 0.1;
        float softScale = 1.0 / ( 1.0 + lumValue * ( 0.2 * mipFactor ) );
        intensityScale *= softScale;
    }

    texSample.rgb *= intensityScale * texSample.a;
    return texSample;
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

vec4 getEnvironmentContribution( vec3 direction, int bounceIndex ) {
    if( bounceIndex == 0 ) {
        // Primary rays: ALWAYS use full resolution for background
        return showBackground ? sampleEnvironment( direction ) * backgroundIntensity : vec4( 0.0 );
    } else {
        // Secondary rays: use conservative mip levels
        float mipLevel = useEnvMipMap ? min( float( bounceIndex - 1 ) * 0.3, 1.5 ) : 0.0;
        return sampleEnvironmentLOD( direction, mipLevel );
    }
}