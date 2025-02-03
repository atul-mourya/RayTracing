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

vec4 sampleEnvironment( vec3 direction ) {
	if( ! enableEnvironmentLight ) {
		return vec4( 0.0, 0.0, 0.0, 1.0 );
	}

	vec2 uv = directionToUV( direction );
	vec4 texel = texture( environment, uv );
	texel.rgb *= environmentIntensity;
	return texel;
}

struct EnvMapSample {
	vec3 direction;
	vec3 value;
	float pdf;
};

// Convert UV coordinates back to direction
vec3 uvToDirection( vec2 uv ) {
	float phi = ( uv.x * 2.0 - 1.0 ) * PI;
	float theta = uv.y * PI;

	float cosTheta = cos( theta );
	float sinTheta = sin( theta );
	float cosPhi = cos( phi );
	float sinPhi = sin( phi );

	return vec3( sinTheta * cosPhi, cosTheta, sinTheta * sinPhi );
}

// Sample the environment map using importance sampling
EnvMapSample sampleEnvironmentMap( vec2 xi ) {
	EnvMapSample result;

	if( ! enableEnvironmentLight ) {
		result.direction = vec3( 0.0, 1.0, 0.0 );
		result.value = vec3( 0.0 );
		result.pdf = 0.0;
		return result;
	}

    // Convert uniform random numbers to spherical coordinates
	float phi = 2.0 * PI * xi.x;
	float theta = PI * xi.y;

    // Convert to direction
	vec2 uv = vec2( phi / ( 2.0 * PI ) + 0.5, theta / PI );
	result.direction = uvToDirection( uv );
	result.value = sampleEnvironment( result.direction ).rgb;

	float luminance = 1.0; //dot( result.value, vec3( 0.2126, 0.7152, 0.0722 ) ); // Rec. 709 luminance calculation
	float sinTheta = sin( uv.y * PI );
	result.pdf = luminance / ( 2.0 * PI * PI * sinTheta );

	return result;
}