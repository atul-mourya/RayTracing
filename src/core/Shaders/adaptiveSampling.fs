uniform int adaptiveSamplingMin;
uniform int adaptiveSamplingMax;
uniform float varianceThreshold;

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

// Optimized Welford's online variance algorithm
void updateVariance( inout AdaptiveSamplingState state, vec4 _sample ) {
    state.samples ++;
    vec4 delta = _sample - state.mean;
    state.mean += delta / float( state.samples );
    vec4 delta2 = _sample - state.mean;
    state.m2 += delta * delta2;

    if( state.samples > 1 ) {
        vec4 variance = state.m2 / float( state.samples - 1 );
        // Luminance-weighted variance for color samples
        state.variance = dot( variance.rgb, vec3( 0.299, 0.587, 0.114 ) );
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
    vec3 centerColor = texture2D( previousFrameTexture, pixelPos / resolution ).rgb;
    float totalVariance = 0.0;
    float weight = 0.0;

    // 3x3 neighborhood sampling with gaussian weights
    for( int i = - 1; i <= 1; i ++ ) {
        for( int j = - 1; j <= 1; j ++ ) {
            if( i == 0 && j == 0 )
                continue;

            vec2 offset = vec2( float( i ), float( j ) );
            vec2 samplePos = ( pixelPos + offset ) / resolution;
            vec3 neighborColor = texture2D( previousFrameTexture, samplePos ).rgb;

            // Gaussian weight based on distance
            float w = exp( - 0.5 * ( float( i * i + j * j ) / 2.0 ) );
            totalVariance += length( neighborColor - centerColor ) * w;
            weight += w;
        }
    }

    return totalVariance / max( weight, 0.001 );
}

// convergence check with gradient awareness
bool shouldContinueSampling( AdaptiveSamplingState state, vec3 pixelColor, float averageSceneLuminance ) {
    // Always do minimum samples
    if( state.samples < adaptiveSamplingMin ) {
        return true;
    }

    // Stop if we've hit maximum samples
    if( state.samples >= adaptiveSamplingMax ) {
        return false;
    }

    // Calculate adaptive threshold
    float threshold = calculateAdaptiveThreshold( pixelColor, averageSceneLuminance );

    // gradient detection with diagonal samples
    vec2 pixelPos = gl_FragCoord.xy;
    vec3 centerColor = pixelColor;
    vec3 rightColor = texture2D( previousFrameTexture, ( pixelPos + vec2( 1.0, 0.0 ) ) / resolution ).rgb;
    vec3 bottomColor = texture2D( previousFrameTexture, ( pixelPos + vec2( 0.0, 1.0 ) ) / resolution ).rgb;
    vec3 diagColor = texture2D( previousFrameTexture, ( pixelPos + vec2( 1.0, 1.0 ) ) / resolution ).rgb;

    // Calculate weighted gradient magnitude
    float horizGrad = length( rightColor - centerColor );
    float vertGrad = length( bottomColor - centerColor );
    float diagGrad = length( diagColor - centerColor ) * 0.707; // √2/2 weight for diagonal
    float gradientMagnitude = max( max( horizGrad, vertGrad ), diagGrad );

    // Adaptive threshold scaling based on gradient
    threshold *= mix( 1.0, 1.8, smoothstep( 0.0, 0.08, gradientMagnitude ) );

    // Consider local variance in convergence decision
    float localVariance = calculateLocalVariance( pixelPos, resolution );
    float varianceRatio = state.variance / max( localVariance, 0.0001 );

    // Adjust threshold based on variance ratio
    threshold *= mix( 0.8, 1.2, smoothstep( 0.5, 2.0, varianceRatio ) );

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