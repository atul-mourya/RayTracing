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

// Enhanced quality determination with noise considerations
void determineEnvSamplingQuality(
    int bounceIndex,
    RayTracingMaterial material,
    vec3 viewDirection,
    vec3 normal,
    out float mipLevel,
    out float adaptiveBias,
    out float noiseReduction
) {
    mipLevel = 0.0;
    adaptiveBias = envSamplingBias;
    noiseReduction = 1.0;

    // ALWAYS use highest quality for primary rays
    if( bounceIndex == 0 ) {
        noiseReduction = 1.0; // Maximum noise reduction for background
        return;
    }

    if( ! useEnvMipMap )
        return;

    // Noise-aware quality reduction
    if( bounceIndex > maxEnvSamplingBounce ) {
        mipLevel = 1.5; // More conservative than before
        adaptiveBias = 0.8; // Less aggressive bias
        noiseReduction = 0.7; // Moderate noise reduction
        return;
    }

    // Enhanced material analysis for noise prediction
    float materialComplexity = 0.0;
    float noisePotential = 0.0;

    if( material.metalness > 0.7 ) {
        materialComplexity += 0.4;
        noisePotential += 0.3; // Metals can be noisy with environment
    }
    if( material.roughness < 0.3 ) {
        materialComplexity += 0.3;
        noisePotential += 0.4; // Smooth surfaces show environment noise more
    }
    if( material.clearcoat > 0.5 ) {
        materialComplexity += 0.2;
        noisePotential += 0.2;
    }
    if( material.transmission > 0.5 ) {
        materialComplexity -= 0.3;
        noisePotential -= 0.2; // Transmission is generally less noisy
    }

    float viewAngle = abs( dot( viewDirection, normal ) );
    float grazingFactor = 1.0 - viewAngle;

    // Grazing angles are more prone to noise
    noisePotential += grazingFactor * 0.3;

    float qualityFactor = clamp( materialComplexity + grazingFactor * 0.3, 0.0, 1.0 );
    qualityFactor /= ( 1.0 + float( bounceIndex ) * 0.4 );

    // Noise-aware mip level selection
    if( qualityFactor > 0.8 ) {
        mipLevel = 0.0;
        noiseReduction = 1.0;
    } else if( qualityFactor > 0.6 ) {
        mipLevel = 0.3; // Slightly higher quality
        noiseReduction = 0.9;
    } else if( qualityFactor > 0.4 ) {
        mipLevel = 0.7; // More conservative
        noiseReduction = 0.8;
    } else if( qualityFactor > 0.2 ) {
        mipLevel = 1.0;
        noiseReduction = 0.7;
    } else {
        mipLevel = 1.5;
        noiseReduction = 0.6;
    }

    // Adjust for noise potential
    if( noisePotential > 0.5 ) {
        mipLevel = max( 0.0, mipLevel - 0.2 ); // Use higher quality for noisy materials
        noiseReduction = min( 1.0, noiseReduction + 0.1 );
    }

    // Enhanced bias calculation
    if( material.metalness > 0.7 || material.roughness < 0.3 ) {
        adaptiveBias = envSamplingBias * 1.2; // Reduced from 1.3
    } else if( material.roughness > 0.8 ) {
        adaptiveBias = envSamplingBias * 0.9; // Less aggressive
    }
}

// Improved stratified CDF sampling to reduce noise
vec2 sampleCDFEnhanced( vec2 xi, float mipLevel, float importanceBias, float noiseReduction ) {
    if( ! useEnvMapIS ) {
        float phi = 2.0 * PI * xi.x;
        float cosTheta = 1.0 - xi.y;
        return vec2( phi / ( 2.0 * PI ), acos( cosTheta ) / PI );
    }

    vec2 cdfSize = envCDFSize;
    vec2 invSize = 1.0 / cdfSize;

    // Enhanced bias application with noise consideration
    vec2 biasedXi = xi;
    if( importanceBias != 1.0 ) {
        // Soften bias to reduce noise
        float softenedBias = mix( 1.0, importanceBias, noiseReduction );
        biasedXi.x = pow( xi.x, 1.0 / softenedBias );
        biasedXi.y = pow( xi.y, 1.0 / softenedBias );
    }

    // Improved temporal jittering - use blue noise pattern
    if( enableTemporalEnvJitter ) {
        float temporalNoise = fract( float( frame ) * 0.618034 );
        // Reduce jitter amount to decrease noise
        float jitterAmount = mix( 0.02, 0.05, noiseReduction );
        biasedXi.x = fract( biasedXi.x + temporalNoise * jitterAmount );
        biasedXi.y = fract( biasedXi.y + temporalNoise * jitterAmount * 1.732 );
    }

    float scaleFactor = useEnvMipMap ? exp2( mipLevel ) : 1.0;
    vec2 effectiveSize = max( vec2( 4.0 ), cdfSize / scaleFactor );

    // Enhanced binary search with better convergence
    float marginalY = ( cdfSize.y - 0.5 ) * invSize.y;
    int low = 0;
    int high = int( effectiveSize.x ) - 1;
    int bestCol = high;

    // Adaptive iteration count based on noise reduction needs
    int maxIterations = int( mix( 8.0, 12.0, noiseReduction ) );

    for( int iter = 0; iter < 12; iter ++ ) {
        if( iter >= maxIterations || low >= high )
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

    // Improved numerical stability
    float denom = cdf1 - cdf0;
    float t = denom > 0.0001 ? clamp( ( biasedXi.x - cdf0 ) / denom, 0.0, 1.0 ) : 0.5;
    float u = ( col0 + t * ( col1 - col0 ) + 0.5 ) * invSize.x;

    // Enhanced conditional sampling
    float colX = ( col1 + 0.5 ) * invSize.x;
    low = 0;
    high = int( effectiveSize.y ) - 2;
    int bestRow = high;

    for( int iter = 0; iter < 12; iter ++ ) {
        if( iter >= maxIterations || low >= high )
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

    // Enhanced conditional interpolation
    float row0 = float( max( 0, bestRow - 1 ) ) * scaleFactor;
    float row1 = float( bestRow ) * scaleFactor;
    float cdf0_cond = bestRow > 0 ? textureLod( envCDF, vec2( colX, ( row0 + 0.5 ) * invSize.y ), mipLevel ).r : 0.0;
    float cdf1_cond = textureLod( envCDF, vec2( colX, ( row1 + 0.5 ) * invSize.y ), mipLevel ).r;

    float denom_cond = cdf1_cond - cdf0_cond;
    float t_cond = denom_cond > 0.0001 ? clamp( ( biasedXi.y - cdf0_cond ) / denom_cond, 0.0, 1.0 ) : 0.5;
    float v = ( row0 + t_cond * ( row1 - row0 ) + 0.5 ) * invSize.y;

    return vec2( u, v );
}

// Enhanced PDF calculation with noise awareness
float calculateEnhancedPDF( vec3 direction, float mipLevel, float importanceBias, float noiseReduction ) {
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

    // Softer bias application to reduce noise
    if( importanceBias != 1.0 ) {
        float softenedBias = mix( 1.0, importanceBias, noiseReduction );
        pdf *= pow( max( pdf, 0.0001 ), ( softenedBias - 1.0 ) / softenedBias );
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
        result.confidence = 1.0;
        return result;
    }

    // Enhanced quality determination with noise analysis
    float mipLevel, adaptiveBias, noiseReduction;
    determineEnvSamplingQuality( bounceIndex, material, viewDirection, normal, mipLevel, adaptiveBias, noiseReduction );

    // Enhanced CDF sampling
    vec2 uv = sampleCDFEnhanced( xi, mipLevel, adaptiveBias, noiseReduction );
    vec3 direction = uvToDirection( uv );

    // Multi-level sampling for better quality
    vec4 envColor = textureLod( environment, uv, mipLevel );

    // Enhanced fallback with gradual quality reduction
    if( length( envColor.rgb ) < 0.001 && mipLevel > 0.0 ) {
        // Try intermediate mip levels first
        float fallbackMip = max( 0.0, mipLevel - 0.5 );
        envColor = textureLod( environment, uv, fallbackMip );

        if( length( envColor.rgb ) < 0.001 ) {
            envColor = texture( environment, uv );
        }
    }

    float pdf = calculateEnhancedPDF( direction, mipLevel, adaptiveBias, noiseReduction );

    // Enhanced tone mapping with noise considerations
    vec3 envValue = envColor.rgb * environmentIntensity;
    float envLuminance = luminance( envValue );

    // Adaptive tone mapping based on bounce index and material
    float toneThreshold = mix( 1.5, 3.0, noiseReduction );
    if( envLuminance > toneThreshold ) {
        float compressionFactor = mix( 0.4, 0.2, noiseReduction );
        float toneMapped = envLuminance / ( 1.0 + envLuminance * compressionFactor );
        envValue *= toneMapped / envLuminance;
        envLuminance = toneMapped;
    }

    // Advanced firefly reduction with confidence weighting
    float importance = envLuminance / max( pdf, 0.0001 );
    float confidence = 1.0;

    if( bounceIndex > 0 ) {
        // Adaptive importance clamping
        float baseMaxImportance = mix( 50.0, 150.0, noiseReduction ) / float( bounceIndex + 1 );

        // Material-specific adjustments
        if( material.roughness > 0.5 ) {
            baseMaxImportance *= 1.3; // Rough materials can handle more variation
        }
        if( material.metalness > 0.7 ) {
            baseMaxImportance *= 0.9; // Metals need tighter control
        }

        // Gradual importance reduction instead of hard clamping
        if( importance > baseMaxImportance ) {
            float excessRatio = importance / baseMaxImportance;

            if( excessRatio > 3.0 ) {
                // Hard clamp for extreme values
                float scale = baseMaxImportance / importance;
                envValue *= scale;
                importance = baseMaxImportance;
                confidence = 0.3; // Low confidence for clamped samples
            } else {
                // Soft compression for moderate values
                float compressionFactor = 1.0 / ( 1.0 + ( excessRatio - 1.0 ) * 0.5 );
                envValue *= compressionFactor;
                importance *= compressionFactor;
                confidence = mix( 0.6, 1.0, 1.0 / excessRatio );
            }
        }
    }

    // Calculate sample confidence based on multiple factors
    confidence *= noiseReduction;
    confidence *= clamp( pdf * 1000.0, 0.1, 1.0 ); // Low PDF = low confidence
    confidence *= clamp( 1.0 - float( bounceIndex ) * 0.15, 0.2, 1.0 ); // Deep bounces = lower confidence

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

float envMapSamplingPDFWithContext(
    vec3 direction,
    int bounceIndex,
    RayTracingMaterial material,
    vec3 viewDirection,
    vec3 normal
) {
    float mipLevel, adaptiveBias, noiseReduction;
    determineEnvSamplingQuality( bounceIndex, material, viewDirection, normal, mipLevel, adaptiveBias, noiseReduction );
    return calculateEnhancedPDF( direction, mipLevel, adaptiveBias, noiseReduction );
}

float envMapSamplingPDF( vec3 direction ) {
    return calculateEnhancedPDF( direction, 0.0, envSamplingBias, 1.0 );
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