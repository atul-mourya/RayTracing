uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;
uniform float exposure;
uniform float environmentRotation;
uniform bool useEnvMapIS;
uniform sampler2D envCDF;    // Stores marginal and conditional CDFs
uniform vec2 envCDFSize;     // Size of the CDF texture

// Structure to store sampling results
struct EnvMapSample {
    vec3 direction;
    vec3 value;
    float pdf;
};

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
    // Apply rotation around Y axis
    float cosA = cos( environmentRotation );
    float sinA = sin( environmentRotation );

    // Rotate the direction vector around Y axis
    vec3 rotatedDir = vec3( direction.x * cosA - direction.z * sinA, direction.y, direction.x * sinA + direction.z * cosA );

    // Use precomputed PI_INV constant
    return vec2( atan( rotatedDir.z, rotatedDir.x ) * ( 0.5 * PI_INV ) + 0.5, 1.0 - acos( rotatedDir.y ) * PI_INV );
}

// Convert UV coordinates to direction (reverse of directionToUV)
vec3 uvToDirection( vec2 uv ) {
    float phi = ( uv.x - 0.5 ) * 2.0 * PI;
    float theta = uv.y * PI;

    float sinTheta = sin( theta );
    return vec3( sinTheta * cos( phi ), cos( theta ), sinTheta * sin( phi ) );
}

vec4 sampleEnvironment( vec3 direction ) {

    if( ! enableEnvironmentLight ) {

        return vec4( 0.0 );

    }

    vec2 uv = directionToUV( direction );
    vec4 texSample = texture( environment, uv );

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

// Sample the environment map using importance sampling
EnvMapSample sampleEnvironmentIS( vec2 xi ) {
    EnvMapSample result;

    // Sample u coordinate (integrated over v)
    float u = xi.x;
    int marginRow = int( envCDFSize.y - 1.0 );

    // Use texture sampling instead of texelFetch for better interpolation
    vec2 uvMargin = vec2( u, 1.0 - 0.5 / envCDFSize.y );
    vec4 cdfMarginData = texture( envCDF, uvMargin );
    float uCDF = cdfMarginData.r;

    // Sample v coordinate (conditional on u)
    float v = xi.y;
    vec2 uvConditional = vec2( u, 1.0 - v * ( 1.0 - 1.0 / envCDFSize.y ) );
    vec4 cdfConditionalData = texture( envCDF, uvConditional );
    float vCDF = cdfConditionalData.r;

    // Convert to UV coordinates - fix pixel center issues
    vec2 envUV = vec2( u, v );

    // Convert UV to direction with better precision
    float phi = ( envUV.x - 0.5 ) * 2.0 * PI;
    float theta = envUV.y * PI;

    vec3 direction = vec3( sin( theta ) * sin( phi ), cos( theta ), sin( theta ) * cos( phi ) );

    // Apply rotation correction
    float angle = - environmentRotation;
    result.direction = vec3( direction.x * cos( angle ) - direction.z * sin( angle ), direction.y, direction.x * sin( angle ) + direction.z * cos( angle ) );

    // Get environment color
    result.value = sampleEnvironment( result.direction ).rgb;

    // Calculate PDF - fix the texture sampling for PDF
    float pdfU = texture( envCDF, vec2( u, 1.0 - 0.5 / envCDFSize.y ) ).g;
    float pdfV = texture( envCDF, vec2( u, 1.0 - v * ( 1.0 - 1.0 / envCDFSize.y ) ) ).g;

    float sinTheta = sin( theta );
    float jacobian = max( 2.0 * PI * PI * sinTheta, 1e-8 );

    result.pdf = pdfU * pdfV * envCDFSize.x * ( envCDFSize.y - 1.0 ) / jacobian;

    return result;
}

// Get PDF for a given direction when using environment importance sampling
float envMapSamplingPDF( vec3 direction ) {
    // Apply inverse rotation first
    vec3 rotatedDir = vec3( direction.x * cos( environmentRotation ) - direction.z * sin( environmentRotation ), direction.y, direction.x * sin( environmentRotation ) + direction.z * cos( environmentRotation ) );

    // Convert to UV coordinates
    float phi = atan( rotatedDir.z, rotatedDir.x );
    if( phi < 0.0 )
        phi += 2.0 * PI;
    float theta = acos( clamp( rotatedDir.y, - 1.0, 1.0 ) );

    vec2 uv = vec2( phi / ( 2.0 * PI ), theta / PI );

    // Sample with linear interpolation
    float pdfU = texture( envCDF, vec2( uv.x, 1.0 - 0.5 / envCDFSize.y ) ).g;
    float pdfV = texture( envCDF, vec2( uv.x, 1.0 - uv.y * ( 1.0 - 1.0 / envCDFSize.y ) ) ).g;

    float sinTheta = sin( theta );
    float jacobian = max( 2.0 * PI * PI * sinTheta, 1e-8 );

    return pdfU * pdfV * envCDFSize.x * ( envCDFSize.y - 1.0 ) / jacobian;
}
