/**
 * Debugger.js - Debug Visualization Modes
 *
 * Exact port of debugger.fs
 * Pure TSL: Fn(), If(), .toVar(), .assign() — NO wgslFn()
 *
 * Contains:
 *  - visualizeDepth         — depth to grayscale gradient
 *  - visualizeNormal        — normal to RGB mapping
 *  - TraceDebugMode         — main debug mode dispatch (switch on visMode)
 */

import {
	Fn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	bool as tslBool,
	max,
	min,
	dot,
	length,
	normalize,
	log,
	clamp,
	mix,
	sin,
	cos,
	If,
	select,
} from 'three/tsl';

import { Ray, HitInfo } from './Struct.js';
import { traverseBVH } from './BVHTraversal.js';
import { sampleEnvironment, sampleEquirect } from './Environment.js';
import { PI, TWO_PI, REC709_LUMINANCE_COEFFICIENTS } from './Common.js';

// =============================================================================
// Debug Visualization Helpers
// =============================================================================

// Visualize depth with color gradient (near=white, far=black)
const visualizeDepth = Fn( ( [ depth ] ) => {

	return vec3( float( 1.0 ).sub( depth ) );

} );

// Visualize normals in world space (RGB mapped from [-1,1] to [0,1])
const visualizeNormal = Fn( ( [ normal ] ) => {

	return normal.mul( 0.5 ).add( 0.5 );

} );

// =============================================================================
// Main Debug Mode Function
// =============================================================================

export const TraceDebugMode = Fn( ( [
	rayOrigin, rayDir,
	// BVH resources
	bvhTexture, bvhTexSize,
	triangleTexture, triangleTexSize,
	materialTexture, materialTexSize,
	// Environment resources
	envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
	envMarginalWeights, envConditionalWeights,
	envTotalSum, envResolution,
	useEnvMapIS,
	// Debug parameters
	visMode, debugVisScale,
	// Screen info
	pixelCoord, resolution,
] ) => {

	const result = vec4( 1.0, 0.0, 1.0, 1.0 ).toVar(); // Default: magenta

	// Trace primary ray
	const ray = Ray( { origin: rayOrigin, direction: rayDir } );
	const hitInfo = HitInfo.wrap( traverseBVH(
		ray,
		bvhTexture, bvhTexSize,
		triangleTexture, triangleTexSize,
		materialTexture, materialTexSize,
	).toVar() );

	// Case 1: Box/node test count visualization (GLSL stats[0] = per-node visits)
	If( visMode.equal( int( 1 ) ), () => {

		const vis = float( hitInfo.boxTests ).div( debugVisScale );
		result.assign( select(
			vis.lessThan( 1.0 ),
			vec4( vec3( vis ), 1.0 ),
			vec4( 1.0, 0.0, 0.0, 1.0 ),
		) );

	} );

	// Case 2: Triangle test count visualization (GLSL stats[1] = per-triangle tests)
	If( visMode.equal( int( 2 ) ), () => {

		const vis = float( hitInfo.triTests ).div( debugVisScale );
		result.assign( select(
			vis.lessThan( 1.0 ),
			vec4( vec3( vis ), 1.0 ),
			vec4( 1.0, 0.0, 0.0, 1.0 ),
		) );

	} );

	// Case 3: Ray distance visualization
	If( visMode.equal( int( 3 ) ), () => {

		const dist = length( rayOrigin.sub( hitInfo.hitPoint ) ).div( debugVisScale );
		result.assign( vec4( vec3( dist ), 1.0 ) );

	} );

	// Case 4: Surface normals
	If( visMode.equal( int( 4 ) ), () => {

		If( hitInfo.didHit.not(), () => {

			result.assign( vec4( 0.0, 0.0, 0.0, 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( visualizeNormal( hitInfo.normal ), 1.0 ) );

		} );

	} );

	// Case 6: Environment Map Luminance Visualization
	If( visMode.equal( int( 6 ) ), () => {

		If( enableEnvironmentLight, () => {

			const envSample = sampleEnvironment(
				envTexture, rayDir, envMatrix, environmentIntensity, enableEnvironmentLight,
			).toVar();

			const envLuminance = dot( envSample.xyz, REC709_LUMINANCE_COEFFICIENTS ).toVar();
			const rawLuminance = envLuminance.toVar();

			// Adaptive scaling
			const adaptiveScale = max( debugVisScale.mul( 0.1 ), 0.001 );
			const scaledLuminance = envLuminance.div( adaptiveScale ).toVar();

			// Logarithmic scaling for better dynamic range
			const logLuminance = log( envLuminance.add( 1e-6 ) );
			const logScaled = logLuminance.add( 10.0 ).div( 10.0 ).toVar();

			// Choose scaling based on debugVisScale
			const finalValue = select( debugVisScale.greaterThan( 1.0 ), scaledLuminance, logScaled ).toVar();

			// Heat map visualization
			const color = vec3( 0.0 ).toVar();

			If( finalValue.lessThan( 0.2 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 0.5 ), finalValue.mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 0.4 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 0.5 ), vec3( 0.0, 0.0, 1.0 ), finalValue.sub( 0.2 ).mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 0.6 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), finalValue.sub( 0.4 ).mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 0.8 ), () => {

				color.assign( mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 1.0, 0.0 ), finalValue.sub( 0.6 ).mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 1.0 ), () => {

				color.assign( mix( vec3( 1.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), finalValue.sub( 0.8 ).mul( 5.0 ) ) );

			} ).Else( () => {

				color.assign( mix( vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 1.0, 1.0 ), min( finalValue.sub( 1.0 ), 1.0 ) ) );

			} );

			// Debug: Show raw values in specific screen regions
			const screenPos = pixelCoord.div( resolution );

			If( screenPos.x.lessThan( 0.1 ).and( screenPos.y.lessThan( 0.1 ) ), () => {

				const debugValue = rawLuminance.mul( 1.0 );
				color.assign( vec3( debugValue ) );

			} ).ElseIf( screenPos.x.greaterThan( 0.9 ).and( screenPos.y.lessThan( 0.1 ) ), () => {

				color.assign( envSample.xyz.mul( 1.0 ) );

			} );

			result.assign( vec4( color, 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( 1.0, 0.0, 1.0, 1.0 ) );

		} );

	} );

	// Case 7: Environment Importance Sampling PDF Direction Map
	If( visMode.equal( int( 7 ) ), () => {

		If( enableEnvironmentLight.and( useEnvMapIS ), () => {

			// Use screen space to map UV coordinates
			const uv = pixelCoord.div( resolution );

			// Convert UV to direction (simple equirectangular, no matrix)
			const theta = float( 1.0 ).sub( uv.y ).mul( PI );
			const phi = uv.x.mul( TWO_PI );
			const sinTheta = sin( theta );
			const direction = vec3( sinTheta.mul( cos( phi ) ), cos( theta ), sinTheta.mul( sin( phi ) ) );

			// Get PDF for this direction
			const envEvalResult = sampleEquirect(
				envTexture, direction, envMatrix, envTotalSum, envResolution,
			).toVar();
			const pdf = envEvalResult.w.toVar();

			// Visualize with better scaling
			const logPdf = log( pdf.add( 1e-8 ) );
			const normalizedPdf = logPdf.add( 15.0 ).div( 15.0 ).toVar();

			// Heat map colors
			const color = vec3( 0.0 ).toVar();

			If( normalizedPdf.lessThan( 0.33 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), normalizedPdf.mul( 3.0 ) ) );

			} ).ElseIf( normalizedPdf.lessThan( 0.66 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), normalizedPdf.sub( 0.33 ).mul( 3.0 ) ) );

			} ).Else( () => {

				color.assign( mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), normalizedPdf.sub( 0.66 ).mul( 3.0 ) ) );

			} );

			result.assign( vec4( color, 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( 1.0, 0.0, 1.0, 1.0 ) );

		} );

	} );

	return result;

} );
