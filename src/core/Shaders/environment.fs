uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
    // Use precomputed PI_INV constant
    return vec2( 
		atan( direction.z, direction.x ) * ( 0.5 * PI_INV ) + 0.5,
        1.0 - acos( direction.y ) * PI_INV 
	);
}

vec4 sampleEnvironment(vec3 direction) {

	if (!enableEnvironmentLight) {

        return vec4(0.0);

    }

    vec2 uv = directionToUV(direction);
    vec4 texSample = texture(environment, uv);
    
    // Calculate PDF based on solid angle and luminance
    float sinTheta = sin(uv.y * PI);
    // float lumValue = luminance(texSample.rgb);
    float lumValue = 10.0;
    
    // PDF = luminance / (2π²sin(θ))
    // Account for spherical distortion and prevent division by zero
    float pdf = max(lumValue, MIN_PDF) / (2.0 * PI * PI * max(sinTheta, MIN_PDF));
    
    return texSample / pdf;
}