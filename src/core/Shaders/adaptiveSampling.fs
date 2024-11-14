
uniform int adaptiveSamplingMin;
uniform int adaptiveSamplingMax;
uniform float varianceThreshold;

// Improved adaptive sampling structure
struct AdaptiveSamplingState {
    vec4 mean;          // Running mean of the samples
    vec4 m2;            // Running M2 aggregator for variance
    float variance;     // Current variance estimate
    int samples;        // Number of samples taken
    bool converged;     // Whether the pixel has converged
};

// Initialize adaptive sampling state
AdaptiveSamplingState initAdaptiveSampling( ) {
    AdaptiveSamplingState state;
    state.mean = vec4( 0.0 );
    state.m2 = vec4( 0.0 );
    state.variance = 1e6;  // Start with high variance
    state.samples = 0;
    state.converged = false;
    return state;
}

// Update variance using Welford's online algorithm
// This is numerically more stable than the naive approach
void updateVariance( inout AdaptiveSamplingState state, vec4 _sample ) {
    state.samples ++;
    vec4 delta = _sample - state.mean;
    state.mean += delta / float( state.samples );
    vec4 delta2 = _sample - state.mean;
    state.m2 += delta * delta2;

    if( state.samples > 1 ) {
        vec4 variance = state.m2 / float( state.samples - 1 );
        // Use luminance-weighted variance for color samples
        state.variance = ( variance.r * 0.299 + variance.g * 0.587 + variance.b * 0.114 );
    }
}

// Calculate adaptive threshold based on scene characteristics
float calculateAdaptiveThreshold( vec3 pixelColor, float averageSceneLuminance ) {
    float pixelLuminance = dot( pixelColor, vec3( 0.299, 0.587, 0.114 ) );
    float relativeLuminance = pixelLuminance / ( averageSceneLuminance + 0.001 );

    // Adjust threshold based on pixel brightness
    float baseThreshold = varianceThreshold;
    float luminanceScale = mix( 1.0, 2.0, smoothstep( 0.0, 2.0, relativeLuminance ) );

    return baseThreshold * luminanceScale;
}

// Check if we should continue sampling
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

    // Add gradient-based variance adjustment
    vec2 pixelPos = gl_FragCoord.xy;
    vec3 centerColor = pixelColor;
    vec3 rightColor = texture2D( previousFrameTexture, ( pixelPos + vec2( 1.0, 0.0 ) ) / resolution ).rgb;
    vec3 bottomColor = texture2D( previousFrameTexture, ( pixelPos + vec2( 0.0, 1.0 ) ) / resolution ).rgb;

    float gradientMagnitude = length( rightColor - centerColor ) + length( bottomColor - centerColor );
    threshold *= mix( 1.0, 2.0, smoothstep( 0.0, 0.1, gradientMagnitude ) );

    return state.variance > threshold;
}

// Main adaptive sampling logic for path tracer
vec4 adaptivePathTrace( Ray ray, inout uint rngState, int pixelIndex ) {
    AdaptiveSamplingState state = initAdaptiveSampling( );
    vec4 finalColor = vec4( 0.0 );

    // Calculate average scene luminance (could be passed as uniform)
    float averageSceneLuminance = 1.0; // This should be calculated from previous frame

    while( ! state.converged ) {
        // Trace path and get sample
        vec4 _sample = Trace( ray, rngState, state.samples, pixelIndex );

        // Update statistics
        updateVariance( state, _sample );

        // Accumulate color
        finalColor = state.mean;

        // Check convergence
        state.converged = ! shouldContinueSampling( state, finalColor.rgb, averageSceneLuminance );
    }

    // Store sampling statistics for temporal reuse
    // This could be stored in a separate buffer for next frame
    float confidence = float( state.samples ) / float( adaptiveSamplingMax );

    return finalColor;
}