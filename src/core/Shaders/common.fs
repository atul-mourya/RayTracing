const float PI = 3.14159;
const float PI_INV = 1.0 / PI;
const float TWO_PI = 2.0 * PI;
const float EPSILON = 1e-6;
const float MIN_ROUGHNESS = 0.05;
const float MIN_CLEARCOAT_ROUGHNESS = 0.089;
const float MAX_ROUGHNESS = 1.0;
const float MIN_PDF = 0.001;
const vec3 REC709_LUMINANCE_COEFFICIENTS = vec3( 0.2126, 0.7152, 0.0722 );
#define MATERIAL_SLOTS 27

uniform sampler2D materialTexture;
uniform ivec2 materialTexSize;

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
    float lum = dot( color, REC709_LUMINANCE_COEFFICIENTS );
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
    float depthFactor = 1.0 / pow( float( bounceIndex + 1 ), 0.5 );
    return baseThreshold * contextMultiplier * depthFactor;
}

// Apply soft suppression to prevent harsh clipping
float applySoftSuppression(
    float value,
    float threshold,
    float dampingFactor
) {
    if( value <= threshold )
        return value;
    float excess = value - threshold;
    float suppressionFactor = threshold / ( threshold + excess * dampingFactor );
    return value * suppressionFactor;
}

// Apply soft suppression to RGB color while preserving hue
vec3 applySoftSuppressionRGB(
    vec3 color,
    float threshold,
    float dampingFactor
) {
    float lum = dot( color, REC709_LUMINANCE_COEFFICIENTS );
    if( lum <= threshold )
        return color;
    float suppressedLum = applySoftSuppression( lum, threshold, dampingFactor );
    return color * ( suppressedLum / lum );
}

// Get material-specific firefly tolerance multiplier
float getMaterialFireflyTolerance( RayTracingMaterial material ) {
    float tolerance = 1.0;

    // Metals can handle brighter values legitimately
    tolerance *= mix( 1.0, 1.5, step( 0.7, material.metalness ) );

    // Rough surfaces need less aggressive clamping
    tolerance *= mix( 0.8, 1.2, material.roughness );

    // Transmissive materials have different brightness characteristics
    tolerance *= mix( 1.0, 0.9, material.transmission );
    
    // Dispersive materials need more aggressive clamping to reduce color noise
    tolerance *= mix( 1.0, 0.7, clamp( material.dispersion * 0.1, 0.0, 1.0 ) );

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
    if( material.roughness < 0.2 ) {
        vec3 reflectDir = reflect( - viewDir, normal );
        float specularAlignment = max( 0.0, dot( sampleDir, reflectDir ) );
        float viewDependentScale = mix( 1.0, 2.5, pow( specularAlignment, 4.0 ) );
        tolerance *= viewDependentScale;
    }

    return tolerance;
}

// Pre-computed material classification for faster branching - OPTIMIZED
MaterialClassification classifyMaterial( RayTracingMaterial material ) {
    MaterialClassification mc;

	// Use vectorized comparisons where possible
    vec4 materialProps = vec4( material.metalness, material.roughness, material.transmission, material.clearcoat );
    vec4 thresholds = vec4( 0.7, 0.8, 0.5, 0.5 );
    bvec4 highThreshold = greaterThan( materialProps, thresholds );

    mc.isMetallic = highThreshold.x;
    mc.isRough = highThreshold.y;
    mc.isSmooth = material.roughness < 0.3;
    mc.isTransmissive = highThreshold.z;
    mc.hasClearcoat = highThreshold.w;

	// Fast emissive check using squared magnitude (avoids dot product)
    float emissiveMag = material.emissive.x + material.emissive.y + material.emissive.z;
    mc.isEmissive = emissiveMag > 0.0;

    // Enhanced complexity score with better material importance weighting
    float baseComplexity = 0.15 * float( mc.isMetallic ) +
        0.25 * float( mc.isSmooth ) +
        0.45 * float( mc.isTransmissive ) + // Transmission paths are most expensive
        0.35 * float( mc.hasClearcoat ) +
        0.3 * float( mc.isEmissive );

	// Add material interaction complexity
    float interactionComplexity = 0.0;
    if( mc.isMetallic && mc.isSmooth )
        interactionComplexity += 0.15; // Perfect reflector
    if( mc.isTransmissive && mc.hasClearcoat )
        interactionComplexity += 0.2; // Complex layered material
    if( mc.isEmissive && ( mc.isTransmissive || mc.isMetallic ) )
        interactionComplexity += 0.1; // Light-emitting complex material

    mc.complexityScore = clamp( baseComplexity + interactionComplexity, 0.0, 1.0 );

    return mc;
}

// IMPROVEMENT: Dynamic MIS strategy based on material properties
MISStrategy selectOptimalMISStrategy( RayTracingMaterial material, int bounceIndex, vec3 throughput ) {
    MISStrategy strategy;

    float materialComplexity = classifyMaterial( material ).complexityScore;
    float throughputStrength = maxComponent( throughput );

    // Adaptive strategy based on material and path state
    if( material.roughness < 0.1 && material.metalness > 0.8 ) {
        // Highly specular materials - favor BRDF sampling
        strategy.brdfWeight = 0.7;
        strategy.lightWeight = 0.2;
        strategy.envWeight = 0.1;
        strategy.useBRDFSampling = true;
        strategy.useLightSampling = throughputStrength > 0.01;
        strategy.useEnvSampling = bounceIndex < 3;
    } else if( material.roughness > 0.7 ) {
        // Diffuse materials - favor light sampling
        strategy.brdfWeight = 0.3;
        strategy.lightWeight = 0.5;
        strategy.envWeight = 0.2;
        strategy.useBRDFSampling = true;
        strategy.useLightSampling = true;
        strategy.useEnvSampling = true; // Will be checked against enableEnvironmentLight where used
    } else {
        // Balanced approach for mixed materials
        strategy.brdfWeight = 0.4;
        strategy.lightWeight = 0.4;
        strategy.envWeight = 0.2;
        strategy.useBRDFSampling = true;
        strategy.useLightSampling = true;
        strategy.useEnvSampling = bounceIndex < 4; // Will be checked against enableEnvironmentLight where used
    }

    // Adjust based on bounce depth
    if( bounceIndex > 3 ) {
        strategy.lightWeight *= 0.7; // Reduce light sampling for deep bounces
        strategy.envWeight *= 0.8;
    }

    return strategy;
}

// Material data texture access functions
vec4 getDatafromDataTexture( sampler2D tex, ivec2 texSize, int stride, int sampleIndex, int dataOffset ) {
    int pixelIndex = stride * dataOffset + sampleIndex;
    return texelFetch( tex, ivec2( pixelIndex % texSize.x, pixelIndex / texSize.x ), 0 );
}

mat3 arrayToMat3( vec4 data1, vec4 data2 ) {
    return mat3( data1.xyz, vec3( data1.w, data2.xy ), vec3( data2.zw, 1.0 ) );
}

RayTracingMaterial getMaterial( int materialIndex ) {
    RayTracingMaterial material;

    vec4 data[ MATERIAL_SLOTS ];
    for( int i = 0; i < MATERIAL_SLOTS; i ++ ) {
        data[ i ] = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, i, MATERIAL_SLOTS );
    }

    material.color = vec4( data[ 0 ].rgb, 1.0 );
    material.metalness = data[ 0 ].a;
    material.emissive = data[ 1 ].rgb;
    material.roughness = data[ 1 ].a;
    material.ior = data[ 2 ].r;
    material.transmission = data[ 2 ].g;
    material.thickness = data[ 2 ].b;
    material.emissiveIntensity = data[ 2 ].a;

    material.attenuationColor = data[ 3 ].rgb;
    material.attenuationDistance = data[ 3 ].a;

    material.dispersion = data[ 4 ].r;
    material.visible = bool( data[ 4 ].g );
    material.sheen = data[ 4 ].b;
    material.sheenRoughness = data[ 4 ].a;

    material.sheenColor = data[ 5 ].rgb;

    material.specularIntensity = data[ 6 ].r;
    material.specularColor = data[ 6 ].gba;

    material.iridescence = data[ 7 ].r;
    material.iridescenceIOR = data[ 7 ].g;
    material.iridescenceThicknessRange = data[ 7 ].ba;

    material.albedoMapIndex = int( data[ 8 ].r );
    material.normalMapIndex = int( data[ 8 ].g );
    material.roughnessMapIndex = int( data[ 8 ].b );
    material.metalnessMapIndex = int( data[ 8 ].a );

    material.emissiveMapIndex = int( data[ 9 ].r );
    material.bumpMapIndex = int( data[ 9 ].g );
    material.clearcoat = data[ 9 ].b;
    material.clearcoatRoughness = data[ 9 ].a;

    material.opacity = data[ 10 ].r;
    material.side = int( data[ 10 ].g );
    material.transparent = bool( data[ 10 ].b );
    material.alphaTest = data[ 10 ].a;

    material.alphaMode = int( data[ 11 ].r );
    material.depthWrite = int( data[ 11 ].g );

    material.normalScale = vec2( data[ 11 ].b, data[ 11 ].b );
    material.bumpScale = data[ 12 ].r;
    material.displacementScale = data[ 12 ].g;
    material.displacementMapIndex = int( data[ 12 ].b );

    material.albedoTransform = arrayToMat3( data[ 13 ], data[ 14 ] );
    material.normalTransform = arrayToMat3( data[ 15 ], data[ 16 ] );
    material.roughnessTransform = arrayToMat3( data[ 17 ], data[ 18 ] );
    material.metalnessTransform = arrayToMat3( data[ 19 ], data[ 20 ] );
    material.emissiveTransform = arrayToMat3( data[ 21 ], data[ 22 ] );
    material.bumpTransform = arrayToMat3( data[ 23 ], data[ 24 ] );
    material.displacementTransform = arrayToMat3( data[ 25 ], data[ 26 ] );

    return material;
}