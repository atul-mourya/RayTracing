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

// Pre-computed rotation matrix for environment
mat3 envRotationMatrix;
mat3 envRotationMatrixInverse;

// Initialize rotation matrices (call this when environmentRotation changes)
void initializeEnvironmentRotation( ) {
    float cosA = cos( environmentRotation );
    float sinA = sin( environmentRotation );

    // Rotation matrix around Y axis
    envRotationMatrix = mat3( cosA, 0.0, - sinA, 0.0, 1.0, 0.0, sinA, 0.0, cosA );

    // Inverse rotation matrix
    envRotationMatrixInverse = mat3( cosA, 0.0, sinA, 0.0, 1.0, 0.0, - sinA, 0.0, cosA );
}

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
    // Apply pre-computed rotation matrix
    vec3 rotatedDir = envRotationMatrix * direction;

    // Use precomputed PI_INV constant
    return vec2( atan( rotatedDir.z, rotatedDir.x ) * ( 0.5 * PI_INV ) + 0.5, 1.0 - acos( rotatedDir.y ) * PI_INV );
}

// Convert UV coordinates to direction (reverse of directionToUV)
vec3 uvToDirection( vec2 uv ) {
    float phi = ( uv.x - 0.5 ) * 2.0 * PI;
    float theta = uv.y * PI;

    float sinTheta = sin( theta );
    vec3 localDir = vec3( sinTheta * cos( phi ), cos( theta ), sinTheta * sin( phi ) );

    // Apply inverse rotation to get world direction
    return envRotationMatrixInverse * localDir;
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

    // Use texture sampling instead of texelFetch for better interpolation
    vec2 uvMargin = vec2( u, 1.0 - 0.5 / envCDFSize.y );
    vec4 cdfMarginData = texture( envCDF, uvMargin );

    // Sample v coordinate (conditional on u)
    float v = xi.y;
    vec2 uvConditional = vec2( u, 1.0 - v * ( 1.0 - 1.0 / envCDFSize.y ) );

    // Convert to UV coordinates
    vec2 envUV = vec2( u, v );

    // Convert UV to direction using pre-computed inverse rotation
    result.direction = uvToDirection( envUV );

    // Get environment color
    result.value = sampleEnvironment( result.direction ).rgb;

    // Calculate PDF - fix the texture sampling for PDF
    float pdfU = texture( envCDF, vec2( u, 1.0 - 0.5 / envCDFSize.y ) ).g;
    float pdfV = texture( envCDF, vec2( u, 1.0 - v * ( 1.0 - 1.0 / envCDFSize.y ) ) ).g;

    float theta = envUV.y * PI;
    float sinTheta = sin( theta );
    float jacobian = max( 2.0 * PI * PI * sinTheta, 1e-8 );

    result.pdf = pdfU * pdfV * envCDFSize.x * ( envCDFSize.y - 1.0 ) / jacobian;

    return result;
}

// Get PDF for a given direction when using environment importance sampling
float envMapSamplingPDF( vec3 direction ) {
    // Convert direction to UV using pre-computed rotation
    vec2 uv = directionToUV( direction );

    // Sample with linear interpolation
    float pdfU = texture( envCDF, vec2( uv.x, 1.0 - 0.5 / envCDFSize.y ) ).g;
    float pdfV = texture( envCDF, vec2( uv.x, 1.0 - uv.y * ( 1.0 - 1.0 / envCDFSize.y ) ) ).g;

    float theta = acos( clamp( direction.y, - 1.0, 1.0 ) );
    float sinTheta = sin( theta );
    float jacobian = max( 2.0 * PI * PI * sinTheta, 1e-8 );

    return pdfU * pdfV * envCDFSize.x * ( envCDFSize.y - 1.0 ) / jacobian;
}