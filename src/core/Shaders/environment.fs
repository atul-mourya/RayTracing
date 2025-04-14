uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;
uniform float exposure;
uniform float environmentRotation;

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV(vec3 direction) {
    // Apply rotation around Y axis
    float angle = environmentRotation * PI * 2.0; // Convert 0-1 range to 0-2π
    float cosA = cos( angle );
    float sinA = sin( angle );
    
    // Rotate the direction vector around Y axis
    vec3 rotatedDir = vec3(
        direction.x * cosA - direction.z * sinA,
        direction.y,
        direction.x * sinA + direction.z * cosA
    );
    
    // Use precomputed PI_INV constant
    return vec2( 
        atan( rotatedDir.z, rotatedDir.x ) * ( 0.5 * PI_INV ) + 0.5,
        1.0 - acos( rotatedDir.y ) * PI_INV 
    );
}

vec4 sampleEnvironment( vec3 direction ) {

    if( ! enableEnvironmentLight ) {

        return vec4( 0.0 );

    }

    vec2 uv = directionToUV(direction);
    vec4 texSample = texture(environment, uv);

    float intensityScale = environmentIntensity * exposure;

    // Keep values in linear space, just apply basic intensity control
    float lumValue = luminance( texSample.rgb ) * intensityScale;

    // Softer scale for very bright areas to prevent harsh clipping
    if( lumValue > 1.0 ) {
        intensityScale *= 1.0 / ( 1.0 + log( lumValue ) );
    }

    texSample.rgb *= intensityScale * texSample.a;
    return texSample;

}