import { Fn, vec2, vec3, vec4, float, int, mat4, If, texture, normalize, dot, sin, cos, atan, acos, floor, fract, min, mix, clamp, select } from 'three/tsl';

import { PI, TWO_PI, REC709_LUMINANCE_COEFFICIENTS } from './Common.js';

// Convert direction to UV coordinates for equirectangular map
// Exact implementation from three-gpu-pathtracer
export const equirectDirectionToUv = Fn( ( [ direction, environmentMatrix ] ) => {

	// Apply environment matrix rotation
	const d = normalize( environmentMatrix.mul( vec4( direction, 0.0 ) ).xyz ).toVar();

	// Convert to spherical coordinates
	const uv = vec2( atan( d.z, d.x ), acos( d.y ) ).toVar();
	uv.assign( uv.div( vec2( TWO_PI, PI ) ) );

	// Adjust to [0, 1] range and flip Y
	uv.x.addAssign( 0.5 );
	uv.y.assign( float( 1.0 ).sub( uv.y ) );

	return uv;

} );

// Convert UV coordinates to direction
// Exact implementation from three-gpu-pathtracer
export const equirectUvToDirection = Fn( ( [ uv, environmentMatrix ] ) => {

	// Undo UV adjustments
	const adjustedUv = vec2( uv.x.sub( 0.5 ), float( 1.0 ).sub( uv.y ) ).toVar();

	// Convert from spherical coordinates
	const theta = adjustedUv.x.mul( TWO_PI ).toVar();
	const phi = adjustedUv.y.mul( PI ).toVar();

	const sinPhi = sin( phi ).toVar();

	const localDir = vec3(
		sinPhi.mul( cos( theta ) ),
		cos( phi ),
		sinPhi.mul( sin( theta ) )
	).toVar();

	// Apply inverse environment matrix rotation
	// Using transpose for orthogonal rotation matrix (faster than inverse)
	const transposed = mat4(
		environmentMatrix.element( 0 ).element( 0 ), environmentMatrix.element( 1 ).element( 0 ), environmentMatrix.element( 2 ).element( 0 ), environmentMatrix.element( 3 ).element( 0 ),
		environmentMatrix.element( 0 ).element( 1 ), environmentMatrix.element( 1 ).element( 1 ), environmentMatrix.element( 2 ).element( 1 ), environmentMatrix.element( 3 ).element( 1 ),
		environmentMatrix.element( 0 ).element( 2 ), environmentMatrix.element( 1 ).element( 2 ), environmentMatrix.element( 2 ).element( 2 ), environmentMatrix.element( 3 ).element( 2 ),
		environmentMatrix.element( 0 ).element( 3 ), environmentMatrix.element( 1 ).element( 3 ), environmentMatrix.element( 2 ).element( 3 ), environmentMatrix.element( 3 ).element( 3 )
	).toVar();

	return normalize( transposed.mul( vec4( localDir, 0.0 ) ).xyz );

} );

// Sample environment map color in a given direction
export const sampleEquirectColor = Fn( ( [ environment, direction, environmentMatrix ] ) => {

	return texture( environment, equirectDirectionToUv( direction, environmentMatrix ), 0 ).rgb;

} );

// Calculate PDF for uniform sphere sampling with Jacobian
export const equirectDirectionPdf = Fn( ( [ direction, environmentMatrix ] ) => {

	const uv = equirectDirectionToUv( direction, environmentMatrix ).toVar();
	const theta = uv.y.mul( PI ).toVar();
	const sinTheta = sin( theta ).toVar();

	return select( sinTheta.equal( 0.0 ), float( 0.0 ), float( 1.0 ).div( float( TWO_PI * PI ).mul( sinTheta ) ) );

} );

// Evaluate PDF for a given direction (for MIS)
// Exact implementation from three-gpu-pathtracer
// Returns vec4(color.rgb, pdf) since TSL cannot use inout params
export const sampleEquirect = Fn( ( [ environment, direction, environmentMatrix, envTotalSum, envResolution ] ) => {

	const result = vec4( 0.0 ).toVar();

	If( envTotalSum.equal( 0.0 ), () => {

		// Exclude black environments from MIS
		result.assign( vec4( 0.0 ) );

	} ).Else( () => {

		const uv = equirectDirectionToUv( direction, environmentMatrix ).toVar();
		const color = texture( environment, uv, 0 ).rgb.toVar();

		const lum = dot( color, REC709_LUMINANCE_COEFFICIENTS ).toVar();
		const pdf = lum.div( envTotalSum ).toVar();

		const dirPdf = equirectDirectionPdf( direction, environmentMatrix ).toVar();
		const finalPdf = float( envResolution.x ).mul( float( envResolution.y ) ).mul( pdf ).mul( dirPdf ).toVar();

		result.assign( vec4( color, finalPdf ) );

	} );

	return result;

} );

// Sample environment map using importance sampling
// Returns vec4(direction.xyz, pdf). Optionally writes sampled color to colorOutput.
// Exact implementation from three-gpu-pathtracer
export const sampleEquirectProbability = Fn( ( [
	environment,
	envMarginalWeights,
	envConditionalWeights,
	environmentMatrix,
	environmentIntensity,
	envTotalSum,
	envResolution,
	r,
	colorOutput
] ) => {

	// Sample marginal CDF for V coordinate (1D storage buffer, linear interpolation)
	const marginalSize = envResolution.y;
	const mIdx = clamp( r.x.mul( marginalSize.sub( 1.0 ) ), 0.0, marginalSize.sub( 1.0 ) );
	const mI0 = int( floor( mIdx ) );
	const mI1 = min( mI0.add( 1 ), int( marginalSize ).sub( 1 ) );
	const mFrac = fract( mIdx );
	const v = mix( envMarginalWeights.element( mI0 ), envMarginalWeights.element( mI1 ), mFrac ).toVar();

	// Sample conditional CDF for U coordinate (2D storage buffer, bilinear interpolation)
	const condW = envResolution.x;
	const condH = envResolution.y;
	const cxf = clamp( r.y.mul( condW.sub( 1.0 ) ), 0.0, condW.sub( 1.0 ) );
	const cyf = clamp( v.mul( condH.sub( 1.0 ) ), 0.0, condH.sub( 1.0 ) );
	const cx0 = int( floor( cxf ) );
	const cy0 = int( floor( cyf ) );
	const cx1 = min( cx0.add( 1 ), int( condW ).sub( 1 ) );
	const cy1 = min( cy0.add( 1 ), int( condH ).sub( 1 ) );
	const fx = fract( cxf );
	const fy = fract( cyf );
	const condWi = int( condW );
	const v00 = envConditionalWeights.element( cy0.mul( condWi ).add( cx0 ) );
	const v10 = envConditionalWeights.element( cy0.mul( condWi ).add( cx1 ) );
	const v01 = envConditionalWeights.element( cy1.mul( condWi ).add( cx0 ) );
	const v11 = envConditionalWeights.element( cy1.mul( condWi ).add( cx1 ) );
	const u = mix( mix( v00, v10, fx ), mix( v01, v11, fx ), fy ).toVar();

	const uv = vec2( u, v ).toVar();

	// Convert UV to direction
	const direction = equirectUvToDirection( uv, environmentMatrix ).toVar();

	// Sample color
	const color = texture( environment, uv, 0 ).rgb.mul( environmentIntensity ).toVar();

	// Write color to output parameter (avoids redundant CDF texture lookups)
	colorOutput.assign( color );

	// Calculate PDF
	const lum = dot( color.div( environmentIntensity ), REC709_LUMINANCE_COEFFICIENTS ).toVar();
	const pdf = lum.div( envTotalSum ).toVar();

	const dirPdf = equirectDirectionPdf( direction, environmentMatrix ).toVar();
	const finalPdf = float( envResolution.x ).mul( float( envResolution.y ) ).mul( pdf ).mul( dirPdf ).toVar();

	return vec4( direction, finalPdf );

} );

// Note: misHeuristic() is defined in LightsCore.js

// Simple environment lookup (no importance sampling)
export const sampleEnvironment = Fn( ( [
	environment,
	direction,
	environmentMatrix,
	environmentIntensity,
	enableEnvironmentLight
] ) => {

	const result = vec4( 0.0 ).toVar();

	If( enableEnvironmentLight, () => {

		const uv = equirectDirectionToUv( direction, environmentMatrix ).toVar();
		const texSample = texture( environment, uv, 0 ).toVar();

		result.assign( texSample.mul( environmentIntensity ) );

	} );

	return result;

} );
