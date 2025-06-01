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
uniform bool enableTemporalEnvJitter;

// Structure to store sampling results
struct EnvMapSample {
    vec3 direction;
    vec3 value;
    float pdf;
    float importance;
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

    // ALWAYS use mip level 0 for primary rays (background)
    if( bounceIndex == 0 ) {
        return;
    }

    if( ! useEnvMipMap )
        return;

    // Early quality reduction for deep bounces - but more conservative
    if( bounceIndex > maxEnvSamplingBounce ) {
        mipLevel = 2.0; // Restored to more conservative value
        adaptiveBias = 0.7;
        return;
    }

    // Material complexity assessment
    float materialComplexity = 0.0;
    if( material.metalness > 0.7 )
        materialComplexity += 0.4;
    if( material.roughness < 0.3 )
        materialComplexity += 0.3;
    if( material.clearcoat > 0.5 )
        materialComplexity += 0.2;
    if( material.transmission > 0.5 )
        materialComplexity -= 0.3;

    // Viewing angle factor (grazing angles need more detail)
    float viewAngle = abs( dot( viewDirection, normal ) );
    float grazingFactor = 1.0 - viewAngle;

    // Combined quality factor
    float qualityFactor = clamp( materialComplexity + grazingFactor * 0.3, 0.0, 1.0 );
    qualityFactor *= 1.0 / ( 1.0 + float( bounceIndex ) * 0.4 );

    // More conservative mip level selection
    if( qualityFactor > 0.8 ) {
        mipLevel = 0.0;
    } else if( qualityFactor > 0.6 ) {
        mipLevel = 0.5;
    } else if( qualityFactor > 0.4 ) {
        mipLevel = 1.0;
    } else if( qualityFactor > 0.2 ) {
        mipLevel = 1.5;
    } else {
        mipLevel = 2.0;
    }

    // Adaptive bias based on material
    if( material.metalness > 0.7 || material.roughness < 0.3 ) {
        adaptiveBias = envSamplingBias * 1.3;
    } else if( material.roughness > 0.8 ) {
        adaptiveBias = envSamplingBias * 0.8;
    }
}

vec2 sampleCDFEnhanced( vec2 xi, float mipLevel, float importanceBias ) {
    if( ! useEnvMapIS ) {
        float phi = 2.0 * PI * xi.x;
        float cosTheta = 1.0 - xi.y;
        return vec2( phi / ( 2.0 * PI ), acos( cosTheta ) / PI );
    }

    vec2 cdfSize = envCDFSize;
    vec2 invSize = 1.0 / cdfSize;

    // Apply importance bias
    vec2 biasedXi = xi;
    if( importanceBias != 1.0 ) {
        biasedXi.x = pow( xi.x, 1.0 / importanceBias );
        biasedXi.y = pow( xi.y, 1.0 / importanceBias );
    }

    // Add temporal jittering
    if( enableTemporalEnvJitter ) {
        float temporalNoise = fract( float( frame ) * 0.618034 );
        biasedXi.x = fract( biasedXi.x + temporalNoise * 0.1 );
        biasedXi.y = fract( biasedXi.y + temporalNoise * 0.1732 );
    }

    // Effective resolution based on mip level
    float scaleFactor = useEnvMipMap ? exp2( mipLevel ) : 1.0;
    vec2 effectiveSize = max( vec2( 4.0 ), cdfSize / scaleFactor );

    // Binary search for marginal distribution
    float marginalY = ( cdfSize.y - 0.5 ) * invSize.y;
    int low = 0;
    int high = int( effectiveSize.x ) - 1;
    int bestCol = high;

    for( int iter = 0; iter < 12; iter ++ ) {
        if( low >= high )
            break;
        int mid = ( low + high ) >> 1;
        float sampleX = ( float( mid ) * scaleFactor + 0.5 ) * invSize.x;
        float cdfValue = textureLod( envCDF, vec2( sampleX, marginalY ), mipLevel ).r;

        if( biasedXi.x <= cdfValue ) {
            bestCol = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    // Interpolation for marginal
    float col0 = float( max( 0, bestCol - 1 ) ) * scaleFactor;
    float col1 = float( bestCol ) * scaleFactor;
    float cdf0 = bestCol > 0 ? textureLod( envCDF, vec2( ( col0 + 0.5 ) * invSize.x, marginalY ), mipLevel ).r : 0.0;
    float cdf1 = textureLod( envCDF, vec2( ( col1 + 0.5 ) * invSize.x, marginalY ), mipLevel ).r;
    float t = ( cdf1 - cdf0 ) > 0.0001 ? ( biasedXi.x - cdf0 ) / ( cdf1 - cdf0 ) : 0.5;
    float u = ( col0 + t * ( col1 - col0 ) + 0.5 ) * invSize.x;

    // Binary search for conditional distribution
    float colX = ( col1 + 0.5 ) * invSize.x;
    low = 0;
    high = int( effectiveSize.y ) - 2;
    int bestRow = high;

    for( int iter = 0; iter < 12; iter ++ ) {
        if( low >= high )
            break;
        int mid = ( low + high ) >> 1;
        float sampleY = ( float( mid ) * scaleFactor + 0.5 ) * invSize.y;
        float cdfValue = textureLod( envCDF, vec2( colX, sampleY ), mipLevel ).r;

        if( biasedXi.y <= cdfValue ) {
            bestRow = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    // Interpolation for conditional
    float row0 = float( max( 0, bestRow - 1 ) ) * scaleFactor;
    float row1 = float( bestRow ) * scaleFactor;
    float cdf0_cond = bestRow > 0 ? textureLod( envCDF, vec2( colX, ( row0 + 0.5 ) * invSize.y ), mipLevel ).r : 0.0;
    float cdf1_cond = textureLod( envCDF, vec2( colX, ( row1 + 0.5 ) * invSize.y ), mipLevel ).r;
    float t_cond = ( cdf1_cond - cdf0_cond ) > 0.0001 ? ( biasedXi.y - cdf0_cond ) / ( cdf1_cond - cdf0_cond ) : 0.5;
    float v = ( row0 + t_cond * ( row1 - row0 ) + 0.5 ) * invSize.y;

    return vec2( u, v );
}

float calculateEnhancedPDF( vec3 direction, float mipLevel, float importanceBias ) {
    if( ! useEnvMapIS )
        return 1.0 / ( 2.0 * PI );

    vec2 uv = directionToUV( direction );
    float theta = uv.y * PI;
    float sinTheta = sin( theta );
    if( sinTheta <= 0.001 )
        return 0.0001;

    vec2 cdfSize = envCDFSize;
    vec2 invSize = 1.0 / cdfSize;
    float scaleFactor = useEnvMipMap ? exp2( mipLevel ) : 1.0;
    vec2 effectiveSize = max( vec2( 4.0 ), cdfSize / scaleFactor );

    vec2 cellCoord = uv * ( effectiveSize - 1.0 );
    vec2 cell = floor( cellCoord );
    vec2 fullResCell = cell * ( cdfSize / effectiveSize );

    float marginalPdf = textureLod( envCDF, vec2( ( fullResCell.x + 0.5 ) * invSize.x, ( cdfSize.y - 0.5 ) * invSize.y ), mipLevel ).g;
    float conditionalPdf = textureLod( envCDF, vec2( ( fullResCell.x + 0.5 ) * invSize.x, ( fullResCell.y + 0.5 ) * invSize.y ), mipLevel ).g;

    float pdf = ( marginalPdf * conditionalPdf ) / sinTheta;

    if( importanceBias != 1.0 ) {
        pdf *= pow( max( pdf, 0.0001 ), ( importanceBias - 1.0 ) / importanceBias );
    }

    return max( pdf, 0.0001 );
}

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
        return result;
    }

    // Determine sampling quality
    float mipLevel, adaptiveBias;
    determineEnvSamplingQuality( bounceIndex, material, viewDirection, normal, mipLevel, adaptiveBias );

    // Sample CDF with adaptive quality
    vec2 uv = sampleCDFEnhanced( xi, mipLevel, adaptiveBias );
    vec3 direction = uvToDirection( uv );

    // Sample environment with appropriate mip level
    vec4 envColor = textureLod( environment, uv, mipLevel );
    
    // Add fallback for missing mip levels
    if( length( envColor.rgb ) < 0.001 && mipLevel > 0.0 ) {
        // Fallback to mip level 0 if higher mip levels return black/gray
        envColor = textureLod( environment, uv, 0.0 );
    }
    
    float pdf = calculateEnhancedPDF( direction, mipLevel, adaptiveBias );

    // Apply environment intensity with more conservative tone mapping
    vec3 envValue = envColor.rgb * environmentIntensity;
    float envLuminance = luminance( envValue );

    // More conservative tone mapping
    if( envLuminance > 2.0 ) {
        float toneMapped = envLuminance / ( 1.0 + envLuminance * 0.3 );
        envValue *= toneMapped / envLuminance;
    }

    // Calculate importance and apply conservative firefly reduction
    float importance = envLuminance / max( pdf, 0.0001 );

    if( bounceIndex > 0 ) {
        float maxAllowedImportance = 100.0 / float( bounceIndex + 1 );
        if( material.roughness > 0.5 )
            maxAllowedImportance *= 1.5;
        if( material.metalness > 0.7 )
            maxAllowedImportance *= 0.8;

        if( importance > maxAllowedImportance ) {
            float scale = maxAllowedImportance / importance;
            envValue *= scale;
            importance = maxAllowedImportance;
        }
    }

    result.direction = direction;
    result.value = envValue;
    result.pdf = pdf;
    result.importance = importance;

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
        float softScale = 1.0 / ( 1.0 + lumValue * ( 0.3 + mipLevel * 0.1 ) );
        intensityScale *= softScale;
    }

    texSample.rgb *= intensityScale * texSample.a;
    return texSample;
}

float envMapSamplingPDFWithContext(
    vec3 direction,
    int bounceIndex,
    RayTracingMaterial material,
    vec3 viewDirection,
    vec3 normal
) {
    float mipLevel, adaptiveBias;
    determineEnvSamplingQuality( bounceIndex, material, viewDirection, normal, mipLevel, adaptiveBias );
    return calculateEnhancedPDF( direction, mipLevel, adaptiveBias );
}

float envMapSamplingPDF( vec3 direction ) {
    return calculateEnhancedPDF( direction, 0.0, envSamplingBias );
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
        float mipLevel = useEnvMipMap ? min( float( bounceIndex - 1 ) * 0.5, 2.0 ) : 0.0;
        return sampleEnvironmentLOD( direction, mipLevel );
    }
}