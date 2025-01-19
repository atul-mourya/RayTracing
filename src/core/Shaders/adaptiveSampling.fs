uniform bool useAdaptiveSampling;
uniform int adaptiveSamplingMin;
uniform int adaptiveSamplingMax;
uniform float adaptiveSamplingVarianceThreshold;
uniform sampler2D previousFrameTexture; // Texture from the previous frame
uniform sampler2D accumulatedFrameTexture; // texture of the accumulated frame for temporal anti-aliasing

// Gaussian weight function
float gaussian_weight( float dist, float sigma ) {
    return exp( - dist * dist / ( 2.0 * sigma * sigma ) );
}

struct AdaptiveSamplingResult {
    int samples;
    vec4 color;

};

// Get the number of samples required for this pixel based on variance
// use the current pixel index to get the previous frame color
// use the current pixel index to get the accumulated frame color. also look at its neighboring pixels to get the variance from the previous frame
// calculate the variance between the previous frame and the accumulated frame
// if all the neighborColors are the same, the variance will be 0, in which case we should return the samples as zero and skip sampling
// if the variance is greater than the threshold, return the max samples
// if the variance is less than the threshold, return the min samples
// if the variance is between the min and max, return the number of samples that is proportional to the variance
// return the number of samples

AdaptiveSamplingResult adaptiveSamplingResult;

AdaptiveSamplingResult getRequiredSamples( int pixelIndex ) {
    vec2 texCoord = gl_FragCoord.xy / resolution;

    vec4 previousColor = texture2D( previousFrameTexture, texCoord );
    vec4 accumulatedColor = texture2D( accumulatedFrameTexture, texCoord );

    float variance = 0.0;
    bool allNeighborsSame = true;
    vec4 firstNeighborColor = texture2D( accumulatedFrameTexture, texCoord + vec2( - 1, - 1 ) / resolution );

    // Gaussian weights for 3x3 kernel
    float sigma = 1.0; // Adjust this value to control the influence of distant pixels
    float weightSum = 0.0;

    for( int x = - 1; x <= 1; x ++ ) {
        for( int y = - 1; y <= 1; y ++ ) {
            if( x == 0 && y == 0 )
                continue; // Skip center pixel

            vec2 offset = vec2( x, y ) / resolution;
            vec4 neighborColor = texture2D( accumulatedFrameTexture, texCoord + offset );

            // Calculate spatial weight based on distance from center
            float dist = length( vec2( x, y ) );
            float weight = gaussian_weight( dist, sigma );
            weightSum += weight;

            // Calculate color difference in YCoCg space
            vec3 diff = accumulatedColor.rgb - neighborColor.rgb;
            float colorDiff = length( diff );

            // Accumulate weighted variance
            variance += colorDiff * weight;

            // Check if pixels are significantly different
            if( colorDiff > 0.001 ) {
                allNeighborsSame = false;
            }
        }
    }

    // Normalize variance by weight sum
    variance /= weightSum;

    // Scale variance threshold based on luminance
    float luminanceAdaptiveThreshold = adaptiveSamplingVarianceThreshold * ( 0.5 + accumulatedColor.r );

    if( allNeighborsSame ) {
        adaptiveSamplingResult.samples = 0;
        adaptiveSamplingResult.color = accumulatedColor;
    } else if( variance > luminanceAdaptiveThreshold ) {
        adaptiveSamplingResult.samples = adaptiveSamplingMax;
        adaptiveSamplingResult.color = vec4( 0.0 );
    } else if( variance < luminanceAdaptiveThreshold * 0.5 ) {
        adaptiveSamplingResult.samples = adaptiveSamplingMin;
        adaptiveSamplingResult.color = vec4( 0.0 );
    } else {
        float t = ( variance - luminanceAdaptiveThreshold * 0.5 ) / ( luminanceAdaptiveThreshold * 0.5 );
        adaptiveSamplingResult.samples = int( mix( float( adaptiveSamplingMin ), float( adaptiveSamplingMax ), t ) );
        adaptiveSamplingResult.color = vec4( 0.0 );
    }

    return adaptiveSamplingResult;
}