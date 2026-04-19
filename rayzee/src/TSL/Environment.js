import { Fn, wgslFn, vec2, vec4, float, int, If, texture, sampler, dot, floor, fract, min, mix, clamp } from 'three/tsl';

import { REC709_LUMINANCE_COEFFICIENTS } from './Common.js';

// Convert direction to UV coordinates for equirectangular map
// Exact implementation from three-gpu-pathtracer
export const equirectDirectionToUv = /*@__PURE__*/ wgslFn( `
	fn equirectDirectionToUv( direction: vec3f, environmentMatrix: mat4x4f ) -> vec2f {
		let d = normalize( ( environmentMatrix * vec4f( direction, 0.0f ) ).xyz );
		var uv = vec2f( atan2( d.z, d.x ), acos( d.y ) );
		uv = uv / vec2f( 6.28318530717958647692f, 3.14159265358979323846f );
		uv.x = uv.x + 0.5f;
		uv.y = 1.0f - uv.y;
		return uv;
	}
` );

// Convert UV coordinates to direction
// Exact implementation from three-gpu-pathtracer
export const equirectUvToDirection = /*@__PURE__*/ wgslFn( `
	fn equirectUvToDirection( uv: vec2f, environmentMatrix: mat4x4f ) -> vec3f {
		let adjustedUv = vec2f( uv.x - 0.5f, 1.0f - uv.y );
		let theta = adjustedUv.x * 6.28318530717958647692f;
		let phi = adjustedUv.y * 3.14159265358979323846f;
		let sinPhi = sin( phi );
		let localDir = vec3f( sinPhi * cos( theta ), cos( phi ), sinPhi * sin( theta ) );
		return normalize( ( transpose( environmentMatrix ) * vec4f( localDir, 0.0f ) ).xyz );
	}
` );

// Sample environment map color in a given direction
export const sampleEquirectColor = Fn( ( [ environment, direction, environmentMatrix ] ) => {

	return texture( environment, equirectDirectionToUv( { direction, environmentMatrix } ), 0 ).rgb;

} );

// Calculate PDF for uniform sphere sampling with Jacobian
export const equirectDirectionPdf = /*@__PURE__*/ wgslFn( `
	fn equirectDirectionPdf( direction: vec3f, environmentMatrix: mat4x4f ) -> f32 {
		let uv = equirectDirectionToUv( direction, environmentMatrix );
		let theta = uv.y * 3.14159265358979323846f;
		let sinTheta = sin( theta );
		if ( sinTheta == 0.0f ) { return 0.0f; }
		return 1.0f / ( 6.28318530717958647692f * 3.14159265358979323846f * sinTheta );
	}
`, [ equirectDirectionToUv ] );

// Evaluate PDF for a given direction (for MIS)
// Exact implementation from three-gpu-pathtracer
// Returns vec4(color.rgb, pdf) since TSL cannot use inout params
export const sampleEquirect = Fn( ( [ environment, direction, environmentMatrix, envTotalSum, envResolution ] ) => {

	const result = vec4( 0.0 ).toVar();

	If( envTotalSum.equal( 0.0 ), () => {

		// Exclude black environments from MIS
		result.assign( vec4( 0.0 ) );

	} ).Else( () => {

		const uv = equirectDirectionToUv( { direction, environmentMatrix } ).toVar();
		const color = texture( environment, uv, 0 ).rgb.toVar();

		const lum = dot( color, REC709_LUMINANCE_COEFFICIENTS ).toVar();
		const pdf = lum.div( envTotalSum ).toVar();

		const dirPdf = equirectDirectionPdf( { direction, environmentMatrix } ).toVar();
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
	envCDFBuffer,
	environmentMatrix,
	environmentIntensity,
	envTotalSum,
	envResolution,
	r,
	colorOutput
] ) => {

	// Packed CDF layout: [marginal (envResolution.y floats) | conditional (envResolution.x * envResolution.y floats)]
	// The conditional offset equals the marginal length, which is envResolution.y.
	const condOffset = int( envResolution.y ).toVar();

	// Sample marginal CDF for V coordinate (1D, linear interpolation)
	const marginalSize = envResolution.y;
	const mIdx = clamp( r.x.mul( marginalSize.sub( 1.0 ) ), 0.0, marginalSize.sub( 1.0 ) );
	const mI0 = int( floor( mIdx ) );
	const mI1 = min( mI0.add( 1 ), int( marginalSize ).sub( 1 ) );
	const mFrac = fract( mIdx );
	const v = mix( envCDFBuffer.element( mI0 ), envCDFBuffer.element( mI1 ), mFrac ).toVar();

	// Sample conditional CDF for U coordinate (2D grid, bilinear interpolation)
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
	const v00 = envCDFBuffer.element( condOffset.add( cy0.mul( condWi ).add( cx0 ) ) );
	const v10 = envCDFBuffer.element( condOffset.add( cy0.mul( condWi ).add( cx1 ) ) );
	const v01 = envCDFBuffer.element( condOffset.add( cy1.mul( condWi ).add( cx0 ) ) );
	const v11 = envCDFBuffer.element( condOffset.add( cy1.mul( condWi ).add( cx1 ) ) );
	const u = mix( mix( v00, v10, fx ), mix( v01, v11, fx ), fy ).toVar();

	const uv = vec2( u, v ).toVar();

	// Convert UV to direction
	const direction = equirectUvToDirection( { uv, environmentMatrix } ).toVar();

	// Sample color
	const color = texture( environment, uv, 0 ).rgb.mul( environmentIntensity ).toVar();

	// Write color to output parameter (avoids redundant CDF texture lookups)
	colorOutput.assign( color );

	// Calculate PDF
	const lum = dot( color.div( environmentIntensity ), REC709_LUMINANCE_COEFFICIENTS ).toVar();
	const pdf = lum.div( envTotalSum ).toVar();

	const dirPdf = equirectDirectionPdf( { direction, environmentMatrix } ).toVar();
	const finalPdf = float( envResolution.x ).mul( float( envResolution.y ) ).mul( pdf ).mul( dirPdf ).toVar();

	return vec4( direction, finalPdf );

} );

// Note: powerHeuristic() is defined in Common.js

// Simple environment lookup (no importance sampling) — native WGSL
export const sampleEnvironment = /*@__PURE__*/ wgslFn( `
	fn sampleEnvironment(
		tex: texture_2d<f32>,
		samp: sampler,
		direction: vec3f,
		environmentMatrix: mat4x4f,
		environmentIntensity: f32,
		enableEnvironmentLight: f32
	) -> vec4f {
		if ( enableEnvironmentLight < 0.5 ) { return vec4f( 0.0 ); }
		let uv = equirectDirectionToUv( direction, environmentMatrix );
		let texSample = textureSampleLevel( tex, samp, uv, 0.0 );
		return texSample * environmentIntensity;
	}
`, [ equirectDirectionToUv ] );
