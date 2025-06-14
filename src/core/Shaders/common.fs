const float PI = 3.14159;
const float PI_INV = 1.0 / PI;
const float TWO_PI = 2.0 * PI;
const float EPSILON = 1e-6;
const float MIN_ROUGHNESS = 0.05;
const float MAX_ROUGHNESS = 1.0;
const float MIN_PDF = 0.001;
const vec3 REC709_LUMINANCE_COEFFICIENTS = vec3( 0.2126, 0.7152, 0.0722 );

vec3 sRGBToLinear( vec3 srgbColor ) {
    return pow( srgbColor, vec3( 2.2 ) );
}

vec3 gammaCorrection( vec3 color ) {
    return pow( color, vec3( 1.0 / 2.2 ) );
}

// XYZ to sRGB color space conversion matrix
const mat3 XYZ_TO_REC709 = mat3(
    3.2404542, -0.9692660,  0.0556434,
    -1.5371385,  1.8760108, -0.2040259,
    -0.4985314,  0.0415560,  1.0572252
);

float square( float x ) {
    return x * x;
}

vec3 square( vec3 x ) {
    return x * x;
}

// Get maximum component of a vector
float maxComponent( vec3 v ) {
    return max( max( v.r, v.g ), v.b );
}

// Get minimum component of a vector  
float minComponent( vec3 v ) {
    return min( min( v.r, v.g ), v.b );
}

// Get luminance of a color
// float luminance( vec3 color ) {
//     return dot( color, REC709_LUMINANCE_COEFFICIENTS );
// }

// Optimized power heuristic for multiple importance sampling
float powerHeuristic( float pdf1, float pdf2 ) {
    // Fast path for clearly dominant PDF with more aggressive early exit
    float ratio = pdf1 / max( pdf2, MIN_PDF );

    if( ratio > 10.0 )
        return 1.0;
    if( ratio < 0.1 )
        return 0.0;

    // Additional fast paths for common cases
    if( ratio > 5.0 )
        return 0.95;
    if( ratio < 0.2 )
        return 0.05;

    // Standard power heuristic calculation for intermediate cases
    float p1 = pdf1 * pdf1;
    float p2 = pdf2 * pdf2;
    return p1 / max( ( p1 + p2 ), MIN_PDF );
}

vec3 applyDithering( vec3 color, vec2 uv, float ditheringAmount ) {
    // Bayer matrix for 4x4 dithering pattern
    const mat4 bayerMatrix = mat4( 0.0 / 16.0, 8.0 / 16.0, 2.0 / 16.0, 10.0 / 16.0, 12.0 / 16.0, 4.0 / 16.0, 14.0 / 16.0, 6.0 / 16.0, 3.0 / 16.0, 11.0 / 16.0, 1.0 / 16.0, 9.0 / 16.0, 15.0 / 16.0, 7.0 / 16.0, 13.0 / 16.0, 5.0 / 16.0 );

    ivec2 pixelCoord = ivec2( uv * resolution );
    float dither = bayerMatrix[ pixelCoord.x % 4 ][ pixelCoord.y % 4 ];

    return color + ( dither - 0.5 ) * ditheringAmount / 255.0;
}

vec3 reduceFireflies( vec3 color, float maxValue ) {
    float lum = luminance( color );
    if( lum > maxValue ) {
        color *= maxValue / lum;
    }
    return color;
}

mat3 constructTBN( vec3 N ) {
    // Create tangent and bitangent vectors
    vec3 majorAxis = abs( N.x ) < 0.999 ? vec3( 1, 0, 0 ) : vec3( 0, 1, 0 );
    vec3 T = normalize( cross( N, majorAxis ) );
    vec3 B = normalize( cross( N, T ) );
    return mat3( T, B, N );
}

DotProducts computeDotProducts( vec3 N, vec3 V, vec3 L ) {
    DotProducts dots;
    vec3 H = normalize( V + L );

    dots.NoL = max( dot( N, L ), 0.001 );
    dots.NoV = max( dot( N, V ), 0.001 );
    dots.NoH = max( dot( N, H ), 0.001 );
    dots.VoH = max( dot( V, H ), 0.001 );
    dots.LoH = max( dot( L, H ), 0.001 );

    return dots;
}

float calculateFireflyThreshold(
    float baseThreshold,
    float contextMultiplier,
    int bounceIndex
) {
    float depthFactor = 1.0 / pow(float(bounceIndex + 1), 0.5);
    return baseThreshold * contextMultiplier * depthFactor;
}

// Apply soft suppression to prevent harsh clipping
float applySoftSuppression(
    float value,
    float threshold,
    float dampingFactor
) {
    if(value <= threshold) return value;
    float excess = value - threshold;
    float suppressionFactor = threshold / (threshold + excess * dampingFactor);
    return value * suppressionFactor;
}

// Apply soft suppression to RGB color while preserving hue
vec3 applySoftSuppressionRGB(
    vec3 color,
    float threshold,
    float dampingFactor
) {
    float lum = luminance(color);
    if(lum <= threshold) return color;
    float suppressedLum = applySoftSuppression(lum, threshold, dampingFactor);
    return color * (suppressedLum / lum);
}

// Get material-specific firefly tolerance multiplier
float getMaterialFireflyTolerance(RayTracingMaterial material) {
    float tolerance = 1.0;
    
    // Metals can handle brighter values legitimately
    tolerance *= mix(1.0, 1.5, step(0.7, material.metalness));
    
    // Rough surfaces need less aggressive clamping
    tolerance *= mix(0.8, 1.2, material.roughness);
    
    // Transmissive materials have different brightness characteristics
    tolerance *= mix(1.0, 0.9, material.transmission);
    
    return tolerance;
}

// Calculate view-dependent firefly tolerance for specular materials
float getViewDependentTolerance(
    RayTracingMaterial material,
    vec3 sampleDir,
    vec3 viewDir,
    vec3 normal
) {
    float tolerance = 1.0;
    
    // For very smooth materials, allow brighter values in specular direction
    if(material.roughness < 0.2) {
        vec3 reflectDir = reflect(-viewDir, normal);
        float specularAlignment = max(0.0, dot(sampleDir, reflectDir));
        float viewDependentScale = mix(1.0, 2.5, pow(specularAlignment, 4.0));
        tolerance *= viewDependentScale;
    }
    
    return tolerance;
}