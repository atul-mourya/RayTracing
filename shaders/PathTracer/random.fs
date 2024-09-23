uniform sampler2D blueNoiseTexture;
uniform vec3 spatioTemporalBlueNoiseReolution;

uint pcg_hash( uint state ) {
	state = state * 747796405u + 2891336453u;
	uint word = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
	word = ( word >> 22u ) ^ word;
	return word;
}

vec4 sampleBlueNoise( vec2 pixelCoords ) {
	vec3 sbtnr = spatioTemporalBlueNoiseReolution;
	vec2 textureSize = vec2( sbtnr.x, sbtnr.y * sbtnr.z );
	vec2 texCoord = ( pixelCoords + vec2( 0.5 ) ) / float( sbtnr.x );
	texCoord.y = ( texCoord.y + float( int( frame ) % int( sbtnr.z ) ) ) / float( sbtnr.z );
	vec4 noise = texture2D( blueNoiseTexture, texCoord );

  // Combine with PCG hash for extended variation by adding offest
	uint seed = uint( pixelCoords.x ) * 1973u + uint( pixelCoords.y ) * 9277u + uint( frame ) * 26699u;
	float random = float( pcg_hash( seed ) ) / 4294967295.0;

	return fract( noise + random ); // Combine blue noise with PCG hash
}

float RandomValue( inout uint state ) {
	state = pcg_hash( state );
	return float( state ) / 4294967296.0;
}

// Random value in normal distribution (with mean=0 and sd=1)
float RandomValueNormalDistribution( inout uint state ) {
	// Thanks to https://stackoverflow.com/a/6178290
	float theta = 2.0 * 3.1415926 * RandomValue( state );
	float rho = sqrt( - 2.0 * log( RandomValue( state ) ) );
	return rho * cos( theta );
}

// Calculate a random direction.
// Note: there are many alternative methods for computing this,
// with varying trade-offs between speed and accuracy.
vec3 RandomDirection( inout uint state ) {
	// Thanks to https://math.stackexchange.com/a/1585996
	float x = RandomValueNormalDistribution( state );
	float y = RandomValueNormalDistribution( state );
	float z = RandomValueNormalDistribution( state );
	return normalize( vec3( x, y, z ) );
}

vec3 RandomHemiSphereDirection( vec3 normal, inout uint rngState ) {
	vec3 dir = RandomDirection( rngState );
	dir = dir * sign( dot( normal, dir ) );
	return dir;
}

vec3 BlueNoiseRandomDirection( vec2 pixelCoords, int sampleIndex, int bounceIndex ) {
	vec4 blueNoise = sampleBlueNoise( pixelCoords + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );

	float theta = 2.0 * PI * blueNoise.x;
	float phi = acos( 2.0 * blueNoise.y - 1.0 );

	float x = sin( phi ) * cos( theta );
	float y = sin( phi ) * sin( theta );
	float z = cos( phi );

	return normalize( vec3( x, y, z ) );
}

vec3 BlueNoiseRandomHemisphereDirection( vec3 normal, vec2 pixelCoords, int sampleIndex, int bounceIndex ) {
	vec3 dir = BlueNoiseRandomDirection( pixelCoords, sampleIndex, bounceIndex );
	return dir * sign( dot( normal, dir ) );
}

vec2 RandomPointInCircle( inout uint rngState ) {
	float angle = RandomValue( rngState ) * 2.0 * PI;
	vec2 pointOnCircle = vec2( cos( angle ), sin( angle ) );
	return pointOnCircle * sqrt( RandomValue( rngState ) );
}

vec3 RandomPointInCircle3( inout uint rngState ) {
	float angle = 2.0 * PI * RandomValue( rngState );
	float radius = sqrt( RandomValue( rngState ) );
	return vec3( radius * cos( angle ), radius * sin( angle ), 0.0 );
}

// Halton sequence generator
float halton( int index, int base ) {
	float result = 0.0;
	float f = 1.0;
	int i = index;
	while( i > 0 ) {
		f /= float( base );
		result += f * float( i % base );
		i = int( floor( float( i ) / float( base ) ) );
	}
	return result;
}

// Quasi-random 2D sample
vec2 QuasiRandomSample2D( int sampleIndex, int pixelIndex ) {
	return vec2( halton( sampleIndex, 2 ), halton( sampleIndex, 3 ) );
}

// Hybrid quasi-random and pseudo-random 2D sample
vec2 HybridRandomSample2D( inout uint state, int sampleIndex, int pixelIndex ) {
	vec2 quasi = QuasiRandomSample2D( sampleIndex, pixelIndex );
	vec2 pseudo = vec2( RandomValue( state ), RandomValue( state ) );
	return fract( quasi + pseudo ); // Combine and wrap to [0, 1)
}

// Quasi-random direction on a hemisphere
vec3 QuasiRandomHemisphereDirection( vec3 normal, int sampleIndex, int pixelIndex ) {
	vec2 s = QuasiRandomSample2D( sampleIndex, pixelIndex );

	float cosTheta = sqrt( 1.0 - s.x );
	float sinTheta = sqrt( s.x );
	float phi = 2.0 * PI * s.y;

	vec3 tangentSpaceDir = vec3( cos( phi ) * sinTheta, sin( phi ) * sinTheta, cosTheta );

	// Convert tangent space direction to world space
	vec3 tangent = normalize( cross( normal, vec3( 0.0, 1.0, 0.0 ) ) );
	vec3 bitangent = cross( normal, tangent );
	return tangent * tangentSpaceDir.x + bitangent * tangentSpaceDir.y + normal * tangentSpaceDir.z;
}

// Hybrid quasi-random and pseudo-random direction on a hemisphere
vec3 HybridRandomHemisphereDirection( vec3 normal, inout uint state, int sampleIndex, int pixelIndex ) {
	vec2 s = HybridRandomSample2D( state, sampleIndex, pixelIndex );

	float cosTheta = sqrt( 1.0 - s.x );
	float sinTheta = sqrt( s.x );
	float phi = 2.0 * PI * s.y;

	vec3 tangentSpaceDir = vec3( cos( phi ) * sinTheta, sin( phi ) * sinTheta, cosTheta );

	// Convert tangent space direction to world space
	vec3 tangent = normalize( cross( normal, vec3( 0.0, 1.0, 0.0 ) ) );
	vec3 bitangent = cross( normal, tangent );
	return tangent * tangentSpaceDir.x + bitangent * tangentSpaceDir.y + normal * tangentSpaceDir.z;
}

vec2 getRandomSample( vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState ) {
	if( useBlueNoise ) {
		return sampleBlueNoise( pixelCoord + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) ).xy;
	} else {
		return HybridRandomSample2D( rngState, sampleIndex, int( pixelCoord.x ) + int( pixelCoord.y ) * int( resolution.x ) );
	}
}

vec4 getRandomSample4( vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState ) {
	if( useBlueNoise ) {
		return sampleBlueNoise( pixelCoord + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );
	} else {
		return vec4( HybridRandomSample2D( rngState, sampleIndex, int( pixelCoord.x ) + int( pixelCoord.y ) * int( resolution.x ) ), HybridRandomSample2D( rngState, sampleIndex + 1, int( pixelCoord.x ) + int( pixelCoord.y ) * int( resolution.x ) ) );
	}
}