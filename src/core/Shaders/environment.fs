// Environment map uniforms
uniform bool enableEnvironmentLight;
uniform sampler2D environment;
uniform float environmentIntensity;
uniform mat4 environmentMatrix;
uniform bool useEnvMapIS;

// EquirectHdrInfo structure - matches three-gpu-pathtracer
uniform sampler2D envMarginalWeights;
uniform sampler2D envConditionalWeights;
uniform float envTotalSum;
uniform ivec2 envResolution; // Resolution of environment map

/**
 * Convert direction to UV coordinates for equirectangular map
 * Exact implementation from three-gpu-pathtracer
 */
vec2 equirectDirectionToUv( vec3 direction ) {

	// Apply environment matrix rotation
	vec3 d = normalize( ( environmentMatrix * vec4( direction, 0.0 ) ).xyz );

	// Convert to spherical coordinates
	vec2 uv = vec2( atan( d.z, d.x ), acos( d.y ) );
	uv /= vec2( 2.0 * PI, PI );

	// Adjust to [0, 1] range and flip Y
	uv.x += 0.5;
	uv.y = 1.0 - uv.y;

	return uv;

}

/**
 * Convert UV coordinates to direction
 * Exact implementation from three-gpu-pathtracer
 */
vec3 equirectUvToDirection( vec2 uv ) {

	// Undo UV adjustments
	uv.x -= 0.5;
	uv.y = 1.0 - uv.y;

	// Convert from spherical coordinates
	float theta = uv.x * 2.0 * PI;
	float phi = uv.y * PI;

	float sinPhi = sin( phi );

	vec3 localDir = vec3( sinPhi * cos( theta ), cos( phi ), sinPhi * sin( theta ) );

	// Apply inverse environment matrix rotation
	// Using transpose for orthogonal rotation matrix (faster than inverse)
	mat4 transposed = mat4(
		environmentMatrix[0][0], environmentMatrix[1][0], environmentMatrix[2][0], environmentMatrix[3][0],
		environmentMatrix[0][1], environmentMatrix[1][1], environmentMatrix[2][1], environmentMatrix[3][1],
		environmentMatrix[0][2], environmentMatrix[1][2], environmentMatrix[2][2], environmentMatrix[3][2],
		environmentMatrix[0][3], environmentMatrix[1][3], environmentMatrix[2][3], environmentMatrix[3][3]
	);
	return normalize( ( transposed * vec4( localDir, 0.0 ) ).xyz );

}

/**
 * Sample environment map color in a given direction
 */
vec3 sampleEquirectColor( vec3 direction ) {

	return texture2D( environment, equirectDirectionToUv( direction ) ).rgb;

}

/**
 * Calculate PDF for uniform sphere sampling with Jacobian
 */
float equirectDirectionPdf( vec3 direction ) {

	vec2 uv = equirectDirectionToUv( direction );
	float theta = uv.y * PI;
	float sinTheta = sin( theta );

	if ( sinTheta == 0.0 ) {

		return 0.0;

	}

	return 1.0 / ( 2.0 * PI * PI * sinTheta );

}

/**
 * Evaluate PDF for a given direction (for MIS)
 * Exact implementation from three-gpu-pathtracer
 */
float sampleEquirect( vec3 direction, inout vec3 color ) {

	float totalSum = envTotalSum;
	if ( totalSum == 0.0 ) {

		color = vec3( 0.0 );
		return 0.0; // Exclude black environments from MIS

	}

	vec2 uv = equirectDirectionToUv( direction );
	color = texture2D( environment, uv ).rgb;

	float lum = dot( color, REC709_LUMINANCE_COEFFICIENTS );
	float pdf = lum / totalSum;

	return float( envResolution.x * envResolution.y ) * pdf * equirectDirectionPdf( direction );

}

/**
 * Sample environment map using importance sampling
 * Returns PDF, outputs color and direction
 * Exact implementation from three-gpu-pathtracer
 */
float sampleEquirectProbability( vec2 r, inout vec3 color, inout vec3 direction ) {

	// Sample marginal CDF for V coordinate
	float v = texture2D( envMarginalWeights, vec2( r.x, 0.0 ) ).x;

	// Sample conditional CDF for U coordinate
	float u = texture2D( envConditionalWeights, vec2( r.y, v ) ).x;

	vec2 uv = vec2( u, v );

	// Convert UV to direction
	vec3 derivedDirection = equirectUvToDirection( uv );
	direction = derivedDirection;
	color = texture2D( environment, uv ).rgb * environmentIntensity;

	// Calculate PDF
	float totalSum = envTotalSum;
	float lum = dot( color / environmentIntensity, REC709_LUMINANCE_COEFFICIENTS );
	float pdf = lum / totalSum;

	return float( envResolution.x * envResolution.y ) * pdf * equirectDirectionPdf( direction );

}

// Note: misHeuristic() is defined in lights_core.fs

/**
 * Simple environment lookup (no importance sampling)
 */
vec4 sampleEnvironment( vec3 direction ) {

	if ( ! enableEnvironmentLight ) {

		return vec4( 0.0 );

	}

	vec2 uv = equirectDirectionToUv( direction );
	vec4 texSample = texture2D( environment, uv );

	return texSample * environmentIntensity;

}
