uniform int adaptiveSamplingMin; // use this to set the minimum number of samples before adaptive sampling kicks in
uniform int adaptiveSamplingMax; // use this to set the maximum number of samples before adaptive sampling stops
uniform float varianceThreshold; // Base threshold for adaptive sampling

// adaptive sampling structure
struct AdaptiveSamplingState {
    vec4 mean;          // Running mean of the samples
    vec4 m2;            // Running M2 aggregator for variance
    float variance;     // Current variance estimate
    float localVariance; // Local neighborhood variance
    int samples;        // Number of samples taken
    bool converged;     // Whether the pixel has converged
};

// Initialize adaptive sampling state
AdaptiveSamplingState initAdaptiveSampling( ) {
    AdaptiveSamplingState state;
    state.mean = vec4( 0.0 );
    state.m2 = vec4( 0.0 );
    state.variance = 1e6;  // Start with high variance
    state.localVariance = 0.0;
    state.samples = 0;
    state.converged = false;
    return state;
}

float calculateFrameCoherence( vec2 pixelPos, vec2 resolution ) {
    // Get current and previous frame colors
    vec2 uv = pixelPos / resolution;
    vec4 prevFrameColor = texture2D( previousFrameTexture, uv );

    // For renderMode 0, we can use temporal information more effectively
    if( renderMode == 0 ) {
        // Check temporal stability
        float frameDiff = 0.0;
        const int temporalKernel = 1; // Small kernel for efficiency

        for( int i = - temporalKernel; i <= temporalKernel; i ++ ) {
            for( int j = - temporalKernel; j <= temporalKernel; j ++ ) {
                vec2 offset = vec2( float( i ), float( j ) ) / resolution;
                vec4 neighborPrev = texture2D( previousFrameTexture, uv + offset );
                frameDiff += length( neighborPrev - prevFrameColor );
            }
        }

        // Normalize and convert to confidence value (0-1)
        float temporalStability = exp( - frameDiff * 2.0 );
        return temporalStability;
    }

    // For renderMode 1 (tiled), be more conservative
    return 0.5;
}

void updateVariance( inout AdaptiveSamplingState state, vec4 _sample ) {
    state.samples ++;

    // Clamp _samples to prevent numerical instability
    _sample = clamp( _sample, vec4( 0.0 ), vec4( 100.0 ) );

    // Regular variance update
    vec4 delta = _sample - state.mean;
    state.mean += delta / float( state.samples );

    if( state.samples > 1 ) {
        vec4 delta2 = _sample - state.mean;
        state.m2 += delta * delta2;

        vec4 variance = state.m2 / max( float( state.samples - 1 ), 1.0 );
        state.variance = clamp( dot( max( variance.rgb, vec3( 0.0 ) ), vec3( 0.299, 0.587, 0.114 ) ), 0.0, 100.0 );

        // Mode-specific variance adjustments
        if( renderMode == 0 ) {
            // For regular rendering, incorporate temporal feedback
            float temporalStability = calculateFrameCoherence( gl_FragCoord.xy, resolution );

            // Adjust variance based on temporal stability
            if( temporalStability > 0.9 && state.samples > adaptiveSamplingMin ) {
                // Reduce variance more quickly in stable regions
                state.variance *= 0.9;
            }
        }
    }
}

// Calculate adaptive threshold based on scene characteristics
float calculateAdaptiveThreshold( vec3 pixelColor, float averageSceneLuminance ) {
    float pixelLuminance = dot( pixelColor, vec3( 0.299, 0.587, 0.114 ) );
    float relativeLuminance = pixelLuminance / ( averageSceneLuminance + 0.001 );

    // Adjust threshold based on pixel brightness
    float baseThreshold = varianceThreshold;
    float luminanceScale = mix( 0.8, 1.5, smoothstep( 0.0, 1.5, relativeLuminance ) );

    // Add slight bias for very dark areas to prevent over-sampling
    float darkRegionBias = smoothstep( 0.0, 0.1, pixelLuminance ) * 0.2;

    return baseThreshold * luminanceScale + darkRegionBias;
}

// Calculate local variance using neighborhood samples
float calculateLocalVariance( vec2 pixelPos, vec2 resolution ) {
    // Ensure we stay within texture bounds
    vec2 uv = pixelPos / resolution;
    if( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) {
        return 1.0; // Return high variance for out-of-bounds
    }

    vec3 centerColor = texture2D( previousFrameTexture, uv ).rgb;
    float totalVariance = 0.0;
    float weight = 0.0;
    float maxDiff = 0.0;  // Track maximum difference for stability check

    // Use a smaller kernel for initial sampling
    const int KERNEL_SIZE = 2;
    for( int i = - KERNEL_SIZE; i <= KERNEL_SIZE; i ++ ) {
        for( int j = - KERNEL_SIZE; j <= KERNEL_SIZE; j ++ ) {
            if( i == 0 && j == 0 )
                continue;

            vec2 offset = vec2( float( i ), float( j ) );
            vec2 sampleUV = ( pixelPos + offset ) / resolution;

            // Bounds check
            if( sampleUV.x < 0.0 || sampleUV.x > 1.0 ||
                sampleUV.y < 0.0 || sampleUV.y > 1.0 )
                continue;

            vec3 neighborColor = texture2D( previousFrameTexture, sampleUV ).rgb;
            float diff = length( neighborColor - centerColor );
            maxDiff = max( maxDiff, diff );

            // Use a more conservative weighting function
            float w = 1.0 / ( 1.0 + float( i * i + j * j ) );
            totalVariance += diff * w;
            weight += w;
        }
    }

    // Fallback for potential division by zero
    if( weight < 0.001 ) {
        return 1.0; // Conservative estimate
    }

    float avgVariance = totalVariance / weight;

    // Stability check - if max difference is too high, be conservative
    if( maxDiff > 5.0 ) {
        return max( avgVariance, 0.5 ); // Ensure continued sampling for high-contrast areas
    }

    return avgVariance;
}

// convergence check with gradient awareness
bool shouldContinueSampling( AdaptiveSamplingState state, vec3 pixelColor, float averageSceneLuminance ) {
    // Early exit checks
    if( state.samples < adaptiveSamplingMin ) {
        return true;
    }
    if( state.samples >= adaptiveSamplingMax ) {
        return false;
    }

    // Get base threshold
    float threshold = calculateAdaptiveThreshold( pixelColor, averageSceneLuminance );

    // Adjust sampling strategy based on render mode
    if( renderMode == 0 ) {
        // For regular rendering, use temporal coherence
        float coherence = calculateFrameCoherence( gl_FragCoord.xy, resolution );

        // Adjust threshold based on temporal stability
        threshold *= mix( 0.8, 1.2, coherence );

        // Reduce samples in temporally stable regions
        if( coherence > 0.95 && state.samples > adaptiveSamplingMin * 2 ) {
            threshold *= 0.8; // More likely to stop sampling
        }

        // Check local contrast
        vec2 pixelPos = gl_FragCoord.xy;
        float localVariance = calculateLocalVariance( pixelPos, resolution );

        // In stable regions with low variance, be more aggressive about stopping
        if( localVariance < threshold * 0.5 && coherence > 0.9 ) {
            return false;
        }
    }

    // Standard variance check
    return state.variance > threshold;
}

// Main adaptive path tracing function
vec4 adaptivePathTrace( Ray ray, inout uint rngState, int pixelIndex ) {
    AdaptiveSamplingState state = initAdaptiveSampling( );
    vec4 finalColor = vec4( 0.0 );

    // Calculate average scene luminance (could be passed as uniform)
    float averageSceneLuminance = 1.0; // This should be calculated from previous frame

    // Adaptive sampling loop
    while( ! state.converged ) {
        // Trace path and get sample
        vec4 _sample = Trace( ray, rngState, state.samples, pixelIndex );

        // Update statistics
        updateVariance( state, _sample );

        // Accumulate color
        finalColor = state.mean;

        // Check convergence with enhanced criteria
        state.converged = ! shouldContinueSampling( state, finalColor.rgb, averageSceneLuminance );
    }

    // Store confidence value for potential temporal reuse
    float confidence = float( state.samples ) / float( adaptiveSamplingMax );

    return finalColor;
}