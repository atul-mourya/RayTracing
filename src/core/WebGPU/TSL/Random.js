import { Fn, float, uint, int, vec2, vec3 } from 'three/tsl';

/**
 * PCG (Permuted Congruential Generator) random number generator for TSL.
 * Provides high-quality pseudo-random numbers for path tracing.
 *
 * Based on PCG-RXS-M-XS variant.
 */

/**
 * PCG hash function - generates a pseudo-random uint from a seed.
 * This is a one-shot hash, not a stateful RNG.
 *
 * @param {TSLNode} seed - Input uint seed
 * @returns {TSLNode} Pseudo-random uint
 */
export const pcgHash = Fn( ( [ seed ] ) => {

	// PCG-RXS-M-XS variant
	const state = seed.mul( uint( 747796405 ) ).add( uint( 2891336453 ) );
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
 * Advances the RNG state and returns a random float in [0, 1).
 * Modifies the state in-place (state should be a .toVar()).
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random float in [0, 1)
 */
export const randomFloat = Fn( ( [ state ] ) => {

	// LCG step
	state.assign( state.mul( uint( 747796405 ) ).add( uint( 2891336453 ) ) );

	// PCG output permutation
	const word = state.shiftRight( state.shiftRight( uint( 28 ) ).add( uint( 4 ) ) ).bitXor( state ).mul( uint( 277803737 ) );
	const result = word.shiftRight( uint( 22 ) ).bitXor( word );

	// Convert to float [0, 1)
	return float( result ).div( float( 4294967295.0 ) );

} );

/**
 * Generates a random vec2 in [0, 1)^2.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random vec2
 */
export const randomVec2 = Fn( ( [ state ] ) => {

	const x = randomFloat( state );
	const y = randomFloat( state );
	return vec2( x, y );

} );

/**
 * Generates a random vec3 in [0, 1)^3.
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} Random vec3
 */
export const randomVec3 = Fn( ( [ state ] ) => {

	const x = randomFloat( state );
	const y = randomFloat( state );
	const z = randomFloat( state );
	return vec3( x, y, z );

} );

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
 * Generates a random point on the unit hemisphere using cosine-weighted sampling.
 * The hemisphere is oriented along +Z (0, 0, 1).
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} vec3 direction on hemisphere
 */
export const randomCosineHemisphere = Fn( ( [ state ] ) => {

	const u1 = randomFloat( state );
	const u2 = randomFloat( state );

	// Cosine-weighted hemisphere sampling
	const r = u1.sqrt();
	const theta = u2.mul( float( 2.0 * Math.PI ) );

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

	const u1 = randomFloat( state );
	const u2 = randomFloat( state );

	const z = float( 1.0 ).sub( u1.mul( 2.0 ) );
	const r = float( 1.0 ).sub( z.mul( z ) ).sqrt();
	const phi = u2.mul( float( 2.0 * Math.PI ) );

	const x = r.mul( phi.cos() );
	const y = r.mul( phi.sin() );

	return vec3( x, y, z );

} );

/**
 * Generates a random point in a unit disk (for DOF, area lights, etc).
 *
 * @param {TSLNode} state - Mutable uint state variable
 * @returns {TSLNode} vec2 point in unit disk
 */
export const randomDisk = Fn( ( [ state ] ) => {

	const u1 = randomFloat( state );
	const u2 = randomFloat( state );

	const r = u1.sqrt();
	const theta = u2.mul( float( 2.0 * Math.PI ) );

	return vec2( r.mul( theta.cos() ), r.mul( theta.sin() ) );

} );

