uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;

uniform EquirectHdrInfo envMapInfo;


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


// samples the the given environment map in the given direction
vec3 sampleEquirectColor( sampler2D envMap, vec3 direction ) {

	return texture2D( envMap, directionToTextureCoordinate( direction ) ).rgb;

}

// gets the pdf of the given direction to sample
float equirectDirectionPdf( vec3 direction ) {

	vec2 uv = directionToTextureCoordinate( direction );
	float theta = uv.y * PI;
	float sinTheta = sin( theta );
	if ( sinTheta == 0.0 ) {

		return 0.0;

	}

	return 1.0 / ( 2.0 * PI * PI * sinTheta );

}

// samples the color given env map with CDF and returns the pdf of the direction
float sampleEquirect( vec3 direction, inout vec3 color ) {

	float totalSum = envMapInfo.totalSum;
	if ( totalSum == 0.0 ) {

		color = vec3( 0.0 );
		return 1.0;

	}

	vec2 uv = directionToTextureCoordinate( direction );
	color = texture2D( environment, uv ).rgb;

	float lum = luminance( color );
	ivec2 resolution = textureSize( environment, 0 );
	float pdf = lum / totalSum;

	// pdf = max( pdf, 0.001 );  // Ensure BRDF PDF is never zero

	return float( resolution.x * resolution.y ) * pdf * equirectDirectionPdf( direction );

}

vec3 equirectUvToDirection( vec2 uv ) {

	// undo above adjustments
	uv.x -= 0.5;
	uv.y = 1.0 - uv.y;

	// from Vector3.setFromSphericalCoords
	float theta = uv.x * 2.0 * PI;
	float phi = uv.y * PI;

	float sinPhi = sin( phi );

	return vec3( sinPhi * cos( theta ), cos( phi ), sinPhi * sin( theta ) );

}

// samples a direction of the envmap with color and retrieves pdf
float sampleEquirectProbability( vec2 r, inout vec3 color, inout vec3 direction ) {

	// sample env map cdf
	float v = texture2D( envMapInfo.marginalWeights, vec2( r.x, 0.0 ) ).x;
	float u = texture2D( envMapInfo.conditionalWeights, vec2( r.y, v ) ).x;
	vec2 uv = vec2( u, v );

	vec3 derivedDirection = equirectUvToDirection( uv );
	direction = derivedDirection;
	color = texture2D( environment, uv ).rgb;

	float totalSum = envMapInfo.totalSum;
	float lum = luminance( color );
	ivec2 resolution = textureSize( environment, 0 );
	float pdf = lum / totalSum;

	// pdf = max( pdf, 0.001 );  // Ensure BRDF PDF is never zero

	return float( resolution.x * resolution.y ) * pdf * equirectDirectionPdf( direction );

}

const float MIN_PDF = 0.001;
const float lightsDenom = 1.0;

vec3 sampleEnvironment(vec3 direction, int bounceIndex) {
    if (!enableEnvironmentLight) {
        return vec3(0.0);
    }

    vec2 uv = directionToTextureCoordinate(direction);
    vec3 color = texture2D(environment, uv).rgb;

    if (bounceIndex == 0) {
        return color;
    }

	return color * environmentIntensity * PI;
}