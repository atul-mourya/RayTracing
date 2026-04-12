// Three.js Transpiler r182

import { uniform, texture, textureSize, float, If, Fn, wgslFn, uint, TWO_PI, cos, sin, vec2, sqrt, fract, mod, floor, ivec2, select, Switch, max, int, vec4, mix } from 'three/tsl';
import { DataTexture, FloatType } from 'three';

// -----------------------------------------------------------------------------
// Uniform declarations and constants
// -----------------------------------------------------------------------------

export const samplingTechniqueUniform = uniform( 0, 'int' );
const samplingTechnique = samplingTechniqueUniform;

// 0: PCG, 1: Halton, 2: Sobol, 3: Blue Noise

// 1x1 placeholder — real texture assigned later via blueNoiseTextureNode.value = ...
const _placeholderData = new Float32Array( [ 0.5, 0.5, 0.5, 1.0 ] );
const _placeholderTex = new DataTexture( _placeholderData, 1, 1 );
_placeholderTex.type = FloatType;
_placeholderTex.needsUpdate = true;

export const blueNoiseTextureNode = texture( _placeholderTex );
blueNoiseTextureNode.setUpdateMatrix( false ); // No UV transform — we provide our own integer coords
const blueNoiseTextureSize = vec2( textureSize( blueNoiseTextureNode ) );

// Golden ratio constants for dimension decorrelation

const INV_PHI = float( 0.61803398875 );
const INV_PHI2 = float( 0.38196601125 );

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
// Blue noise sampling with proper multi-dimensional support
// -----------------------------------------------------------------------------
// Cranley-Patterson rotation for decorrelation

export const cranleyPatterson2D = /*@__PURE__*/ wgslFn( `
	fn cranleyPatterson2D( p: vec2f, offset: vec2f ) -> vec2f {

		return fract( p + offset );

	}
` );

// Improved blue noise sampling that properly uses all parameters

export const sampleBlueNoiseRaw = /*@__PURE__*/ Fn( ( [ pixelCoords, sampleIndex, bounceIndex, frame ] ) => {

	// Create dimension-specific offsets using golden ratio

	const dimensionOffset = vec2( fract( float( sampleIndex ).mul( INV_PHI ) ), fract( float( bounceIndex ).mul( INV_PHI2 ) ) );

	// Frame-based decorrelation with better hash

	const frameHash = wang_hash( { seed: pcgHash( { state: uint( frame ) } ) } );
	const frameOffset = vec2( float( frameHash.bitAnd( 0xFFFF ) ).div( 65536.0 ), float( frameHash.shiftRight( 16 ).bitAnd( 0xFFFF ) ).div( 65536.0 ) );

	// Scale offsets to texture size

	const scaledDimOffset = dimensionOffset.mul( vec2( blueNoiseTextureSize ) );
	const scaledFrameOffset = frameOffset.mul( vec2( blueNoiseTextureSize ) );

	// Combine all offsets with proper toroidal wrapping

	const coords = mod( pixelCoords.add( scaledDimOffset ).add( scaledFrameOffset ), vec2( blueNoiseTextureSize ) );

	// Ensure positive coordinates and fetch
	// .load() → textureLoad() in WGSL: exact integer texel fetch, no filtering (≡ GLSL texelFetch)

	const texCoord = ivec2( floor( coords ) );

	return blueNoiseTextureNode.load( texCoord );

}, { pixelCoords: 'vec2', sampleIndex: 'int', bounceIndex: 'int', frame: 'int', return: 'vec4' } );

// Get 2D blue noise sample with dimension offset

export const sampleBlueNoise2D = /*@__PURE__*/ Fn( ( [ pixelCoords, sampleIndex, dimensionBase, frame ] ) => {

	// For 2D sampling, we need to carefully select components to maintain blue noise properties

	const noise = sampleBlueNoiseRaw( pixelCoords, sampleIndex, dimensionBase.div( int( 2 ) ), frame );

	// Use different component pairs based on dimension

	const pairIndex = mod( dimensionBase.div( int( 2 ) ), int( 6 ) );

	const result = vec2( 0.0 ).toVar();

	Switch( pairIndex )
		.Case( 0, () => {

			result.assign( noise.xy );

		} ).Case( 1, () => {

			result.assign( noise.zw );

		} ).Case( 2, () => {

			result.assign( noise.xz );

		} ).Case( 3, () => {

			result.assign( noise.yw );

		} ).Case( 4, () => {

			result.assign( noise.xw );

		} ).Case( 5, () => {

			result.assign( noise.yz );

		} ).Default( () => {

			result.assign( noise.xy );

		} );

	return result;

}, { pixelCoords: 'vec2', sampleIndex: 'int', dimensionBase: 'int', return: 'vec2', frame: 'int' } );

// Progressive blue noise sampling for temporal accumulation

export const sampleProgressiveBlueNoise = /*@__PURE__*/ Fn( ( [ pixelCoords, currentSample, maxSamples, frame ] ) => {

	// Determine which "slice" of the blue noise we're in

	const progress = float( currentSample ).div( max( 1.0, float( maxSamples ) ) );
	const temporalSlice = int( progress.mul( 16.0 ) );

	// 16 temporal slices
	// Use different regions of blue noise for different sample counts

	const sliceOffset = vec2( float( mod( temporalSlice, int( 4 ) ) ).mul( 0.25 ), float( temporalSlice.div( int( 4 ) ) ).mul( 0.25 ) );

	// Scale to texture space and add pixel-specific offset

	const scaledOffset = sliceOffset.mul( vec2( blueNoiseTextureSize ) );
	const coords = mod( pixelCoords.add( scaledOffset ), vec2( blueNoiseTextureSize ) );
	const noise = sampleBlueNoiseRaw( coords, currentSample, int( 0 ), frame );

	// Apply additional Cranley-Patterson rotation for better distribution

	const seed = pcgHash( { state: uint( currentSample ).bitXor( wang_hash( { seed: uint( maxSamples ) } ) ) } );
	const rotation = vec2( float( seed.bitAnd( 0xFFFF ) ).div( 65536.0 ), float( seed.shiftRight( 16 ).bitAnd( 0xFFFF ) ).div( 65536.0 ) );

	return cranleyPatterson2D( { p: noise.xy, offset: rotation } );

}, { pixelCoords: 'vec2', currentSample: 'int', maxSamples: 'int', return: 'vec2', frame: 'int' } );

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

		// Blue Noise (technique 3)
		const dimensionOffset = bounceIndex.mul( 4 );

		If( dimensions.lessThanEqual( int( 2 ) ), () => {

			const _sample = sampleBlueNoise2D( pixelCoord, sampleIndex, dimensionOffset, frame );
			result.x.assign( _sample.x );
			result.y.assign( _sample.y );

		} ).Else( () => {

			const _sample1 = sampleBlueNoise2D( pixelCoord, sampleIndex, dimensionOffset, frame );
			const _sample2 = sampleBlueNoise2D( pixelCoord, sampleIndex, dimensionOffset.add( 2 ), frame );
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

		// Enhanced jitter based on sampling technique with blue noise fallback for better convergence

		const jitter = vec2( 0.0 ).toVar();

		If( samplingTechnique.greaterThanEqual( int( 3 ) ), () => {

			// Blue noise - improved progressive sampling

			jitter.assign( sampleProgressiveBlueNoise( pixelCoord, rayIndex, totalRays, frame ) );

		} ).Else( () => {

			// Enhanced fallback: use fast sampling with slight blue noise influence for better convergence
			// .toVar() on each call to capture value before next state advance

			const j1 = RandomValueFast( rngState ).toVar();
			const j2 = RandomValueFast( rngState ).toVar();
			jitter.assign( vec2( j1, j2 ) );

			// Add subtle blue noise influence even for non-blue-noise techniques

			If( totalRays.greaterThan( int( 4 ) ), () => {

				// Only for multi-sample scenarios

				const blueNoiseInfluence = sampleBlueNoise2D( pixelCoord, rayIndex, int( 0 ), frame ).mul( 0.1 );
				jitter.assign( mix( jitter, blueNoiseInfluence, 0.2 ) );

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

