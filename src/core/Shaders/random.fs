// -----------------------------------------------------------------------------
// Uniform declarations and constants
// -----------------------------------------------------------------------------
uniform int samplingTechnique; // 0: PCG, 1: Halton, 2: Sobol, 3: Blue Noise
uniform sampler2D blueNoiseTexture;
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

// Generate random point in unit circle
vec2 RandomPointInCircle(inout uint rngState) {
    float angle = RandomValue(rngState) * TWO_PI;
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

vec4 sampleBlueNoise(vec2 pixelCoords, int sampleIndex, int bounceIndex) {
    int frm = int( frame );
    ivec2 coord = ivec2(pixelCoords + vec2(frm * 17, frm * 29)) % blueNoiseTextureSize;
    return texelFetch(blueNoiseTexture, coord, 0);
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
        case 3: // Blue Noise with dimensional awareness
            vec4 noise = sampleBlueNoise(pixelCoord, sampleIndex, bounceIndex);

            uint channelHash = pcg_hash(uint(bounceIndex * 1237 + sampleIndex * 2477));
            float selector = float(channelHash >> 30) / 4.0; // 0.0 to 0.75
            
            // Use different components based on the bounce type to preserve blue noise properties
            if (selector < 0.25) {
                // Primary rays - use xy for pixel jittering
                return noise.xy;
            }
            if (selector < 0.5) {
                // Secondary bounces - use zw for BRDF sampling
                return noise.zw;
            }
            if (selector < 0.75) {
                // Tertiary bounces - use xz (mix channels)
                return vec2(noise.x, noise.z);
            }
            // Other bounces - use yw (mix channels)
            return vec2(noise.y, noise.w);
        default:
            return vec2(0.0);
    }
}

// -----------------------------------------------------------------------------
// Other sampling utilities
// -----------------------------------------------------------------------------

vec2 getStratifiedSample(vec2 pixelCoord, int rayIndex, int totalRays, inout uint rngState) {
    if(totalRays == 1) {
        // Single sample - use regular jittering
        return getRandomSample(pixelCoord, rayIndex, 0, rngState, -1);
    }
    
    // Stratify samples across pixel for better distribution
    int strataX = int(sqrt(float(totalRays)));
    int strataY = (totalRays + strataX - 1) / strataX; // Ceiling division
    
    int strataIdx = rayIndex % (strataX * strataY);
    int sx = strataIdx % strataX;
    int sy = strataIdx / strataX;
    
    // Base stratified position
    vec2 strataPos = vec2(float(sx), float(sy)) / vec2(float(strataX), float(strataY));
    
    // Add jitter within strata
    vec2 jitter = getRandomSample(pixelCoord, rayIndex, 0, rngState, -1);
    jitter /= vec2(float(strataX), float(strataY));
    
    return strataPos + jitter;
}

uint getDecorrelatedSeed(vec2 pixelCoord, int rayIndex, uint frame) {
    // Base seed from pixel coordinates
    uint pixelSeed = uint(pixelCoord.x) + uint(pixelCoord.y) * uint(resolution.x);
    
    // Decorrelate across frames using different primes
    uint frameSeed = pcg_hash(frame * 1237u + uint(rayIndex) * 2477u);
    
    // Combine using XOR to avoid correlation
    return pcg_hash(pixelSeed ^ frameSeed);
}
