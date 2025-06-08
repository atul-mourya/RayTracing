uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;
uniform float exposure;
uniform float environmentRotation;
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

// Pre-computed rotation matrix for environment
mat3 envRotationMatrix;
mat3 envRotationMatrixInverse;

// Initialize rotation matrices (call this when environmentRotation changes)
void initializeEnvironmentRotation( ) {
    float cosA = cos( environmentRotation );
    float sinA = sin( environmentRotation );

    // Rotation matrix around Y axis
    envRotationMatrix = mat3( cosA, 0.0, - sinA, 0.0, 1.0, 0.0, sinA, 0.0, cosA );

    // Inverse rotation matrix
    envRotationMatrixInverse = mat3( cosA, 0.0, sinA, 0.0, 1.0, 0.0, - sinA, 0.0, cosA );
}

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
    // Apply pre-computed rotation matrix
    vec3 rotatedDir = envRotationMatrix * direction;
    float phi = atan( rotatedDir.z, rotatedDir.x );
    float theta = acos( clamp( rotatedDir.y, - 1.0, 1.0 ) );
    return vec2( phi * ( 0.5 * PI_INV ) + 0.5, 1.0 - theta * PI_INV );
}

// Convert UV coordinates to direction (reverse of directionToUV)
vec3 uvToDirection( vec2 uv ) {
    float phi = ( uv.x - 0.5 ) * 2.0 * PI;
    float theta = uv.y * PI;

    float sinTheta = sin( theta );
    vec3 localDir = vec3( sinTheta * cos( phi ), cos( theta ), sinTheta * sin( phi ) );

    // Apply inverse rotation to get world direction
    return envRotationMatrixInverse * localDir;
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
    // Fast path for non-importance sampling - simple uniform sphere sampling
    if( ! useEnvMapIS ) {
        float phi = 2.0 * PI * xi.x;
        float cosTheta = 1.0 - xi.y;
        return vec2( phi / ( 2.0 * PI ), acos( cosTheta ) / PI );
    }

    // Importance sampling path - for CDF lookup
    vec2 cdfSize = envCDFSize;
    vec2 invSize = 1.0 / cdfSize;
    float scaleFactor = useEnvMipMap ? exp2( mipLevel ) : 1.0;
    float invScaleFactor = 1.0 / scaleFactor;
    vec2 effectiveSize = max( vec2( 4.0 ), cdfSize * invScaleFactor );

    // binary search for marginal CDF
    float marginalY = ( cdfSize.y - 0.5 ) * invSize.y;
    int bestCol = int( effectiveSize.x ) - 1;

    // Unrolled binary search for better GPU performance
    int step = bestCol >> 1;
    for( int iter = 0; iter < 8 && step > 0; iter ++ ) {
        int mid = bestCol - step;
        float sampleX = ( float( mid ) * scaleFactor + 0.5 ) * invSize.x;
        float cdfValue = textureLod( envCDF, vec2( sampleX, marginalY ), mipLevel ).r;

        if( xi.x > cdfValue ) {
            bestCol = mid;
        }
        step >>= 1;
    }

    // Interpolation for marginal
    float col0 = float( max( 0, bestCol - 1 ) ) * scaleFactor;
    float col1 = float( bestCol ) * scaleFactor;
    float cdf0 = bestCol > 0 ? textureLod( envCDF, vec2( ( col0 + 0.5 ) * invSize.x, marginalY ), mipLevel ).r : 0.0;
    float cdf1 = textureLod( envCDF, vec2( ( col1 + 0.5 ) * invSize.x, marginalY ), mipLevel ).r;

    // Improved numerical stability
    float denom = cdf1 - cdf0;
    float t = denom > 0.0001 ? clamp( ( xi.x - cdf0 ) / denom, 0.0, 1.0 ) : 0.5;
    float u = ( col0 + t * ( col1 - col0 ) + 0.5 ) * invSize.x;

    // Conditional sampling with optimized binary search
    float colX = ( col1 + 0.5 ) * invSize.x;
    int bestRow = int( effectiveSize.y ) - 2;

    step = bestRow >> 1;
    for( int iter = 0; iter < 8 && step > 0; iter ++ ) {
        int mid = bestRow - step;
        float sampleY = ( float( mid ) * scaleFactor + 0.5 ) * invSize.y;
        float cdfValue = textureLod( envCDF, vec2( colX, sampleY ), mipLevel ).r;

        if( xi.y > cdfValue ) {
            bestRow = mid;
        }
        step >>= 1;
    }

    // conditional interpolation
    float row0 = float( max( 0, bestRow - 1 ) ) * scaleFactor;
    float row1 = float( bestRow ) * scaleFactor;
    float cdf0_cond = bestRow > 0 ? textureLod( envCDF, vec2( colX, ( row0 + 0.5 ) * invSize.y ), mipLevel ).r : 0.0;
    float cdf1_cond = textureLod( envCDF, vec2( colX, ( row1 + 0.5 ) * invSize.y ), mipLevel ).r;

    float denom_cond = cdf1_cond - cdf0_cond;
    float t_cond = denom_cond > 0.0001 ? clamp( ( xi.y - cdf0_cond ) / denom_cond, 0.0, 1.0 ) : 0.5;
    float v = ( row0 + t_cond * ( row1 - row0 ) + 0.5 ) * invSize.y;

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
    float sinTheta = sqrt( 1.0 - direction.y * direction.y );
    if( sinTheta <= 0.001 )
        return 0.0001;

    // Precompute values
    vec2 cdfSize = envCDFSize;
    vec2 invSize = 1.0 / cdfSize;
    float scaleFactor = useEnvMipMap ? exp2( mipLevel ) : 1.0;
    float invScaleFactor = 1.0 / scaleFactor;
    vec2 effectiveSize = max( vec2( 4.0 ), cdfSize * invScaleFactor );

    vec2 cellCoord = uv * ( effectiveSize - 1.0 );
    vec2 cell = floor( cellCoord );
    vec2 fullResCell = cell * ( cdfSize * invScaleFactor );

    float marginalPdf = textureLod( envCDF, vec2( ( fullResCell.x + 0.5 ) * invSize.x, ( cdfSize.y - 0.5 ) * invSize.y ), mipLevel ).g;
    float conditionalPdf = textureLod( envCDF, vec2( ( fullResCell.x + 0.5 ) * invSize.x, ( fullResCell.y + 0.5 ) * invSize.y ), mipLevel ).g;

    return max( ( marginalPdf * conditionalPdf ) / sinTheta, 0.0001 );
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

    // Firefly reduction
    float importance = luminance( envValue ) / max( pdf, 0.0001 );
    float confidence = 1.0;

    if( bounceIndex > 0 ) {
        float maxImportance = 100.0 / float( bounceIndex + 1 );
        if( importance > maxImportance * 2.0 ) {
            float scale = maxImportance / importance;
            envValue *= scale;
            importance = maxImportance;
            confidence = 0.4;
        }
    }

    // Confidence calculation
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