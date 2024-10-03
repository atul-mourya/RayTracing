uniform sampler2D spatioTemporalBlueNoiseTexture;
uniform vec3 spatioTemporalBlueNoiseReolution;
uniform sampler2D blueNoiseTexture;
uniform vec2 blueNoiseTextureResolution;
uniform int samplingTechnique; // 0: PCG, 1: Halton, 2: Sobol, 3: Blue Noise, 4: Stratified

// Sobol sequence implementation
const uint V[32] = uint[32](
    2147483648u, 1073741824u, 536870912u, 268435456u, 134217728u, 67108864u, 33554432u, 16777216u,
    8388608u, 4194304u, 2097152u, 1048576u, 524288u, 262144u, 131072u, 65536u,
    32768u, 16384u, 8192u, 4096u, 2048u, 1024u, 512u, 256u, 128u, 64u, 32u, 16u, 8u, 4u, 2u, 1u
);

// PCG hash function (already defined in your code)
uint pcg_hash(uint state) {
    state = state * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    word = (word >> 22u) ^ word;
    return word;
}

// Owen scrambling function
uint owen_scramble(uint x, uint seed) {
    x = x ^ (x * 0x3d20adeau);
    x += seed;
    x *= (seed >> 16) | 1u;
    x ^= x >> 15;
    x *= 0x5851f42du;
    x ^= x >> 12;
    x *= 0x4c957f2du;
    x ^= x >> 18;
    return x;
}

// Owen-scrambled Sobol sequence
float owen_scrambled_sobol(uint index, uint dimension, uint seed) {
    uint result = 0u;
    for (int i = 0; i < 32; ++i) {
        if ((index & (1u << i)) != 0u) {
            result ^= V[i] << dimension;
        }
    }
    result = owen_scramble(result, seed);
    return float(result) / 4294967296.0;
}

vec2 owen_scrambled_sobol2D(uint index, uint seed) {
    return vec2(
        owen_scrambled_sobol(index, 0u, seed),
        owen_scrambled_sobol(index, 1u, seed)
    );
}

vec4 sampleSBTN( vec2 pixelCoords ) {
	vec3 sbtnr = spatioTemporalBlueNoiseReolution;
	vec2 textureSize = vec2( sbtnr.x, sbtnr.y * sbtnr.z );
	vec2 texCoord = ( pixelCoords + vec2( 0.5 ) ) / float( sbtnr.x );
	texCoord.y = ( texCoord.y + float( int( frame ) % int( sbtnr.z ) ) ) / float( sbtnr.z );
	vec4 noise = texture2D( spatioTemporalBlueNoiseTexture, texCoord );

	// Combine with PCG hash for extended variation by adding offset
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
	vec4 blueNoise = sampleSBTN( pixelCoords + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );

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
	if( samplingTechnique == 1 ) {
		return vec2( halton( sampleIndex, 2 ), halton( sampleIndex, 3 ) );
	} else if( samplingTechnique == 2 ) {
        uint seed = uint(pixelIndex); // Use pixelIndex as seed for per-pixel randomization
        return owen_scrambled_sobol2D(uint(sampleIndex), seed);
	}
	// Default to Halton if an invalid technique is specified
	return vec2( halton( sampleIndex, 2 ), halton( sampleIndex, 3 ) );
}

// Hybrid quasi-random and pseudo-random 2D sample
vec2 HybridRandomSample2D( inout uint state, int sampleIndex, int pixelIndex ) {
	vec2 quasi;
    if (samplingTechnique == 2) {
        // Use Owen-scrambled Sobol
        uint seed = pcg_hash(uint(pixelIndex)); // Use hashed pixelIndex as seed
        quasi = owen_scrambled_sobol2D(uint(sampleIndex), seed);
    } else {
        quasi = QuasiRandomSample2D(sampleIndex, pixelIndex);
    }
    vec2 pseudo = vec2(RandomValue(state), RandomValue(state));
    return fract(quasi + pseudo); // Combine and wrap to [0, 1)
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

// Stratified sampling function
vec2 stratifiedSample( int pixelIndex, int sampleIndex, int totalSamples, inout uint rngState ) {
	int sqrtSamples = int( sqrt( float( totalSamples ) ) );
	int strataX = sampleIndex % sqrtSamples;
	int strataY = sampleIndex / sqrtSamples;

	float jitterX = RandomValue( rngState );
	float jitterY = RandomValue( rngState );

	return vec2( ( float( strataX ) + jitterX ) / float( sqrtSamples ), ( float( strataY ) + jitterY ) / float( sqrtSamples ) );

	// Use a high-quality RNG like PCG
    // rngState = pcg(rngState);
    // float u = float(rngState) / 4294967296.0;
    // rngState = pcg(rngState);
    // float v = float(rngState) / 4294967296.0;
    
    // // Apply stratification
    // int strataSize = int(sqrt(float(totalSamples)));
    // int strataX = sampleIndex % strataSize;
    // int strataY = sampleIndex / strataSize;
    
    // return vec2((float(strataX) + u) / float(strataSize),
    //             (float(strataY) + v) / float(strataSize));
}


vec2 sampleBlueNoise(vec2 pixelCoords) {
    vec2 uv = pixelCoords / resolution;
    vec2 blueNoiseUV = mod(pixelCoords / blueNoiseTextureResolution, vec2(1.0));
    vec2 noise = texture2D(blueNoiseTexture, blueNoiseUV).xy;

	// Combine with PCG hash for extended variation by adding offset
	uint seed = uint( pixelCoords.x ) * 1973u + uint( pixelCoords.y ) * 9277u + uint( frame ) * 26699u;
	float random = float( pcg_hash( seed ) ) / 4294967295.0;

	return fract( noise + random ); // Combine blue noise with PCG hash
}

vec2 getRandomSample(vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState, int preferredTechnique) {
    int technique = (preferredTechnique != -1) ? preferredTechnique : samplingTechnique;
    
    switch (technique) {
        case 3: // Spatio Temporal Blue Noise
            return sampleSBTN(pixelCoord + vec2(float(sampleIndex) * 13.37, float(bounceIndex) * 31.41)).xy;
		
		case 5: // Simple 2D Blue Noise
			return sampleBlueNoise(pixelCoord);
        
        case 0: // PCG
            return vec2(RandomValue(rngState), RandomValue(rngState));
        
        case 4: // Stratified
            int pixelIndex = int(pixelCoord.y) * int(resolution.x) + int(pixelCoord.x);
            return stratifiedSample(pixelIndex, sampleIndex, numRaysPerPixel, rngState);
        
        default: // Halton or Sobol (or any other unspecified technique)
            return HybridRandomSample2D(rngState, sampleIndex, int(pixelCoord.x) + int(pixelCoord.y) * int(resolution.x));
    }
}

// Update getRandomSample4 to use stratified sampling for the first two dimensions
vec4 getRandomSample4( vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState ) {

	if( samplingTechnique == 3 ) { // Blue Noise

		return sampleSBTN( pixelCoord + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );

	} else if( samplingTechnique == 0 ) { // PCG

		return vec4( RandomValue( rngState ), RandomValue( rngState ), RandomValue( rngState ), RandomValue( rngState ) );

	} else if( samplingTechnique == 4 ) { // Stratified
		int pixelIndex = int( pixelCoord.y ) * int( resolution.x ) + int( pixelCoord.x );

		vec2 stratified = stratifiedSample( pixelIndex, sampleIndex, numRaysPerPixel, rngState );
		return vec4( stratified, RandomValue( rngState ), RandomValue( rngState ) );

	} else if ( samplingTechnique == 5 ) { // Simple 2D Blue Noise

		vec2 noise = sampleBlueNoise( pixelCoord + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );
		return vec4( noise, noise );
		
	} else { // Halton or Sobol
		return vec4( HybridRandomSample2D( rngState, sampleIndex, int( pixelCoord.x ) + int( pixelCoord.y ) * int( resolution.x ) ), HybridRandomSample2D( rngState, sampleIndex + 1, int( pixelCoord.x ) + int( pixelCoord.y ) * int( resolution.x ) ) );
		// return HybridRandomHemisphereDirection
		// return vec4( 
		// 	HybridRandomHemisphereDirection( vec3( 0.0, 1.0, 0.0 ), rngState, sampleIndex, int( pixelCoord.x ) + int( pixelCoord.y ) * int( resolution.x ) ), 
		// 	HybridRandomHemisphereDirection( vec3( 0.0, 1.0, 0.0 ), rngState, sampleIndex + 1, int( pixelCoord.x ) + int( pixelCoord.y ) * int( resolution.x ) ) 
		// 	);
		
	}
}

vec3 sampleSphere( vec2 uv ) {

		float u = ( uv.x - 0.5 ) * 2.0;
		float t = uv.y * PI * 2.0;
		float f = sqrt( 1.0 - u * u );

		return vec3( f * cos( t ), f * sin( t ), u );

	}