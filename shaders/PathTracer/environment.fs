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

vec3 sampleEnvironment( vec3 direction ) {
	if( ! enableEnvironmentLight )
		return vec3( 0.0 );

	vec2 uv = directionToTextureCoordinate( direction );
	vec3 color = texture2D( environment, uv ).rgb;

	color *= environmentIntensity;

	return color;
}
