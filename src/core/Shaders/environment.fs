uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;
uniform float exposure;

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
    // Use precomputed PI_INV constant
    return vec2( 
		atan( direction.z, direction.x ) * ( 0.5 * PI_INV ) + 0.5,
        1.0 - acos( direction.y ) * PI_INV 
	);
}

vec4 sampleEnvironment( vec3 direction ) {

    if( ! enableEnvironmentLight ) {

        return vec4( 0.0 );

    }

    vec2 uv = directionToUV( normalize( direction ) );
    vec4 texSample = texture( environment, uv );

    // Keep values in linear space, just apply basic intensity control
    float lumValue = luminance( texSample.rgb );

    // Softer scale for very bright areas to prevent harsh clipping
    float intensityScale = environmentIntensity * exposure;
    if( lumValue > 1.0 ) {
        intensityScale *= 1.0 / ( 1.0 + log( lumValue ) );
    }

    texSample.rgb *= intensityScale * texSample.a;
    return texSample;

}