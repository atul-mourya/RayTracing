const float PI = 3.14159;
const float EPSILON = 0.001;

// Lerp function (linear interpolation)
vec3 lerp( vec3 a, vec3 b, float t ) {
	return a + t * ( b - a );
}

float inverseLerp( float v, float minValue, float maxValue ) {
	return ( v - minValue ) / ( maxValue - minValue );
}

float remap( float v, float inMin, float inMax, float outMin, float outMax ) {
	float t = inverseLerp( v, inMin, inMax );
	return mix( outMin, outMax, t );
}

vec3 sRGBToLinear( vec3 srgbColor ) {
	return pow( srgbColor, vec3( 2.2 ) );
}

vec3 linearTosRGB( vec3 value ) {
	vec3 lt = vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) );

	vec3 v1 = value * 12.92;
	vec3 v2 = pow( value.xyz, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 );

	return mix( v2, v1, lt );
}

vec3 gammaCorrection(vec3 color) {
	return pow(color, vec3(1.0 / 2.2));
}

vec3 toneMapACESFilmic(vec3 color) {
	color *= 0.6;
	color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
	return pow(color, vec3(1.0 / 2.2));
}

// float luminance( vec3 color ) {

// 	return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

// }

// power heuristic for multiple importance sampling
float powerHeuristic( float pdfA, float pdfB ) {
	float a = pdfA * pdfA;
	float b = pdfB * pdfB;
	return a / ( a + b );
}

vec3 applyDithering(vec3 color, vec2 uv, float ditheringAmount) {
    // Bayer matrix for 4x4 dithering pattern
    const mat4 bayerMatrix = mat4(
        0.0/16.0, 8.0/16.0, 2.0/16.0, 10.0/16.0,
        12.0/16.0, 4.0/16.0, 14.0/16.0, 6.0/16.0,
        3.0/16.0, 11.0/16.0, 1.0/16.0, 9.0/16.0,
        15.0/16.0, 7.0/16.0, 13.0/16.0, 5.0/16.0
    );
    
    ivec2 pixelCoord = ivec2(uv * resolution);
    float dither = bayerMatrix[pixelCoord.x % 4][pixelCoord.y % 4];
    
    return color + (dither - 0.5) * ditheringAmount / 255.0;
}

vec3 reduceFireflies( vec3 color, float maxValue ) {
	float luminance = dot( color, vec3( 0.299, 0.587, 0.114 ) );
	if( luminance > maxValue ) {
		color *= maxValue / luminance;
	}
	return color;
}