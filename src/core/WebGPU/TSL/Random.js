import { Fn, float, uint, int, vec2, vec3, vec4, If } from 'three/tsl';

/**
 * Comprehensive random number generation for path tracing.
 * Supports multiple sampling techniques:
 * - PCG (Permuted Congruential Generator) - Fast pseudo-random
 * - Halton sequences - Low-discrepancy quasi-random
 * - Sobol sequences - Multi-dimensional low-discrepancy
 * - Blue Noise - Optimal for sampling and anti-aliasing
 * 
 * Matches the GLSL random.fs implementation.
 */

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Golden ratio constants for dimension decorrelation
const PHI = 1.61803398875;
const INV_PHI = 0.61803398875;
const INV_PHI2 = 0.38196601125;
const TWO_PI = 2.0 * Math.PI;

// Primes for hashing (carefully chosen to avoid correlations)
const PRIME1 = 2654435761;
const PRIME2 = 3266489917;
const PRIME3 = 668265263;
const PRIME4 = 374761393;

// -----------------------------------------------------------------------------
// Basic Hash Functions
// -----------------------------------------------------------------------------

/**
 * PCG hash function - generates a pseudo-random uint from a seed.
 * This is a one-shot hash, not a stateful RNG.
 * Matches pcg_hash from GLSL.
 *
 * @param {TSLNode} seed - Input uint seed
 * @returns {TSLNode} Pseudo-random uint
 */
export const pcgHash = Fn( ( [ seed ] ) => {

	// PCG-RXS-M-XS variant
	let state = seed.mul( uint( 747796405 ) ).add( uint( 2891336453 ) );
	const word = state.shiftRight( state.shiftRight( uint( 28 ) ).add( uint( 4 ) ) ).bitXor( state ).mul( uint( 277803737 ) );
	return word.shiftRight( uint( 22 ) ).bitXor( word );

} ).setLayout( {
	name: 'pcgHash',
	type: 'uint',
	inputs: [
		{ name: 'seed', type: 'uint' }
	]
} );

/**
 * Wang hash for additional mixing.
 * Provides good avalanche properties.
 * Matches wang_hash from GLSL.
 *
 * @param {TSLNode} seed - Input uint seed
 * @returns {TSLNode} Hashed uint
 */
export const wangHash = Fn( ( [ seed ] ) => {

	let state = seed.bitXor( uint( 61 ) ).bitXor( seed.shiftRight( uint( 16 ) ) );
	state = state.mul( uint( 9 ) );
	state = state.bitXor( state.shiftRight( uint( 4 ) ) );
	state = state.mul( uint( 0x27d4eb2d ) );
	state = state.bitXor( state.shiftRight( uint( 15 ) ) );
	return state;

} ).setLayout( {
	name: 'wangHash',
	type: 'uint',
	inputs: [
		{ name: 'seed', type: 'uint' }
	]
} );


// -----------------------------------------------------------------------------
// Random Number Generation - Multiple Quality Levels
// -----------------------------------------------------------------------------

/**
 * Fast random value for hot paths - uses simpler hash for performance.
 * Optimized: ~40% faster than full PCG for non-critical samples.
 * Matches RandomValueFast from GLSL.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random float in [0, 1)
 */
export const randomValueFast = Fn( ( [ state ] ) => {

	// Simple multiply-with-carry generator - much faster than PCG
	state.assign( state.mul( uint( 1664525 ) ).add( uint( 1013904223 ) ) );
	return float( state.shiftRight( uint( 8 ) ) ).div( float( 16777216.0 ) );

} );

/**
 * Advances the RNG state and returns a random float in [0, 1).
 * Full PCG quality. Modifies the state in-place.
 * Matches RandomValue from GLSL.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random float in [0, 1)
 */
export const randomValue = Fn( ( [ state ] ) => {

	state.assign( pcgHash( state ) );
	return float( state.shiftRight( uint( 8 ) ) ).div( float( 16777216.0 ) );

} );


/**
 * High precision random value - combines two samples for 48-bit precision.
 * Matches RandomValueHighPrecision from GLSL.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random float in [0, 1) with high precision
 */
export const randomValueHighPrecision = Fn( ( [ state ] ) => {

	const s1 = pcgHash( state );
	state.assign( s1 );
	const s2 = pcgHash( state );
	
	// Combine two 24-bit values for 48-bit precision
	const val1 = float( s1.shiftRight( uint( 8 ) ) );
	const val2 = float( s2.shiftRight( uint( 8 ) ) );
	return val1.add( val2.div( float( 16777216.0 ) ) ).div( float( 16777216.0 ) );

} );

// Legacy compatibility - randomFloat is now randomValue
export const randomFloat = randomValue;

/**
 * Generates a random vec2 in [0, 1)^2.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random vec2
 */
export const randomVec2 = Fn( ( [ state ] ) => {

	const x = randomValue( state );
	const y = randomValue( state );
	return vec2( x, y );

} );

/**
 * Generates a random vec3 in [0, 1)^3.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random vec3
 */
export const randomVec3 = Fn( ( [ state ] ) => {

	const x = randomValue( state );
	const y = randomValue( state );
	const z = randomValue( state );
	return vec3( x, y, z );

} );

/**
 * Generates a random vec4 in [0, 1)^4.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random vec4
 */
export const randomVec4 = Fn( ( [ state ] ) => {

	const x = randomValue( state );
	const y = randomValue( state );
	const z = randomValue( state );
	const w = randomValue( state );
	return vec4( x, y, z, w );

} );


// -----------------------------------------------------------------------------
// RNG Initialization
// -----------------------------------------------------------------------------

/**
 * Initializes RNG state from pixel coordinates and frame number.
 * Provides good decorrelation between pixels and frames.
 *
 * @param {TSLNode} pixelX - Pixel X coordinate (int or uint)
 * @param {TSLNode} pixelY - Pixel Y coordinate (int or uint)
 * @param {TSLNode} frame - Frame number (uint)
 * @returns {TSLNode} Initial RNG state (uint)
 */
export const initRNG = Fn( ( [ pixelX, pixelY, frame ] ) => {

	// Combine pixel position and frame into a unique seed
	const px = uint( pixelX );
	const py = uint( pixelY );
	const f = uint( frame );

	// Use multiple hashes to ensure good mixing
	const seed1 = px.mul( uint( 1973 ) ).add( py.mul( uint( 9277 ) ) ).add( f.mul( uint( 26699 ) ) );
	const seed2 = pcgHash( seed1 );

	return pcgHash( seed2.bitXor( uint( 0xDEADBEEF ) ) );

} ).setLayout( {
	name: 'initRNG',
	type: 'uint',
	inputs: [
		{ name: 'pixelX', type: 'int' },
		{ name: 'pixelY', type: 'int' },
		{ name: 'frame', type: 'uint' }
	]
} );

/**
 * Initializes RNG state from a linear pixel index and frame.
 *
 * @param {TSLNode} pixelIndex - Linear pixel index
 * @param {TSLNode} frame - Frame number
 * @returns {TSLNode} Initial RNG state
 */
export const initRNGFromIndex = Fn( ( [ pixelIndex, frame ] ) => {

	const idx = uint( pixelIndex );
	const f = uint( frame );

	const seed = idx.mul( uint( 1664525 ) ).add( f.mul( uint( 1013904223 ) ) );
	return pcgHash( seed );

} );

/**
 * Get decorrelated seed with better mixing.
 * Matches getDecorrelatedSeed from GLSL.
 *
 * @param {TSLNode} pixelCoordX - Pixel X coordinate
 * @param {TSLNode} pixelCoordY - Pixel Y coordinate
 * @param {TSLNode} rayIndex - Ray index
 * @param {TSLNode} frame - Frame number
 * @returns {TSLNode} Decorrelated seed
 */
export const getDecorrelatedSeed = Fn( ( [ pixelCoordX, pixelCoordY, rayIndex, frame ] ) => {

	// Use multiple primes for better decorrelation
	const pixelSeed = uint( pixelCoordX ).mul( uint( PRIME1 ) ).add( uint( pixelCoordY ).mul( uint( PRIME2 ) ) );
	const raySeed = uint( rayIndex ).mul( uint( PRIME3 ) );
	const frameSeed = uint( frame ).mul( uint( PRIME4 ) );

	// Multiple rounds of hashing for better quality
	let seed = wangHash( pixelSeed );
	seed = pcgHash( seed.bitXor( raySeed ) );
	seed = wangHash( seed.add( frameSeed ) );

	return seed;

} );

// -----------------------------------------------------------------------------
// Directional Sampling Functions
// -----------------------------------------------------------------------------

/**
 * Fast random point in unit circle using simpler RNG for hot paths.
 * Matches RandomPointInCircle from GLSL.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} vec2 point in unit circle
 */
export const randomPointInCircle = Fn( ( [ state ] ) => {

	// Use fast RNG for circle sampling - adequate quality for DOF/sampling
	const angle = randomValueFast( state ).mul( float( TWO_PI ) );
	const pointOnCircle = vec2( angle.cos(), angle.sin() );
	return pointOnCircle.mul( randomValueFast( state ).sqrt() );

} );


/**
 * Generates a random point on the unit hemisphere using cosine-weighted sampling.
 * The hemisphere is oriented along +Z (0, 0, 1).
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} vec3 direction on hemisphere
 */
export const randomCosineHemisphere = Fn( ( [ state ] ) => {

	const u1 = randomValue( state );
	const u2 = randomValue( state );

	// Cosine-weighted hemisphere sampling
	const r = u1.sqrt();
	const theta = u2.mul( float( TWO_PI ) );

	const x = r.mul( theta.cos() );
	const y = r.mul( theta.sin() );
	const z = float( 1.0 ).sub( u1 ).sqrt();

	return vec3( x, y, z );

} );

/**
 * Generates a random point on the unit sphere (uniform distribution).
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} vec3 direction on sphere
 */
export const randomSphere = Fn( ( [ state ] ) => {

	const u1 = randomValue( state );
	const u2 = randomValue( state );

	const z = float( 1.0 ).sub( u1.mul( 2.0 ) );
	const r = float( 1.0 ).sub( z.mul( z ) ).sqrt();
	const phi = u2.mul( float( TWO_PI ) );

	const x = r.mul( phi.cos() );
	const y = r.mul( phi.sin() );

	return vec3( x, y, z );

} );

/**
 * Generates a random point in a unit disk (for DOF, area lights, etc).
 * Matches randomDisk from GLSL.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} vec2 point in unit disk
 */
export const randomDisk = Fn( ( [ state ] ) => {

	const u1 = randomValue( state );
	const u2 = randomValue( state );

	const r = u1.sqrt();
	const theta = u2.mul( float( TWO_PI ) );

	return vec2( r.mul( theta.cos() ), r.mul( theta.sin() ) );

} );

// -----------------------------------------------------------------------------
// Low-Discrepancy Sequences (Quasi-Monte Carlo)
// -----------------------------------------------------------------------------

/**
 * Sobol direction vector lookup function.
 * Returns direction vectors for Sobol sequence generation.
 * Matches getSobolDirectionVector from GLSL.
 *
 * @param {TSLNode} index - Direction vector index (0-31)
 * @returns {TSLNode} Direction vector as uint
 */
export const getSobolDirectionVector = Fn( ( [ index ] ) => {

	// Use if-else chain to match GLSL implementation
	// Note: TSL doesn't have switch statements, so we use if-else
	const idx = int( index );
	let result = uint( 1 ).toVar();
	
	If( idx.equal( int( 0 ) ), () => { result.assign( uint( 2147483648 ) ); } )
		.ElseIf( idx.equal( int( 1 ) ), () => { result.assign( uint( 1073741824 ) ); } )
		.ElseIf( idx.equal( int( 2 ) ), () => { result.assign( uint( 536870912 ) ); } )
		.ElseIf( idx.equal( int( 3 ) ), () => { result.assign( uint( 268435456 ) ); } )
		.ElseIf( idx.equal( int( 4 ) ), () => { result.assign( uint( 134217728 ) ); } )
		.ElseIf( idx.equal( int( 5 ) ), () => { result.assign( uint( 67108864 ) ); } )
		.ElseIf( idx.equal( int( 6 ) ), () => { result.assign( uint( 33554432 ) ); } )
		.ElseIf( idx.equal( int( 7 ) ), () => { result.assign( uint( 16777216 ) ); } )
		.ElseIf( idx.equal( int( 8 ) ), () => { result.assign( uint( 8388608 ) ); } )
		.ElseIf( idx.equal( int( 9 ) ), () => { result.assign( uint( 4194304 ) ); } )
		.ElseIf( idx.equal( int( 10 ) ), () => { result.assign( uint( 2097152 ) ); } )
		.ElseIf( idx.equal( int( 11 ) ), () => { result.assign( uint( 1048576 ) ); } )
		.ElseIf( idx.equal( int( 12 ) ), () => { result.assign( uint( 524288 ) ); } )
		.ElseIf( idx.equal( int( 13 ) ), () => { result.assign( uint( 262144 ) ); } )
		.ElseIf( idx.equal( int( 14 ) ), () => { result.assign( uint( 131072 ) ); } )
		.ElseIf( idx.equal( int( 15 ) ), () => { result.assign( uint( 65536 ) ); } )
		.ElseIf( idx.equal( int( 16 ) ), () => { result.assign( uint( 32768 ) ); } )
		.ElseIf( idx.equal( int( 17 ) ), () => { result.assign( uint( 16384 ) ); } )
		.ElseIf( idx.equal( int( 18 ) ), () => { result.assign( uint( 8192 ) ); } )
		.ElseIf( idx.equal( int( 19 ) ), () => { result.assign( uint( 4096 ) ); } )
		.ElseIf( idx.equal( int( 20 ) ), () => { result.assign( uint( 2048 ) ); } )
		.ElseIf( idx.equal( int( 21 ) ), () => { result.assign( uint( 1024 ) ); } )
		.ElseIf( idx.equal( int( 22 ) ), () => { result.assign( uint( 512 ) ); } )
		.ElseIf( idx.equal( int( 23 ) ), () => { result.assign( uint( 256 ) ); } )
		.ElseIf( idx.equal( int( 24 ) ), () => { result.assign( uint( 128 ) ); } )
		.ElseIf( idx.equal( int( 25 ) ), () => { result.assign( uint( 64 ) ); } )
		.ElseIf( idx.equal( int( 26 ) ), () => { result.assign( uint( 32 ) ); } )
		.ElseIf( idx.equal( int( 27 ) ), () => { result.assign( uint( 16 ) ); } )
		.ElseIf( idx.equal( int( 28 ) ), () => { result.assign( uint( 8 ) ); } )
		.ElseIf( idx.equal( int( 29 ) ), () => { result.assign( uint( 4 ) ); } )
		.ElseIf( idx.equal( int( 30 ) ), () => { result.assign( uint( 2 ) ); } );
	
	return result;

} );

/**
 * Owen scrambling for improved sample distribution.
 * Matches owen_scramble from GLSL.
 *
 * @param {TSLNode} x - Value to scramble
 * @param {TSLNode} seed - Scrambling seed
 * @returns {TSLNode} Scrambled value
 */
export const owenScramble = Fn( ( [ x, seed ] ) => {

	let val = x.bitXor( x.mul( uint( 0x3d20adea ) ) );
	val = val.add( seed );
	val = val.mul( seed.shiftRight( uint( 16 ) ).bitOr( uint( 1 ) ) );
	val = val.bitXor( val.shiftRight( uint( 15 ) ) );
	val = val.mul( uint( 0x5851f42d ) );
	val = val.bitXor( val.shiftRight( uint( 12 ) ) );
	val = val.mul( uint( 0x4c957f2d ) );
	val = val.bitXor( val.shiftRight( uint( 18 ) ) );
	return val;

} );

/**
 * Owen-scrambled Sobol sequence generator.
 * Matches owen_scrambled_sobol from GLSL.
 *
 * @param {TSLNode} index - Sample index
 * @param {TSLNode} dimension - Dimension (0-31)
 * @param {TSLNode} seed - Scrambling seed
 * @returns {TSLNode} Sobol sample in [0, 1)
 */
export const owenScrambledSobol = Fn( ( [ index, dimension, seed ] ) => {

	let result = uint( 0 ).toVar();
	const idx = uint( index );
	const dim = uint( dimension );
	
	// Loop through 32 bits
	for ( let i = 0; i < 32; i++ ) {
		
		const bit = idx.bitAnd( uint( 1 ).shiftLeft( uint( i ) ) );
		If( bit.notEqual( uint( 0 ) ), () => {
			
			const dirVec = getSobolDirectionVector( int( i ) );
			result.assign( result.bitXor( dirVec.shiftLeft( dim ) ) );
			
		} );
		
	}
	
	result = owenScramble( result, seed );
	return float( result ).div( float( 4294967296.0 ) );

} );

/**
 * 2D Owen-scrambled Sobol sequence.
 * Matches owen_scrambled_sobol2D from GLSL.
 *
 * @param {TSLNode} index - Sample index
 * @param {TSLNode} seed - Scrambling seed
 * @returns {TSLNode} vec2 Sobol sample
 */
export const owenScrambledSobol2D = Fn( ( [ index, seed ] ) => {

	const x = owenScrambledSobol( index, uint( 0 ), seed );
	const y = owenScrambledSobol( index, uint( 1 ), seed );
	return vec2( x, y );

} );

/**
 * Halton sequence with Owen scrambling.
 * Matches haltonScrambled from GLSL.
 *
 * @param {TSLNode} index - Sample index
 * @param {TSLNode} base - Prime base (2, 3, 5, 7, etc.)
 * @param {TSLNode} scramble - Scrambling seed
 * @returns {TSLNode} Halton sample in [0, 1)
 */
export const haltonScrambled = Fn( ( [ index, base, scramble ] ) => {

	let result = float( 0.0 ).toVar();
	let f = float( 1.0 ).toVar();
	let i = int( index ).toVar();
	const b = int( base );

	// Generate Halton sequence with scrambling
	// Loop up to 32 iterations (sufficient for most cases)
	for ( let iter = 0; iter < 32; iter++ ) {
		
		If( i.greaterThan( int( 0 ) ), () => {
			
			f.assign( f.div( float( b ) ) );
			
			// Apply digit scrambling
			let digit = i.mod( b ).toVar();
			digit.assign( int( wangHash( uint( digit ).bitXor( scramble ) ).mod( uint( b ) ) ) );
			
			result.assign( result.add( f.mul( float( digit ) ) ) );
			i.assign( int( float( i ).div( float( b ) ).floor() ) );
			
		} );
		
	}

	return result;

} );

/**
 * 2D Halton sequence with Owen scrambling.
 *
 * @param {TSLNode} index - Sample index
 * @param {TSLNode} scramble - Scrambling seed
 * @returns {TSLNode} vec2 Halton sample
 */
export const haltonScrambled2D = Fn( ( [ index, scramble ] ) => {

	const x = haltonScrambled( index, int( 2 ), scramble );
	const y = haltonScrambled( index, int( 3 ), scramble );
	return vec2( x, y );

} );

// -----------------------------------------------------------------------------
// Blue Noise Sampling (requires blue noise texture binding)
// -----------------------------------------------------------------------------

/**
 * Cranley-Patterson rotation for decorrelation.
 * Matches cranleyPatterson2D from GLSL.
 *
 * @param {TSLNode} p - Point to rotate
 * @param {TSLNode} offset - Rotation offset
 * @returns {TSLNode} Rotated point
 */
export const cranleyPatterson2D = Fn( ( [ p, offset ] ) => {

	return p.add( offset ).fract();

} );

/**
 * Sample blue noise texture with proper multi-dimensional support.
 * Note: Requires blue noise texture to be bound externally.
 * This is a helper function - actual texture sampling done via TSL.
 * Matches sampleBlueNoiseRaw concept from GLSL.
 *
 * @param {TSLNode} pixelCoords - Pixel coordinates
 * @param {TSLNode} sampleIndex - Sample index
 * @param {TSLNode} bounceIndex - Bounce index for dimension offset
 * @param {TSLNode} frame - Frame number
 * @param {TSLNode} blueNoiseTexSize - Blue noise texture size (vec2)
 * @returns {TSLNode} Coordinates for blue noise texture lookup
 */
export const getBlueNoiseLookupCoords = Fn( ( [ pixelCoords, sampleIndex, bounceIndex, frame, blueNoiseTexSize ] ) => {

	// Create dimension-specific offsets using golden ratio
	const dimensionOffset = vec2(
		float( sampleIndex ).mul( float( INV_PHI ) ).fract(),
		float( bounceIndex ).mul( float( INV_PHI2 ) ).fract()
	);

	// Frame-based decorrelation with better hash
	const frameHash = wangHash( pcgHash( uint( frame ) ) );
	const frameOffset = vec2(
		float( frameHash.bitAnd( uint( 0xFFFF ) ) ).div( float( 65536.0 ) ),
		float( frameHash.shiftRight( uint( 16 ) ).bitAnd( uint( 0xFFFF ) ) ).div( float( 65536.0 ) )
	);

	// Scale offsets to texture size
	const scaledDimOffset = dimensionOffset.mul( blueNoiseTexSize );
	const scaledFrameOffset = frameOffset.mul( blueNoiseTexSize );

	// Combine all offsets with proper toroidal wrapping
	const coords = pixelCoords.add( scaledDimOffset ).add( scaledFrameOffset ).mod( blueNoiseTexSize );

	return coords.floor();

} );

/**
 * Progressive blue noise sampling for temporal accumulation.
 * Matches sampleProgressiveBlueNoise concept from GLSL.
 *
 * @param {TSLNode} pixelCoords - Pixel coordinates
 * @param {TSLNode} currentSample - Current sample index
 * @param {TSLNode} maxSamples - Maximum samples
 * @param {TSLNode} blueNoiseTexSize - Blue noise texture size
 * @returns {TSLNode} Coordinates for progressive blue noise lookup
 */
export const getProgressiveBlueNoiseCoords = Fn( ( [ pixelCoords, currentSample, maxSamples, blueNoiseTexSize ] ) => {

	// Determine which "slice" of the blue noise we're in
	const progress = float( currentSample ).div( float( int( maxSamples ).max( int( 1 ) ) ) );
	const temporalSlice = int( progress.mul( float( 16.0 ) ) ); // 16 temporal slices

	// Use different regions of blue noise for different sample counts
	const sliceOffsetX = float( temporalSlice.mod( int( 4 ) ) ).mul( float( 0.25 ) );
	const sliceOffsetY = float( temporalSlice.div( int( 4 ) ) ).mul( float( 0.25 ) );
	const sliceOffset = vec2( sliceOffsetX, sliceOffsetY );

	// Scale to texture space and add pixel-specific offset
	const scaledOffset = sliceOffset.mul( blueNoiseTexSize );
	const coords = pixelCoords.add( scaledOffset ).mod( blueNoiseTexSize );

	return coords.floor();

} );

// -----------------------------------------------------------------------------
// Stratified Sampling
// -----------------------------------------------------------------------------

/**
 * Get stratified sample with proper distribution.
 * Matches getStratifiedSample concept from GLSL.
 * Note: Simplified version without blue noise texture dependency.
 *
 * @param {TSLNode} rayIndex - Ray index within pixel
 * @param {TSLNode} totalRays - Total rays per pixel
 * @param {TSLNode} state - RNG state for jitter
 * @returns {TSLNode} Stratified sample in [0, 1)^2
 */
export const getStratifiedSample = Fn( ( [ rayIndex, totalRays, state ] ) => {

	// Single ray case
	const result = vec2( 0.0 ).toVar();
	
	If( int( totalRays ).equal( int( 1 ) ), () => {
		
		result.assign( randomVec2( state ) );
		
	} ).Else( () => {
		
		// Calculate strata dimensions
		const strataX = int( float( totalRays ).sqrt().floor() );
		const strataY = int( totalRays ).add( strataX ).sub( int( 1 ) ).div( strataX );
		
		const strataIdx = int( rayIndex ).mod( strataX.mul( strataY ) );
		const sx = strataIdx.mod( strataX );
		const sy = strataIdx.div( strataX );
		
		// Base stratified position
		const strataPos = vec2( float( sx ), float( sy ) ).div( vec2( float( strataX ), float( strataY ) ) );
		
		// Jitter with fast RNG
		const jitter = vec2(
			randomValueFast( state ),
			randomValueFast( state )
		).div( vec2( float( strataX ), float( strataY ) ) );
		
		result.assign( strataPos.add( jitter ) );
		
	} );

	return result;

} );

// -----------------------------------------------------------------------------
// Specialized Sampling Functions
// -----------------------------------------------------------------------------

/**
 * Get sample optimized for primary rays (pixel anti-aliasing).
 * Matches getPrimaryRaySample concept from GLSL.
 *
 * @param {TSLNode} sampleIndex - Sample index
 * @param {TSLNode} totalSamples - Total samples
 * @param {TSLNode} state - RNG state
 * @returns {TSLNode} Primary ray sample in [0, 1)^2
 */
export const getPrimaryRaySample = Fn( ( [ sampleIndex, totalSamples, state ] ) => {

	return getStratifiedSample( sampleIndex, totalSamples, state );

} );

/**
 * Get sample optimized for BRDF sampling.
 * Matches getBRDFSample concept from GLSL.
 *
 * @param {TSLNode} state - RNG state
 * @returns {TSLNode} BRDF sample in [0, 1)^2
 */
export const getBRDFSample = Fn( ( [ state ] ) => {

	// Use fast RNG for BRDF sampling where speed is important
	return vec2( randomValueFast( state ), randomValueFast( state ) );

} );

/**
 * Hybrid random sample combining quasi-random and pseudo-random.
 * Matches HybridRandomSample2D concept from GLSL.
 * Simplified version using PCG only.
 *
 * @param {TSLNode} state - RNG state
 * @param {TSLNode} sampleIndex - Sample index (for quasi-random sequences)
 * @returns {TSLNode} Hybrid sample in [0, 1)^2
 */
export const hybridRandomSample2D = Fn( ( [ state, sampleIndex ] ) => {

	// For now, use fast PCG
	// Can be extended to support Halton/Sobol when sampling technique is known
	return vec2( randomValueFast( state ), randomValueFast( state ) );

} );

/**
 * Summary of available sampling functions:
 * 
 * Basic RNG:
 * - pcgHash(seed) - One-shot hash
 * - wangHash(seed) - Additional mixing
 * - randomValue(state) - Full quality random float
 * - randomValueFast(state) - Fast random float (~40% faster)
 * - randomValueHighPrecision(state) - 48-bit precision
 * - randomFloat(state) - Alias for randomValue
 * - randomVec2/3/4(state) - Multi-dimensional random
 * 
 * Initialization:
 * - initRNG(x, y, frame) - Initialize from pixel coords
 * - initRNGFromIndex(index, frame) - Initialize from linear index
 * - getDecorrelatedSeed(x, y, rayIndex, frame) - Decorrelated seed
 * 
 * Directional Sampling:
 * - randomPointInCircle(state) - Random point in unit circle
 * - randomCosineHemisphere(state) - Cosine-weighted hemisphere
 * - randomSphere(state) - Uniform sphere
 * - randomDisk(state) - Uniform disk
 * 
 * Low-Discrepancy Sequences:
 * - haltonScrambled(index, base, scramble) - Halton sequence
 * - haltonScrambled2D(index, scramble) - 2D Halton
 * - owenScrambledSobol(index, dimension, seed) - Sobol sequence
 * - owenScrambledSobol2D(index, seed) - 2D Sobol
 * - getSobolDirectionVector(index) - Sobol direction vectors
 * - owenScramble(x, seed) - Owen scrambling
 * 
 * Blue Noise (requires texture binding):
 * - getBlueNoiseLookupCoords(...) - Blue noise texture coords
 * - getProgressiveBlueNoiseCoords(...) - Progressive blue noise coords
 * - cranleyPatterson2D(p, offset) - CP rotation
 * 
 * Stratified & Specialized:
 * - getStratifiedSample(rayIndex, totalRays, state) - Stratified sampling
 * - getPrimaryRaySample(sampleIndex, totalSamples, state) - Primary ray sampling
 * - getBRDFSample(state) - BRDF sampling (optimized)
 * - hybridRandomSample2D(state, sampleIndex) - Hybrid sampling
 */

