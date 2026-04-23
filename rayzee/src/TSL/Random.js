// Three.js Transpiler r182

import { uniform, texture, float, If, wgslFn, uint, TWO_PI, cos, sin, vec2, sqrt, fract, mod, ivec2, select, int, vec4, mix } from 'three/tsl';
import { DataTexture, FloatType } from 'three';

// -----------------------------------------------------------------------------
// Uniform declarations and constants
// -----------------------------------------------------------------------------

export const samplingTechniqueUniform = uniform( 0, 'int' );
const samplingTechnique = samplingTechniqueUniform;

// 0: PCG, 1: Halton, 2: Sobol, 3: Blue Noise

// 1x1 placeholder — real texture assigned later via .value = ...
const _placeholderData = new Float32Array( [ 0.5, 0.5, 0.5, 1.0 ] );

const _placeholderScalar = new DataTexture( _placeholderData, 1, 1 );
_placeholderScalar.type = FloatType;
_placeholderScalar.needsUpdate = true;

const _placeholderVec2 = new DataTexture( new Float32Array( [ 0.5, 0.5, 0.0, 1.0 ] ), 1, 1 );
_placeholderVec2.type = FloatType;
_placeholderVec2.needsUpdate = true;

// STBN (Spatiotemporal Blue Noise) atlas textures — Heitz 2019
// Each atlas: 1024×1024, 8×8 grid of 128×128 tiles, 64 temporal slices
// Scalar atlas: single-channel (R) — optimal for 1D decisions (RR, lobe selection)
// Vec2 atlas: two-channel (R,G) — decorrelated 2D pairs (direction sampling Xi)
export const stbnScalarTextureNode = texture( _placeholderScalar );
stbnScalarTextureNode.setUpdateMatrix( false );

export const stbnVec2TextureNode = texture( _placeholderVec2 );
stbnVec2TextureNode.setUpdateMatrix( false );

// R2 quasi-random sequence constants (Roberts 2018) — optimal 2D additive offsets
const R2_A1 = float( 0.7548776662466927 );
const R2_A2 = float( 0.5698402909980532 );

// Sobol sequence direction vectors using function lookup for compatibility

// Sobol direction vectors for first dimension — exact port of GLSL
export const getSobolDirectionVector = /*@__PURE__*/ wgslFn( `
	fn getSobolDirectionVector( index: i32 ) -> u32 {

		switch ( index ) {
			case 0:  { return 2147483648u; }
			case 1:  { return 1073741824u; }
			case 2:  { return  536870912u; }
			case 3:  { return  268435456u; }
			case 4:  { return  134217728u; }
			case 5:  { return   67108864u; }
			case 6:  { return   33554432u; }
			case 7:  { return   16777216u; }
			case 8:  { return    8388608u; }
			case 9:  { return    4194304u; }
			case 10: { return    2097152u; }
			case 11: { return    1048576u; }
			case 12: { return     524288u; }
			case 13: { return     262144u; }
			case 14: { return     131072u; }
			case 15: { return      65536u; }
			case 16: { return      32768u; }
			case 17: { return      16384u; }
			case 18: { return       8192u; }
			case 19: { return       4096u; }
			case 20: { return       2048u; }
			case 21: { return       1024u; }
			case 22: { return        512u; }
			case 23: { return        256u; }
			case 24: { return        128u; }
			case 25: { return         64u; }
			case 26: { return         32u; }
			case 27: { return         16u; }
			case 28: { return          8u; }
			case 29: { return          4u; }
			case 30: { return          2u; }
			default: { return          1u; }
		}

	}
` );

// -----------------------------------------------------------------------------
// Basic random number generation
// -----------------------------------------------------------------------------
// PCG (Permuted Congruential Generator) hash function

export const pcgHash = /*@__PURE__*/ wgslFn( `
	fn pcgHash( state: u32 ) -> u32 {

		var s = state;
		s = s * 747796405u + 2891336453u;
		s = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
		s = ( s >> 22u ) ^ s;
		return s;

	}
` );

// Wang hash for additional mixing

export const wang_hash = /*@__PURE__*/ wgslFn( `
	fn wang_hash( seed: u32 ) -> u32 {

		var s = seed;
		s = ( s ^ 61u ) ^ ( s >> 16u );
		s = s * 9u;
		s = s ^ ( s >> 4u );
		s = s * 0x27d4eb2du;
		s = s ^ ( s >> 15u );
		return s;

	}
` );

// OPTIMIZED: Fast random value for hot paths - uses simpler hash for performance
// Performance gain: ~40% faster than full PCG for non-critical samples

// Plain JS functions (not Fn()) — they inline at the call site where `state` is a
// mutable .toVar() variable. This replicates GLSL `inout uint state` semantics:
// the caller's rngState advances on every call.

export const RandomValueFast = ( state ) => {

	// Simple multiply-with-carry generator - much faster than PCG
	state.assign( state.mul( 1664525 ).add( 1013904223 ) );
	return float( state.shiftRight( 8 ) ).mul( 1.0 / 16777216.0 );

};

// Generate random float between 0 and 1 with full PCG quality

export const RandomValue = ( state ) => {

	state.assign( pcgHash( { state } ) );
	return float( state.shiftRight( 8 ) ).mul( 1.0 / 16777216.0 );

};

// Generate random float with better precision

export const RandomValueHighPrecision = ( state ) => {

	// Capture s1 immediately (.toVar()) before advancing state, so it isn't
	// re-evaluated lazily after the second pcgHash advances state further.
	const s1 = pcgHash( { state } ).toVar();
	state.assign( s1 );
	const s2 = pcgHash( { state } ).toVar();

	// Combine two 24-bit values for 48-bit precision
	return float( s1.shiftRight( 8 ) ).add( float( s2.shiftRight( 8 ) ).mul( 1.0 / 16777216.0 ) ).mul( 1.0 / 16777216.0 );

};

// -----------------------------------------------------------------------------
// Directional sampling functions
// -----------------------------------------------------------------------------
// OPTIMIZED: Fast random point in unit circle using simpler RNG for hot paths

export const RandomPointInCircle = ( rngState ) => {

	// Use fast RNG for circle sampling - adequate quality for DOF/sampling
	// .toVar() captures angle immediately so cos/sin don't read state after the 2nd advance
	const angle = RandomValueFast( rngState ).mul( TWO_PI ).toVar();
	const pointOnCircle = vec2( cos( angle ), sin( angle ) );

	return pointOnCircle.mul( sqrt( RandomValueFast( rngState ) ) );

};

// -----------------------------------------------------------------------------
// STBN atlas sampling — proper spatiotemporal blue noise
// -----------------------------------------------------------------------------
// Atlas layout: 8×8 grid of 128×128 tiles = 1024×1024 texture.
// Temporal axis: frame % 64 selects tile (true STBN temporal decorrelation).
// Spatial decorrelation: R2 quasi-random offset keyed on dimension + sample index.

const computeSTBNAtlasCoord = ( pixelCoords, sampleIndex, dimensionIndex, frame ) => {

	// Temporal slice — true STBN temporal axis
	const slice = uint( frame ).bitAnd( uint( 63 ) ); // frame % 64

	// R2 quasi-random spatial offset for per-dimension/per-sample decorrelation
	const n = float( dimensionIndex ).add( float( sampleIndex ).mul( 7.0 ) );
	const offsetX = int( fract( n.mul( R2_A1 ).add( 0.5 ) ).mul( 128.0 ) );
	const offsetY = int( fract( n.mul( R2_A2 ).add( 0.5 ) ).mul( 128.0 ) );

	// Pixel within 128×128 tile (toroidal wrap via bitmask)
	const px = int( pixelCoords.x ).add( offsetX ).bitAnd( int( 127 ) );
	const py = int( pixelCoords.y ).add( offsetY ).bitAnd( int( 127 ) );

	// Atlas tile position from slice index
	const tileCol = int( slice ).bitAnd( int( 7 ) ); // slice % 8
	const tileRow = int( slice ).shiftRight( int( 3 ) ); // slice / 8

	return ivec2( tileCol.mul( int( 128 ) ).add( px ), tileRow.mul( int( 128 ) ).add( py ) );

};

// Sample 1D scalar STBN value in [0,1]
export const sampleSTBNScalar = ( pixelCoords, sampleIndex, dimensionIndex, frame ) => {

	const coord = computeSTBNAtlasCoord( pixelCoords, sampleIndex, dimensionIndex, frame );
	return stbnScalarTextureNode.load( coord ).x;

};

// Sample decorrelated 2D STBN pair in [0,1]²
export const sampleSTBN2D = ( pixelCoords, sampleIndex, dimensionPairIndex, frame ) => {

	const coord = computeSTBNAtlasCoord( pixelCoords, sampleIndex, dimensionPairIndex, frame );
	return stbnVec2TextureNode.load( coord ).xy;

};

// -----------------------------------------------------------------------------
// Low-discrepancy sequence generators
// -----------------------------------------------------------------------------
// Halton sequence generator with per-digit additive scrambling

export const haltonScrambled = /*@__PURE__*/ wgslFn( `
	fn haltonScrambled( index: i32, base: i32, scramble: u32 ) -> f32 {

		var result = 0.0f;
		var f = 1.0f;
		var i = index + 1;
		var s = scramble;
		var iter = 0;

		while ( i > 0 && iter < 32 ) {

			iter += 1;
			f /= f32( base );

			// Additive permutation per digit: (digit + s_k) mod base
			// Guaranteed bijection within [0, base) for any s_k
			var digit = i % base;
			digit = ( digit + i32( s % u32( base ) ) ) % base;
			result += f * f32( digit );
			i /= base;

			// Evolve scramble per digit position for position-dependent permutations
			s = s * 747796405u + 2891336453u;

		}

		return result;

	}
` );

// Owen scrambling for Sobol sequence

export const owen_scramble = /*@__PURE__*/ wgslFn( `
	fn owen_scramble( x: u32, seed: u32 ) -> u32 {

		var v = x;
		v ^= v * 0x3d20adeau;
		v += seed;
		v *= ( seed >> 16u ) | 1u;
		v ^= v >> 15u;
		v *= 0x5851f42du;
		v ^= v >> 12u;
		v *= 0x4c957f2du;
		v ^= v >> 18u;
		return v;

	}
` );

// Owen-scrambled Sobol sequence

export const owen_scrambled_sobol = /*@__PURE__*/ wgslFn( `
	fn owen_scrambled_sobol( index: u32, dimension: u32, seed: u32 ) -> f32 {

		var result = 0u;
		for ( var i = 0; i < 32; i++ ) {

			if ( ( index & ( 1u << u32( i ) ) ) != 0u ) {

				result ^= getSobolDirectionVector( i );

			}

		}

		// Mix dimension into seed for inter-dimensional decorrelation
		// (Van der Corput base is shared; Owen scrambling with distinct seeds
		// produces decorrelated sequences across dimensions)
		let dimSeed = seed ^ ( dimension * 0x9e3779b9u + 0x6a09e667u );
		result = owen_scramble( result, dimSeed );
		return f32( result ) / 4294967296.0f;

	}
`, [ getSobolDirectionVector, owen_scramble ] );

export const owen_scrambled_sobol2D = /*@__PURE__*/ wgslFn( `
	fn owen_scrambled_sobol2D( index: u32, seed: u32 ) -> vec2f {

		return vec2f(
			owen_scrambled_sobol( index, 0u, seed ),
			owen_scrambled_sobol( index, 1u, seed )
		);

	}
`, [ owen_scrambled_sobol ] );

// -----------------------------------------------------------------------------
// Multi-dimensional sampling interface
// -----------------------------------------------------------------------------
// Get N-dimensional sample (up to 4D)

export const getRandomSampleND = ( pixelCoord, sampleIndex, bounceIndex, rngState, dimensions, preferredTechnique, resolution, frame ) => {

	const technique = select( preferredTechnique.notEqual( int( - 1 ) ), preferredTechnique, samplingTechnique );
	const result = vec4( 0.0 ).toVar();

	// PCG (technique 0)
	If( technique.equal( int( 0 ) ), () => {

		// Check useFast once and branch — select() would evaluate both RandomValueFast and
		// RandomValue unconditionally, advancing state twice for each dimension.
		const useFast = dimensions.greaterThan( int( 2 ) );

		If( useFast, () => {

			result.x.assign( RandomValueFast( rngState ) );

			If( dimensions.greaterThan( int( 1 ) ), () => {

				result.y.assign( RandomValueFast( rngState ) );

			} );

			If( dimensions.greaterThan( int( 2 ) ), () => {

				result.z.assign( RandomValueFast( rngState ) );

			} );

			If( dimensions.greaterThan( int( 3 ) ), () => {

				result.w.assign( RandomValueFast( rngState ) );

			} );

		} ).Else( () => {

			result.x.assign( RandomValue( rngState ) );

			If( dimensions.greaterThan( int( 1 ) ), () => {

				result.y.assign( RandomValue( rngState ) );

			} );

			If( dimensions.greaterThan( int( 2 ) ), () => {

				result.z.assign( RandomValue( rngState ) );

			} );

			If( dimensions.greaterThan( int( 3 ) ), () => {

				result.w.assign( RandomValue( rngState ) );

			} );

		} );

	} ).ElseIf( technique.equal( int( 1 ) ), () => {

		// Halton — mix frame + bounceIndex into scramble for temporal and per-bounce decorrelation
		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const scramble = pcgHash( { state: pixelHash.bitXor( frame.mul( uint( 0x9e3779b9 ) ) ).bitXor( uint( bounceIndex ).mul( uint( 0x517cc1b7 ) ) ) } ).toVar();

		result.x.assign( haltonScrambled( { index: sampleIndex, base: int( 2 ), scramble } ) );

		If( dimensions.greaterThan( int( 1 ) ), () => {

			result.y.assign( haltonScrambled( { index: sampleIndex, base: int( 3 ), scramble } ) );

		} );

		If( dimensions.greaterThan( int( 2 ) ), () => {

			result.z.assign( haltonScrambled( { index: sampleIndex, base: int( 5 ), scramble } ) );

		} );

		If( dimensions.greaterThan( int( 3 ) ), () => {

			result.w.assign( haltonScrambled( { index: sampleIndex, base: int( 7 ), scramble } ) );

		} );

	} ).ElseIf( technique.equal( int( 2 ) ), () => {

		// Sobol — mix frame + bounceIndex into seed for temporal and per-bounce decorrelation
		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const seed = pcgHash( { state: pixelHash.bitXor( frame.mul( uint( 0x9e3779b9 ) ) ).bitXor( uint( bounceIndex ).mul( uint( 0x517cc1b7 ) ) ) } ).toVar();

		result.x.assign( owen_scrambled_sobol( { index: uint( sampleIndex ), dimension: uint( 0 ), seed } ) );

		If( dimensions.greaterThan( int( 1 ) ), () => {

			result.y.assign( owen_scrambled_sobol( { index: uint( sampleIndex ), dimension: uint( 1 ), seed } ) );

		} );

		If( dimensions.greaterThan( int( 2 ) ), () => {

			result.z.assign( owen_scrambled_sobol( { index: uint( sampleIndex ), dimension: uint( 2 ), seed } ) );

		} );

		If( dimensions.greaterThan( int( 3 ) ), () => {

			result.w.assign( owen_scrambled_sobol( { index: uint( sampleIndex ), dimension: uint( 3 ), seed } ) );

		} );

	} ).Else( () => {

		// STBN — Spatiotemporal Blue Noise (technique 3)
		// Each bounce uses a block of 4 dimension indices for decorrelation
		const dimBase = bounceIndex.mul( int( 4 ) );

		If( dimensions.lessThanEqual( int( 2 ) ), () => {

			const _sample = sampleSTBN2D( pixelCoord, sampleIndex, dimBase, frame );
			result.x.assign( _sample.x );
			result.y.assign( _sample.y );

		} ).Else( () => {

			const _sample1 = sampleSTBN2D( pixelCoord, sampleIndex, dimBase, frame );
			const _sample2 = sampleSTBN2D( pixelCoord, sampleIndex, dimBase.add( int( 1 ) ), frame );
			result.assign( vec4( _sample1, _sample2 ) );

		} );

	} );

	return result;

};

// -----------------------------------------------------------------------------
// Main sampling interface functions
// -----------------------------------------------------------------------------
// Get random sample based on preferred technique (2D)

export const getRandomSample = ( pixelCoord, sampleIndex, bounceIndex, rngState, preferredTechnique, resolution, frame ) => {

	const sample4D = getRandomSampleND( pixelCoord, sampleIndex, bounceIndex, rngState, int( 2 ), preferredTechnique, resolution, frame );

	return sample4D.xy;

};

// Get stratified sample with proper blue noise support

export const getStratifiedSample = ( pixelCoord, rayIndex, totalRays, rngState, resolution, frame ) => {

	// result variable avoids early-return ReturnNode escaping into outer Fn scope
	const result = vec2( 0.0 ).toVar();

	If( totalRays.lessThanEqual( int( 1 ) ), () => {

		result.assign( getRandomSample( pixelCoord, rayIndex, int( 0 ), rngState, int( - 1 ), resolution, frame ) );

	} ).Else( () => {

		// Calculate strata dimensions

		const strataX = int( sqrt( float( totalRays ) ) );
		const strataY = totalRays.add( strataX ).sub( 1 ).div( strataX );
		const strataIdx = mod( rayIndex, strataX.mul( strataY ) );
		const sx = mod( strataIdx, strataX );
		const sy = strataIdx.div( strataX );

		// Base stratified position

		const strataPos = vec2( float( sx ), float( sy ) ).div( vec2( float( strataX ), float( strataY ) ) );

		// Jitter via STBN or fast RNG fallback

		const jitter = vec2( 0.0 ).toVar();

		If( samplingTechnique.greaterThanEqual( int( 3 ) ), () => {

			// STBN — true spatiotemporal blue noise jitter
			jitter.assign( sampleSTBN2D( pixelCoord, rayIndex, int( 0 ), frame ) );

		} ).Else( () => {

			// Fast RNG with subtle STBN influence for better convergence
			const j1 = RandomValueFast( rngState ).toVar();
			const j2 = RandomValueFast( rngState ).toVar();
			jitter.assign( vec2( j1, j2 ) );

			If( totalRays.greaterThan( int( 4 ) ), () => {

				const stbnInfluence = sampleSTBN2D( pixelCoord, rayIndex, int( 0 ), frame ).mul( 0.1 );
				jitter.assign( mix( jitter, stbnInfluence, 0.2 ) );

			} );

		} );

		jitter.divAssign( vec2( float( strataX ), float( strataY ) ) );

		result.assign( strataPos.add( jitter ) );

	} );

	return result;

};

// Get decorrelated seed with better mixing

export const getDecorrelatedSeed = /*@__PURE__*/ wgslFn( `
	fn getDecorrelatedSeed( pixelCoord: vec2f, rayIndex: i32, frame: u32 ) -> u32 {

		// Use multiple primes for better decorrelation
		let pixelSeed = u32( pixelCoord.x ) * 2654435761u + u32( pixelCoord.y ) * 3266489917u;
		let raySeed = u32( rayIndex ) * 668265263u;
		let frameSeed = frame * 374761393u;

		// Multiple rounds of hashing for better quality
		var seed = wang_hash( pixelSeed );
		seed = pcgHash( seed ^ raySeed );
		seed = wang_hash( seed + frameSeed );
		return seed;

	}
`, [ wang_hash, pcgHash ] );

