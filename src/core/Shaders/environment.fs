uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;

// ray sampling x and z are swapped to align with expected background view
vec2 directionToTextureCoordinate( vec3 direction ) {

	// from Spherical.setFromCartesianCoords
	vec2 uv = vec2( atan( direction.z, direction.x ), acos( direction.y ) );
	uv /= vec2( 2.0 * PI, PI );

	// apply adjustments to get values in range [0, 1] and y right side up
	uv.x += 0.5;
	uv.y = 1.0 - uv.y;
	return uv;

}

vec3 sampleEnvironment( vec3 direction, int bounceIndex ) {
	if( ! enableEnvironmentLight ) {
		return vec3( 0.0 );
	}

	vec2 uv = directionToTextureCoordinate( direction );
	vec4 texel = texture2D( environment, uv );

	return texel.rgb * environmentIntensity * texel.a;
}

struct EnvMapSample {
	vec3 direction;
	vec3 value;
	float pdf;
};

// Convert a normalized direction to UV coordinates for environment sampling
vec2 directionToUV( vec3 direction ) {
	float phi = atan( direction.z, direction.x );
	float theta = acos( clamp( direction.y, - 1.0, 1.0 ) );

	vec2 uv = vec2( phi / ( 2.0 * PI ) + 0.5, theta / PI );
	return uv;
}

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
	result.direction = uvToDirection( vec2( phi / ( 2.0 * PI ) + 0.5, theta / PI ) );

    // Get color and calculate PDF
	vec2 uv = directionToUV( result.direction );
	vec4 texel = texture2D( environment, uv );
	result.value = texel.rgb * environmentIntensity;

	// Rec. 709 luminance calculation
	float luminance = dot( texel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	float sinTheta = sin( uv.y * PI );
	result.pdf = luminance / ( 2.0 * PI * PI * max( sinTheta, 0.001 ) );

	return result;
}