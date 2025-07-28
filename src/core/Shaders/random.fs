// -----------------------------------------------------------------------------
// Uniform declarations and constants
// -----------------------------------------------------------------------------
uniform int samplingTechnique; // 0: PCG, 1: Halton, 2: Sobol, 3: Blue Noise
uniform sampler2D blueNoiseTexture;
uniform ivec2 blueNoiseTextureSize;

// Golden ratio constants for dimension decorrelation
const float PHI = 1.61803398875;
const float INV_PHI = 0.61803398875;
const float INV_PHI2 = 0.38196601125;

// Sobol sequence direction vectors
const uint V[ 32 ] = uint[ 32 ]( 2147483648u, 1073741824u, 536870912u, 268435456u, 134217728u, 67108864u, 33554432u, 16777216u, 8388608u, 4194304u, 2097152u, 1048576u, 524288u, 262144u, 131072u, 65536u, 32768u, 16384u, 8192u, 4096u, 2048u, 1024u, 512u, 256u, 128u, 64u, 32u, 16u, 8u, 4u, 2u, 1u );

// Primes for hashing (carefully chosen to avoid correlations)
const uint PRIME1 = 2654435761u;
const uint PRIME2 = 3266489917u;
const uint PRIME3 = 668265263u;
const uint PRIME4 = 374761393u;

// -----------------------------------------------------------------------------
// Basic random number generation
// -----------------------------------------------------------------------------

// PCG (Permuted Congruential Generator) hash function
uint pcg_hash( uint state ) {
    state = state * 747796405u + 2891336453u;
    state = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
    state = ( state >> 22u ) ^ state;
    return state;
}

// Wang hash for additional mixing
uint wang_hash( uint seed ) {
    seed = ( seed ^ 61u ) ^ ( seed >> 16u );
    seed *= 9u;
    seed = seed ^ ( seed >> 4u );
    seed *= 0x27d4eb2du;
    seed = seed ^ ( seed >> 15u );
    return seed;
}

// Generate random float between 0 and 1
float RandomValue( inout uint state ) {
    state = pcg_hash( state );
    return float( state >> 8 ) * ( 1.0 / 16777216.0 );
}

// Generate random float with better precision
float RandomValueHighPrecision( inout uint state ) {
    uint s1 = pcg_hash( state );
    state = s1;
    uint s2 = pcg_hash( state );
    // Combine two 24-bit values for 48-bit precision
    return ( float( s1 >> 8 ) + float( s2 >> 8 ) * ( 1.0 / 16777216.0 ) ) * ( 1.0 / 16777216.0 );
}

// -----------------------------------------------------------------------------
// Directional sampling functions
// -----------------------------------------------------------------------------

// Generate random point in unit circle
vec2 RandomPointInCircle( inout uint rngState ) {
    float angle = RandomValue( rngState ) * TWO_PI;
    vec2 pointOnCircle = vec2( cos( angle ), sin( angle ) );
    return pointOnCircle * sqrt( RandomValue( rngState ) );
}

// -----------------------------------------------------------------------------
// Blue noise sampling with proper multi-dimensional support
// -----------------------------------------------------------------------------

// Cranley-Patterson rotation for decorrelation
vec2 cranleyPatterson2D( vec2 p, vec2 offset ) {
    return fract( p + offset );
}

// Improved blue noise sampling that properly uses all parameters
vec4 sampleBlueNoiseRaw( vec2 pixelCoords, int sampleIndex, int bounceIndex ) {
    // Create dimension-specific offsets using golden ratio
    vec2 dimensionOffset = vec2( fract( float( sampleIndex ) * INV_PHI ), fract( float( bounceIndex ) * INV_PHI2 ) );

    // Frame-based decorrelation with better hash
    uint frameHash = wang_hash( pcg_hash( uint( frame ) ) );
    vec2 frameOffset = vec2( float( frameHash & 0xFFFFu ) / 65536.0, float( ( frameHash >> 16 ) & 0xFFFFu ) / 65536.0 );

    // Scale offsets to texture size
    vec2 scaledDimOffset = dimensionOffset * vec2( blueNoiseTextureSize );
    vec2 scaledFrameOffset = frameOffset * vec2( blueNoiseTextureSize );

    // Combine all offsets with proper toroidal wrapping
    vec2 coords = mod( pixelCoords + scaledDimOffset + scaledFrameOffset, vec2( blueNoiseTextureSize ) );

    // Ensure positive coordinates and fetch
    ivec2 texCoord = ivec2( floor( coords ) );
    return texelFetch( blueNoiseTexture, texCoord, 0 );
}

// Get a single float value from blue noise (for 1D sampling)
float sampleBlueNoise1D( vec2 pixelCoords, int sampleIndex, int dimension ) {
    vec4 noise = sampleBlueNoiseRaw( pixelCoords, sampleIndex, dimension / 4 );
    int component = dimension % 4;
    return component == 0 ? noise.x : component == 1 ? noise.y : component == 2 ? noise.z : noise.w;
}

// Get 2D blue noise sample with dimension offset
vec2 sampleBlueNoise2D( vec2 pixelCoords, int sampleIndex, int dimensionBase ) {
    // For 2D sampling, we need to carefully select components to maintain blue noise properties
    vec4 noise = sampleBlueNoiseRaw( pixelCoords, sampleIndex, dimensionBase / 2 );

    // Use different component pairs based on dimension
    int pairIndex = ( dimensionBase / 2 ) % 6;
    switch( pairIndex ) {
        case 0:
            return noise.xy;
        case 1:
            return noise.zw;
        case 2:
            return noise.xz;
        case 3:
            return noise.yw;
        case 4:
            return noise.xw;
        case 5:
            return noise.yz;
    }
    return noise.xy; // fallback
}

// Progressive blue noise sampling for temporal accumulation
vec2 sampleProgressiveBlueNoise( vec2 pixelCoords, int currentSample, int maxSamples ) {
    // Determine which "slice" of the blue noise we're in
    float progress = float( currentSample ) / float( max( 1, maxSamples ) );
    int temporalSlice = int( progress * 16.0 ); // 16 temporal slices

    // Use different regions of blue noise for different sample counts
    vec2 sliceOffset = vec2( float( temporalSlice % 4 ) * 0.25, float( temporalSlice / 4 ) * 0.25 );

    // Scale to texture space and add pixel-specific offset
    vec2 scaledOffset = sliceOffset * vec2( blueNoiseTextureSize );
    vec2 coords = mod( pixelCoords + scaledOffset, vec2( blueNoiseTextureSize ) );

    vec4 noise = sampleBlueNoiseRaw( coords, currentSample, 0 );

    // Apply additional Cranley-Patterson rotation for better distribution
    uint seed = pcg_hash( uint( currentSample ) ^ wang_hash( uint( maxSamples ) ) );
    vec2 rotation = vec2( float( seed & 0xFFFFu ) / 65536.0, float( ( seed >> 16 ) & 0xFFFFu ) / 65536.0 );

    return cranleyPatterson2D( noise.xy, rotation );
}

// -----------------------------------------------------------------------------
// Low-discrepancy sequence generators
// -----------------------------------------------------------------------------

// Halton sequence generator with Owen scrambling
float haltonScrambled( int index, int base, uint scramble ) {
    float result = 0.0;
    float f = 1.0;
    int i = index;

    while( i > 0 ) {
        f /= float( base );
        // Apply digit scrambling
        int digit = i % base;
        digit = int( wang_hash( uint( digit ) ^ scramble ) % uint( base ) );
        result += f * float( digit );
        i = int( floor( float( i ) / float( base ) ) );
    }
    return result;
}

// Owen scrambling for Sobol sequence
uint owen_scramble( uint x, uint seed ) {
    x = x ^ ( x * 0x3d20adeau );
    x += seed;
    x *= ( seed >> 16 ) | 1u;
    x ^= x >> 15;
    x *= 0x5851f42du;
    x ^= x >> 12;
    x *= 0x4c957f2du;
    x ^= x >> 18;
    return x;
}

// Owen-scrambled Sobol sequence
float owen_scrambled_sobol( uint index, uint dimension, uint seed ) {
    uint result = 0u;
    for( int i = 0; i < 32; ++ i ) {
        if( ( index & ( 1u << i ) ) != 0u ) {
            result ^= V[ i ] << dimension;
        }
    }
    result = owen_scramble( result, seed );
    return float( result ) / 4294967296.0;
}

vec2 owen_scrambled_sobol2D( uint index, uint seed ) {
    return vec2( owen_scrambled_sobol( index, 0u, seed ), owen_scrambled_sobol( index, 1u, seed ) );
}

// -----------------------------------------------------------------------------
// Multi-dimensional sampling interface
// -----------------------------------------------------------------------------

// Get N-dimensional sample (up to 4D)
vec4 getRandomSampleND( vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState, int dimensions, int preferredTechnique ) {
    int technique = ( preferredTechnique != - 1 ) ? preferredTechnique : samplingTechnique;
    vec4 result = vec4( 0.0 );

    switch( technique ) {
        case 0: // PCG
            for( int i = 0; i < dimensions; i ++ ) {
                result[ i ] = RandomValue( rngState );
            }
            break;

        case 1: // Halton
        {
            uint scramble = pcg_hash( uint( pixelCoord.x ) + uint( pixelCoord.y ) * uint( resolution.x ) );
            int primes[ 4 ] = int[ 4 ]( 2, 3, 5, 7 );
            for( int i = 0; i < dimensions; i ++ ) {
                result[ i ] = haltonScrambled( sampleIndex, primes[ i ], scramble );
            }
        }
        break;

        case 2: // Sobol
        {
            uint seed = pcg_hash( uint( pixelCoord.x ) + uint( pixelCoord.y ) * uint( resolution.x ) );
            for( int i = 0; i < dimensions; i ++ ) {
                result[ i ] = owen_scrambled_sobol( uint( sampleIndex ), uint( i ), seed );
            }
        }
        break;

        case 3: // Blue Noise
        {
                // For blue noise, we need to carefully handle dimensions
            int dimensionOffset = bounceIndex * 4; // Each bounce uses up to 4 dimensions

            if( dimensions <= 2 ) {
                vec2 _sample = sampleBlueNoise2D( pixelCoord, sampleIndex, dimensionOffset );
                result.xy = _sample;
            } else {
                    // For 3D/4D, fetch two 2D samples
                vec2 _sample1 = sampleBlueNoise2D( pixelCoord, sampleIndex, dimensionOffset );
                vec2 _sample2 = sampleBlueNoise2D( pixelCoord, sampleIndex, dimensionOffset + 2 );
                result = vec4( _sample1, _sample2 );
            }
        }
        break;
    }

    return result;
}

// -----------------------------------------------------------------------------
// Hybrid sampling methods
// -----------------------------------------------------------------------------

// Combine quasi-random and pseudo-random sampling with blue noise awareness
vec2 HybridRandomSample2D( inout uint state, int sampleIndex, int pixelIndex ) {
    vec2 quasi;

    if( samplingTechnique == 2 ) { // Sobol
        uint seed = pcg_hash( uint( pixelIndex ) );
        quasi = owen_scrambled_sobol2D( uint( sampleIndex ), seed );
    } else if( samplingTechnique == 1 ) { // Halton
        uint scramble = wang_hash( uint( pixelIndex ) );
        quasi = vec2( haltonScrambled( sampleIndex, 2, scramble ), haltonScrambled( sampleIndex, 3, scramble ) );
    } else if( samplingTechnique == 3 ) { // Blue noise
        vec2 pixelCoord = vec2( float( pixelIndex % int( resolution.x ) ), float( pixelIndex / int( resolution.x ) ) );
        return sampleBlueNoise2D( pixelCoord, sampleIndex, 0 );
    } else { // PCG fallback
        return vec2( RandomValue( state ), RandomValue( state ) );
    }

    // Add small random offset for better convergence
    vec2 pseudo = vec2( RandomValue( state ), RandomValue( state ) );
    return fract( quasi + pseudo * 0.01 ); // Small perturbation
}

// -----------------------------------------------------------------------------
// Main sampling interface functions
// -----------------------------------------------------------------------------

// Get random sample based on preferred technique (2D)
vec2 getRandomSample( vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState, int preferredTechnique ) {
    vec4 sample4D = getRandomSampleND( pixelCoord, sampleIndex, bounceIndex, rngState, 2, preferredTechnique );
    return sample4D.xy;
}

// Get stratified sample with proper blue noise support
vec2 getStratifiedSample( vec2 pixelCoord, int rayIndex, int totalRays, inout uint rngState ) {
    if( totalRays == 1 ) {
        return getRandomSample( pixelCoord, rayIndex, 0, rngState, - 1 );
    }

    // Calculate strata dimensions
    int strataX = int( sqrt( float( totalRays ) ) );
    int strataY = ( totalRays + strataX - 1 ) / strataX;

    int strataIdx = rayIndex % ( strataX * strataY );
    int sx = strataIdx % strataX;
    int sy = strataIdx / strataX;

    // Base stratified position
    vec2 strataPos = vec2( float( sx ), float( sy ) ) / vec2( float( strataX ), float( strataY ) );

    // Get jitter based on sampling technique
    vec2 jitter;
    if( samplingTechnique == 3 ) { // Blue noise
        // Use progressive blue noise for stratified sampling
        jitter = sampleProgressiveBlueNoise( pixelCoord, rayIndex, totalRays );
    } else {
        jitter = getRandomSample( pixelCoord, rayIndex, 0, rngState, - 1 );
    }

    jitter /= vec2( float( strataX ), float( strataY ) );

    return strataPos + jitter;
}

// Get decorrelated seed with better mixing
uint getDecorrelatedSeed( vec2 pixelCoord, int rayIndex, uint frame ) {
    // Use multiple primes for better decorrelation
    uint pixelSeed = uint( pixelCoord.x ) * PRIME1 + uint( pixelCoord.y ) * PRIME2;
    uint raySeed = uint( rayIndex ) * PRIME3;
    uint frameSeed = frame * PRIME4;

    // Multiple rounds of hashing for better quality
    uint seed = wang_hash( pixelSeed );
    seed = pcg_hash( seed ^ raySeed );
    seed = wang_hash( seed + frameSeed );

    return seed;
}

// -----------------------------------------------------------------------------
// Specialized sampling functions
// -----------------------------------------------------------------------------

// Get sample optimized for primary rays (pixel anti-aliasing)
vec2 getPrimaryRaySample( vec2 pixelCoord, int sampleIndex, int totalSamples, inout uint rngState ) {
    if( samplingTechnique == 3 ) { // Blue noise
        return sampleProgressiveBlueNoise( pixelCoord, sampleIndex, totalSamples );
    }
    return getStratifiedSample( pixelCoord, sampleIndex, totalSamples, rngState );
}

// Get sample optimized for BRDF sampling
vec2 getBRDFSample( vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState ) {
    // BRDF sampling benefits from different dimensions than pixel sampling
    int dimensionOffset = 2 + bounceIndex * 2; // Start at dimension 2

    if( samplingTechnique == 3 ) { // Blue noise
        return sampleBlueNoise2D( pixelCoord, sampleIndex, dimensionOffset );
    }
    return getRandomSample( pixelCoord, sampleIndex, bounceIndex, rngState, - 1 );
}

// Get sample for Russian roulette (1D)
float getRussianRouletteSample( vec2 pixelCoord, int sampleIndex, int bounceIndex, inout uint rngState ) {
    if( samplingTechnique == 3 ) { // Blue noise
        // Use a different dimension for Russian roulette
        return sampleBlueNoise1D( pixelCoord, sampleIndex, bounceIndex * 4 + 3 );
    }
    return RandomValue( rngState );
}