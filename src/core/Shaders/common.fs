const float PI = 3.14159;
const float PI_INV = 1.0 / PI;
const float EPSILON = 0.001;
const float MIN_ROUGHNESS = 0.05;
const float MAX_ROUGHNESS = 1.0;
const float MIN_PDF = 0.001;

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

// float luminance( vec3 color ) {

// 	return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

// }

// power heuristic for multiple importance sampling
float powerHeuristic( float pdf1, float pdf2 ) {
	// Fast path for clearly dominant PDF
    if( pdf1 > pdf2 * 100.0 )
        return 1.0;
    if( pdf2 > pdf1 * 100.0 )
        return 0.0;

    // Standard calculation for closer PDFs
    float p1 = pdf1 * pdf1;
    float p2 = pdf2 * pdf2;
    return p1 / ( p1 + p2 );
}

vec3 applyDithering( vec3 color, vec2 uv, float ditheringAmount ) {
    // Bayer matrix for 4x4 dithering pattern
    const mat4 bayerMatrix = mat4( 0.0 / 16.0, 8.0 / 16.0, 2.0 / 16.0, 10.0 / 16.0, 12.0 / 16.0, 4.0 / 16.0, 14.0 / 16.0, 6.0 / 16.0, 3.0 / 16.0, 11.0 / 16.0, 1.0 / 16.0, 9.0 / 16.0, 15.0 / 16.0, 7.0 / 16.0, 13.0 / 16.0, 5.0 / 16.0 );

    ivec2 pixelCoord = ivec2( uv * resolution );
    float dither = bayerMatrix[ pixelCoord.x % 4 ][ pixelCoord.y % 4 ];

    return color + ( dither - 0.5 ) * ditheringAmount / 255.0;
}

vec3 reduceFireflies( vec3 color, float maxValue ) {
    float luminance = dot( color, vec3( 0.299, 0.587, 0.114 ) );
    if( luminance > maxValue ) {
        color *= maxValue / luminance;
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
    dots.HoH = 1.0;

    return dots;
}