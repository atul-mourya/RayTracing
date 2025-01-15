// -----------------------------------------------------------------------------
// Uniform declarations and constants
// -----------------------------------------------------------------------------
uniform sampler2D spatioTemporalBlueNoiseTexture;
uniform vec3 spatioTemporalBlueNoiseReolution;
uniform sampler2D blueNoiseTexture;
uniform int samplingTechnique; // 0: PCG, 1: Halton, 2: Sobol, 3: Blue Noise, 4: Stratified
uniform ivec2 blueNoiseTextureSize;

// Sobol sequence direction vectors
const uint V[32] = uint[32](
    2147483648u, 1073741824u, 536870912u, 268435456u, 134217728u, 67108864u, 33554432u, 16777216u,
    8388608u, 4194304u, 2097152u, 1048576u, 524288u, 262144u, 131072u, 65536u,
    32768u, 16384u, 8192u, 4096u, 2048u, 1024u, 512u, 256u, 128u, 64u, 32u, 16u, 8u, 4u, 2u, 1u
);

// -----------------------------------------------------------------------------
// Basic random number generation
// -----------------------------------------------------------------------------

// PCG (Permuted Congruential Generator) hash function
uint pcg_hash(uint state) {
    state = state * 747796405u + 2891336453u;
    state = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    state = (state >> 22u) ^ state;
    return state;
}

// Generate random float between 0 and 1
float RandomValue(inout uint state) {
    state = pcg_hash(state);
    return float(state >> 8) * (1.0 / 16777216.0);
}

// -----------------------------------------------------------------------------
// Directional sampling functions
// -----------------------------------------------------------------------------

// Generate random direction in 3D space
vec3 RandomDirection(inout uint state) {
    float z = RandomValue(state) * 2.0 - 1.0;
    float phi = RandomValue(state) * 2.0 * PI;
    float r = sqrt(1.0 - z * z);
    return vec3(r * cos(phi), r * sin(phi), z);
}

// Generate random direction in hemisphere aligned with normal
vec3 RandomHemiSphereDirection(vec3 normal, inout uint rngState) {
    vec3 dir = RandomDirection(rngState);
    return dir * sign(dot(normal, dir));
}

// Generate random point in unit circle
vec2 RandomPointInCircle(inout uint rngState) {
    float angle = RandomValue(rngState) * 2.0 * PI;
    vec2 pointOnCircle = vec2(cos(angle), sin(angle));
    return pointOnCircle * sqrt(RandomValue(rngState));
}

// -----------------------------------------------------------------------------
// Low-discrepancy sequence generators
// -----------------------------------------------------------------------------

// Halton sequence generator
float halton(int index, int base) {
    float result = 0.0;
    float f = 1.0;
    int i = index;
    while(i > 0) {
        f /= float(base);
        result += f * float(i % base);
        i = int(floor(float(i) / float(base)));
    }
    return result;
}

// Owen scrambling for Sobol sequence
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

// -----------------------------------------------------------------------------
// Blue noise sampling
// -----------------------------------------------------------------------------

// RNG state structure for blue noise
struct RNGState {
    uvec4 state;
    ivec2 pixel;
};

RNGState rState;

// Initialize RNG state
void initializeRNG(vec2 pixel) {
    rState.pixel = ivec2(pixel);
    rState.state = uvec4(
        frame,
        frame * 15843u,
        frame * 31u + 4566u,
        frame * 2345u + 58585u
    );
}

// PCG-4D hash function for blue noise
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

vec4 sampleBlueNoise(vec2 pixelCoords) {
    initializeRNG(pixelCoords);
    pcg4d(rState.state);
    ivec2 shift = (rState.pixel + ivec2(rState.state.xy % 0x0fffffffu)) % blueNoiseTextureSize;
    // Add temporal variation
    shift = (shift + ivec2(frame * 1664525u)) % blueNoiseTextureSize;
    return texelFetch(blueNoiseTexture, shift, 0);

}

// Sample spatio-temporal blue noise
vec4 sampleSTBN(vec2 pixelCoords) {
    vec3 stbnr = spatioTemporalBlueNoiseReolution;
    vec2 textureSize = vec2(stbnr.x, stbnr.y * stbnr.z);
    vec2 texCoord = (pixelCoords + vec2(0.5)) / float(stbnr.x);
    texCoord.y = (texCoord.y + float(int(frame) % int(stbnr.z))) / float(stbnr.z);
    vec4 noise = texture2D(spatioTemporalBlueNoiseTexture, texCoord);

    uint seed = uint(pixelCoords.x) * 1973u + uint(pixelCoords.y) * 9277u + uint(frame) * 26699u;
    float random = float(pcg_hash(seed)) / 4294967295.0;

    return fract(noise + random);
}

// -----------------------------------------------------------------------------
// Stratified sampling
// -----------------------------------------------------------------------------

// Basic stratified sampling
vec2 stratifiedSample(int pixelIndex, int sampleIndex, int totalSamples, inout uint rngState) {
    int sqrtSamples = int(sqrt(float(totalSamples)));
    int strataX = sampleIndex % sqrtSamples;
    int strataY = sampleIndex / sqrtSamples;

    float jitterX = RandomValue(rngState);
    float jitterY = RandomValue(rngState);

    return vec2(
        (float(strataX) + jitterX) / float(sqrtSamples),
        (float(strataY) + jitterY) / float(sqrtSamples)
    );
}

// Stratified blue noise sampling
vec2 stratifiedBlueNoiseSample(vec2 pixelCoord, int sampleIndex, int frame) {
    
    int strataSize = int(sqrt(float(numRaysPerPixel)));
    int strataX = sampleIndex % strataSize;
    int strataY = sampleIndex / strataSize;

    vec2 stratifiedSample = vec2(
        (float(strataX) + 0.5) / float(strataSize),
        (float(strataY) + 0.5) / float(strataSize)
    );

    vec2 noiseValue = sampleBlueNoise(pixelCoord).xy;

    pcg4d(rState.state);
    vec2 temporalJitter = vec2(float(rState.state.x), float(rState.state.y)) / 4294967295.0;
    vec2 offset = (noiseValue - 0.5 + (temporalJitter - 0.5) * 0.2) / float(strataSize);
    
    return fract(stratifiedSample + noiseValue);
}

// -----------------------------------------------------------------------------
// Hybrid sampling methods
// -----------------------------------------------------------------------------

// Combine quasi-random and pseudo-random sampling
vec2 HybridRandomSample2D(inout uint state, int sampleIndex, int pixelIndex) {
    vec2 quasi;
    if (samplingTechnique == 2) {
        uint seed = pcg_hash(uint(pixelIndex));
        quasi = owen_scrambled_sobol2D(uint(sampleIndex), seed);
    } else {
        quasi = vec2(halton(sampleIndex, 2), halton(sampleIndex, 3));
    }
    vec2 pseudo = vec2(RandomValue(state), RandomValue(state));
    return fract(quasi + pseudo);
}

// Generate hybrid random direction on hemisphere
vec3 HybridRandomHemisphereDirection(vec3 normal, inout uint state, int sampleIndex, int pixelIndex) {
    vec2 s = HybridRandomSample2D(state, sampleIndex, pixelIndex);

    float cosTheta = sqrt(1.0 - s.x);
    float sinTheta = sqrt(s.x);
    float phi = 2.0 * PI * s.y;

    vec3 tangentSpaceDir = vec3(
        cos(phi) * sinTheta,
        sin(phi) * sinTheta,
        cosTheta
    );

    vec3 tangent = normalize(cross(normal, vec3(0.0, 1.0, 0.0)));
    vec3 bitangent = cross(normal, tangent);
    return tangent * tangentSpaceDir.x + bitangent * tangentSpaceDir.y + normal * tangentSpaceDir.z;
}

// -----------------------------------------------------------------------------
// Main sampling interface functions
// -----------------------------------------------------------------------------

// Get random sample based on preferred technique
vec2 getRandomSample(vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState, int preferredTechnique) {
    int technique = (preferredTechnique != -1) ? preferredTechnique : samplingTechnique;
    
    switch (technique) {
        case 0: // PCG
            return vec2(RandomValue(rngState), RandomValue(rngState));
        case 1: // Halton
        case 2: // Sobol
            return HybridRandomSample2D(rngState, sampleIndex, int(pixelCoord.x) + int(pixelCoord.y) * int(resolution.x));
        case 3: // Spatio Temporal Blue Noise
            return sampleSTBN(pixelCoord + vec2(float(sampleIndex) * 13.37, float(bounceIndex) * 31.41)).xy;
        case 4: // Stratified
            int pixelIndex = int(pixelCoord.y) * int(resolution.x) + int(pixelCoord.x);
            return stratifiedSample(pixelIndex, sampleIndex, numRaysPerPixel, rngState);
        case 5: // Simple 2D Blue Noise
            return sampleBlueNoise(pixelCoord).xy;
        case 6: // Stratified Blue Noise
            return stratifiedBlueNoiseSample(pixelCoord, sampleIndex, int(frame));
        default:
            return vec2(0.0);
    }
}
