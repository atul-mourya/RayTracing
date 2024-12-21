uniform sampler2D spatioTemporalBlueNoiseTexture;
uniform vec3 spatioTemporalBlueNoiseReolution;
uniform sampler2D blueNoiseTexture;
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
    state = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    state = (state >> 22u) ^ state;
    return state;
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

// spatio-temporal blue noise texture sampling
vec4 sampleSTBN( vec2 pixelCoords ) {
	vec3 stbnr = spatioTemporalBlueNoiseReolution;
	vec2 textureSize = vec2( stbnr.x, stbnr.y * stbnr.z );
	vec2 texCoord = ( pixelCoords + vec2( 0.5 ) ) / float( stbnr.x );
	texCoord.y = ( texCoord.y + float( int( frame ) % int( stbnr.z ) ) ) / float( stbnr.z );
	vec4 noise = texture2D( spatioTemporalBlueNoiseTexture, texCoord );

	// Combine with PCG hash for extended variation by adding offset
	uint seed = uint( pixelCoords.x ) * 1973u + uint( pixelCoords.y ) * 9277u + uint( frame ) * 26699u;
	float random = float( pcg_hash( seed ) ) / 4294967295.0;

	return fract( noise + random ); // Combine blue noise with PCG hash
}

float RandomValue( inout uint state ) {
	state = pcg_hash( state );
    return float(state >> 8) * (1.0 / 16777216.0);
}

// Random value in normal distribution (with mean=0 and sd=1)
float RandomValueNormalDistribution( inout uint state ) {
	// Thanks to https://stackoverflow.com/a/6178290
	float theta = 2.0 * PI * RandomValue( state );
	float rho = sqrt( - 2.0 * log( RandomValue( state ) ) );
	return rho * cos( theta );
}

// Calculate a random direction.
// Note: there are many alternative methods for computing this,
// with varying trade-offs between speed and accuracy.
vec3 RandomDirection( inout uint state ) {
	float z = RandomValue( state ) * 2.0 - 1.0;
    float phi = RandomValue( state ) * 2.0 * PI;
    float r = sqrt( 1.0 - z * z );
    return vec3( r * cos( phi ), r * sin( phi ), z );
}

vec3 RandomHemiSphereDirection( vec3 normal, inout uint rngState ) {
	vec3 dir = RandomDirection( rngState );
	dir = dir * sign( dot( normal, dir ) );
	return dir;
}

vec3 BlueNoiseRandomDirection( vec2 pixelCoords, int sampleIndex, int bounceIndex ) {
	vec4 blueNoise = sampleSTBN( pixelCoords + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );

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
    vec2 blueNoiseUV = mod(pixelCoords / vec2(textureSize(blueNoiseTexture, 0)), vec2(1.0));
    vec2 noise = texture2D(blueNoiseTexture, blueNoiseUV).xy;

	// Combine with PCG hash for extended variation by adding offset
	uint seed = uint( pixelCoords.x ) * 1973u + uint( pixelCoords.y ) * 9277u + uint( frame ) * 26699u;
	float random = float( pcg_hash( seed ) ) / 4294967295.0;

	return fract( noise + random ); // Combine blue noise with PCG hash
}

// PCG-4D state and functions
struct RNGState {
    uvec4 state;
    ivec2 pixel;
};

void pcg4d(inout uvec4 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y*v.w; 
    v.y += v.z*v.x; 
    v.z += v.x*v.y; 
    v.w += v.y*v.z;
    v = v ^ (v>>16u);
    v.x += v.y*v.w; 
    v.y += v.z*v.x; 
    v.z += v.x*v.y; 
    v.w += v.y*v.z;
}

void initializeRNG(inout RNGState rState, vec2 pixel, int frame, int sampleIndex) {
    rState.pixel = ivec2(pixel);
    // Combine frame, sample index and pixel position for better variation
    rState.state = uvec4(
        uint(frame), 
        uint(frame * 15843 + sampleIndex), 
        uint(frame * 31 + 4566 + sampleIndex * 7), 
        uint(frame * 2345 + 58585 + sampleIndex * 13)
    );
}

ivec2 getBlueNoiseOffset(inout RNGState rState) {
    pcg4d(rState.state);
    return (rState.pixel + ivec2(rState.state.xy % 0x0fffffffu)) % textureSize(blueNoiseTexture, 0).x;
}

vec2 stratifiedBlueNoiseSample(vec2 pixelCoord, int sampleIndex, int frame) {
    // Initialize RNG state
    RNGState rState;
    initializeRNG(rState, pixelCoord, frame, sampleIndex);
    
    // Calculate stratum
    int strataSize = int(sqrt(float(numRaysPerPixel)));
    int strataX = sampleIndex % strataSize;
    int strataY = sampleIndex / strataSize;

    // Get base stratified sample
    vec2 stratifiedSample = vec2(
        (float(strataX) + 0.5) / float(strataSize),
        (float(strataY) + 0.5) / float(strataSize)
    );

    // Get temporally-varying blue noise
    ivec2 noiseOffset = getBlueNoiseOffset(rState);
    vec2 noiseValue = texelFetch(blueNoiseTexture, noiseOffset, 0).xy;

    // Generate additional temporal variation
    pcg4d(rState.state);
    vec2 temporalJitter = vec2(
        float(rState.state.x),
        float(rState.state.y)
    ) / 4294967295.0;

    // Combine stratification with noise
    vec2 offset = (noiseValue - 0.5 + (temporalJitter - 0.5) * 0.2) / float(strataSize);
    
    return fract(stratifiedSample + offset);
}


vec2 getRandomSample(vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState, int preferredTechnique) {
    int technique = (preferredTechnique != -1) ? preferredTechnique : samplingTechnique;
    
    switch (technique) {
        case 3: // Spatio Temporal Blue Noise
            return sampleSTBN(pixelCoord + vec2(float(sampleIndex) * 13.37, float(bounceIndex) * 31.41)).xy;
		
		case 5: // Simple 2D Blue Noise
			return sampleBlueNoise(pixelCoord);

		case 6: // Stratified Blue Noise
            return stratifiedBlueNoiseSample(pixelCoord, sampleIndex, int(frame));
        
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

		return sampleSTBN( pixelCoord + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );

	} else if( samplingTechnique == 0 ) { // PCG

		return vec4( RandomValue( rngState ), RandomValue( rngState ), RandomValue( rngState ), RandomValue( rngState ) );

	} else if( samplingTechnique == 4 ) { // Stratified
		return vec4(
			stratifiedBlueNoiseSample( pixelCoord, sampleIndex, int( frame ) ),
			stratifiedBlueNoiseSample( pixelCoord, sampleIndex + 1, int( frame ) )
		);

	} else if ( samplingTechnique == 5 ) { // Simple 2D Blue Noise

		vec2 noise = sampleBlueNoise( pixelCoord + vec2( float( sampleIndex ) * 13.37, float( bounceIndex ) * 31.41 ) );
		return vec4( noise, noise );

	} else if ( samplingTechnique == 6 ) { // Stratified Blue Noise
	
		vec2 noise = stratifiedBlueNoiseSample( pixelCoord, sampleIndex, int( frame ) );
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