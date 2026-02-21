/**
 * PathTracer.js - Main Path Tracer Entry Point
 *
 * Exact port of pathtracer.fs main() function
 * Pure TSL: Fn(), If(), Loop(), .toVar(), .assign() — NO wgslFn()
 *
 * Contains:
 *  - dithering              — anti-banding dither pattern
 *  - computeNDCDepth        — world position to NDC depth [0,1]
 *  - getRequiredSamples     — adaptive sampling sample count
 *  - pathTracerMain         — wrapper that forwards params object
 *  - pathTracerImpl         — main entry TSL Fn (sample loop, MRT, accumulation)
 *
 * MRT Outputs:
 *  - gColor:      RGB + edge sharpness (alpha)
 *  - gNormalDepth: Normal(RGB) + depth(A)
 *  - gAlbedo:     Albedo(RGB) for OIDN denoiser
 */

import {
	Fn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	uint,
	bool as tslBool,
	max,
	min,
	clamp,
	mix,
	dot,
	normalize,
	length,
	floor,
	fwidth,
	smoothstep,
	If,
	Loop,
	Break,
	texture,
	select,
	screenCoordinate,
} from 'three/tsl';

import {
	RandomValue,
	getDecorrelatedSeed,
	getStratifiedSample,
	pcgHash,
} from './Random.js';

import { generateRayFromCamera } from './BVHTraversal.js';
import { Trace, TraceResult } from './PathTracerCore.js';
import { TraceDebugMode } from './Debugger.js';
import {
	Pixel,
	Ray,
	pathTracerOutputStruct,
} from './Struct.js';

// =============================================================================
// Helper Functions
// =============================================================================

// Dithering to prevent banding in 8-bit output
export const dithering = Fn( ( [ color, seed ] ) => {

	const gridPosition = RandomValue( seed );
	const ditherShiftRGB = vec3( 0.25 / 255.0, - 0.25 / 255.0, 0.25 / 255.0 ).toVar();

	ditherShiftRGB.assign(
		mix( ditherShiftRGB.mul( 2.0 ), ditherShiftRGB.mul( - 2.0 ), gridPosition ),
	);

	return color.add( ditherShiftRGB );

} );

// Compute NDC depth from world position for motion vector reprojection
export const computeNDCDepth = Fn( ( [ worldPos, cameraProjectionMatrix, cameraViewMatrix ] ) => {

	const clipPos = cameraProjectionMatrix.mul( cameraViewMatrix ).mul( vec4( worldPos, 1.0 ) );
	const ndcDepth = clipPos.z.div( clipPos.w ).mul( 0.5 ).add( 0.5 );
	return clamp( ndcDepth, 0.0, 1.0 );

} );

// Get required samples from adaptive sampling texture
export const getRequiredSamples = Fn( ( [
	pixelCoord, resolution,
	adaptiveSamplingTexture, adaptiveSamplingMax,
] ) => {

	const texCoord = pixelCoord.div( resolution );
	const samplingData = texture( adaptiveSamplingTexture, texCoord, 0 );

	const result = int( 0 ).toVar();

	// Early exit for converged pixels
	If( samplingData.b.greaterThan( 0.5 ), () => {

		result.assign( 0 );

	} ).Else( () => {

		const normalizedSamples = samplingData.r;
		const targetSamples = normalizedSamples.mul( float( adaptiveSamplingMax ) );
		const samples = int( floor( targetSamples.add( 0.5 ) ) );
		result.assign( clamp( samples, 1, adaptiveSamplingMax ) );

	} );

	return result;

} );

// =============================================================================
// Main Entry Point (Wrapper)
// =============================================================================

export const pathTracerMain = ( params ) => {

	return pathTracerImpl(
		// Frame / resolution
		params.resolution,
		params.frame,
		params.samplesPerPixel,
		params.visMode,
		// Camera
		params.cameraWorldMatrix,
		params.cameraProjectionMatrixInverse,
		params.cameraViewMatrix,
		params.cameraProjectionMatrix,
		// BVH / Scene
		params.bvhTexture,
		params.bvhTexSize,
		params.triangleTexture,
		params.triangleTexSize,
		params.materialTexture,
		params.materialTexSize,
		// Texture arrays
		params.albedoMaps,
		params.normalMaps,
		params.bumpMaps,
		params.metalnessMaps,
		params.roughnessMaps,
		params.emissiveMaps,
		params.displacementMaps,
		// Lights
		params.directionalLightsBuffer,
		params.numDirectionalLights,
		params.areaLightsBuffer,
		params.numAreaLights,
		params.pointLightsBuffer,
		params.numPointLights,
		params.spotLightsBuffer,
		params.numSpotLights,
		// Environment
		params.envTexture,
		params.environmentIntensity,
		params.envMatrix,
		params.envMarginalWeights,
		params.envConditionalWeights,
		params.envTotalSum,
		params.envResolution,
		params.enableEnvironmentLight,
		params.useEnvMapIS,
		// Rendering parameters
		params.maxBounceCount,
		params.transmissiveBounces,
		params.showBackground,
		params.backgroundIntensity,
		params.fireflyThreshold,
		params.globalIlluminationIntensity,
		params.totalTriangleCount,
		params.enableEmissiveTriangleSampling,
		// Debug
		params.debugVisScale,
		// Accumulation
		params.enableAccumulation,
		params.hasPreviousAccumulated,
		params.prevAccumTexture,
		params.accumulationAlpha,
		params.cameraIsMoving,
		// Adaptive sampling
		params.useAdaptiveSampling,
		params.adaptiveSamplingTexture,
		params.adaptiveSamplingMax,
		// DOF / Camera lens
		params.enableDOF,
		params.focalLength,
		params.aperture,
		params.focusDistance,
		params.sceneScale,
		params.apertureScale,
	);

};

// =============================================================================
// Main Path Tracer Implementation (TSL Fn)
// =============================================================================

const pathTracerImpl = Fn( ( [
	// Frame / resolution
	resolution, frame, numRaysPerPixel, visMode,
	// Camera
	cameraWorldMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, cameraProjectionMatrix,
	// BVH / Scene
	bvhTexture, bvhTexSize,
	triangleTexture, triangleTexSize,
	materialTexture, materialTexSize,
	// Texture arrays
	albedoMaps, normalMaps, bumpMaps,
	metalnessMaps, roughnessMaps, emissiveMaps,
	displacementMaps,
	// Lights
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
	// Environment
	envTexture, environmentIntensity, envMatrix,
	envMarginalWeights, envConditionalWeights,
	envTotalSum, envResolution,
	enableEnvironmentLight, useEnvMapIS,
	// Rendering parameters
	maxBounceCount, transmissiveBounces,
	showBackground, backgroundIntensity,
	fireflyThreshold, globalIlluminationIntensity,
	totalTriangleCount, enableEmissiveTriangleSampling,
	// Debug
	debugVisScale,
	// Accumulation
	enableAccumulation, hasPreviousAccumulated,
	prevAccumTexture, accumulationAlpha, cameraIsMoving,
	// Adaptive sampling
	useAdaptiveSampling, adaptiveSamplingTexture, adaptiveSamplingMax,
	// DOF / Camera lens
	enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale,
] ) => {

	const pixelCoord = screenCoordinate.xy.toVar();

	// Screen position in NDC [-1, 1]
	// Negate Y to match WebGL's bottom-up gl_FragCoord convention
	// (WebGPU screenCoordinate.y is top-down)
	const screenPosition = pixelCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar();
	screenPosition.y.assign( screenPosition.y.negate() );

	// Initialize pixel accumulator
	const pixelColor = vec4( 0.0 ).toVar();
	const pixelSamples = int( 0 ).toVar();

	const baseSeed = getDecorrelatedSeed( pixelCoord, int( 0 ), frame ).toVar();
	const pixelIndex = int( pixelCoord.y ).mul( int( resolution.x ) ).add( int( pixelCoord.x ) ).toVar();

	// MRT data
	const worldNormal = vec3( 0.0, 0.0, 1.0 ).toVar();
	const linearDepth = float( 1.0 ).toVar();

	const samplesCount = int( numRaysPerPixel ).toVar();

	// Adaptive sampling
	If( frame.greaterThan( uint( 2 ) ).and( useAdaptiveSampling ), () => {

		const adaptiveSamples = getRequiredSamples(
			pixelCoord, resolution,
			adaptiveSamplingTexture, adaptiveSamplingMax,
		);
		samplesCount.assign( adaptiveSamples );

		// Handle converged pixels
		If( samplesCount.equal( int( 0 ) ), () => {

			If( enableAccumulation.and( hasPreviousAccumulated ), () => {

				const prevUV = pixelCoord.div( resolution );
				pixelColor.assign( texture( prevAccumTexture, prevUV, 0 ) );

			} ).Else( () => {

				samplesCount.assign( 1 );

			} );

			// If still 0 after accumulation check, output MRT defaults and return
			If( samplesCount.equal( int( 0 ) ), () => {

				// Handled below after the loop

			} );

		} );

	} );

	// Edge detection variables
	const objectNormal = vec3( 0.0 ).toVar();
	const objectColor = vec3( 0.0 ).toVar();
	const objectID = float( - 1000.0 ).toVar();
	const pixelSharpness = float( 0.0 ).toVar();

	// Main sample loop
	Loop( { start: int( 0 ), end: samplesCount, type: 'int', condition: '<' }, ( { i: rayIndex } ) => {

		const seed = pcgHash( baseSeed.add( uint( rayIndex ) ) ).toVar();

		const stratifiedJitter = getStratifiedSample(
			pixelCoord, rayIndex, samplesCount, seed, resolution, frame,
		).toVar();

		// Debug mode 5: Visualize stratified samples
		If( visMode.equal( int( 5 ) ), () => {

			pixelColor.assign( vec4( stratifiedJitter, 1.0, 1.0 ) );
			pixelSamples.assign( 1 );
			Break();

		} );

		const jitter = stratifiedJitter.sub( 0.5 ).mul( vec2( 2.0 ).div( resolution ) );
		const jitteredScreenPosition = screenPosition.add( jitter );

		const ray = Ray.wrap( generateRayFromCamera(
			jitteredScreenPosition, seed,
			cameraWorldMatrix, cameraProjectionMatrixInverse,
			enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale,
		) );

		const sampleColor = vec4( 0.0 ).toVar();

		// pixelColor.assign( svec4( 1.0, 0.0, 1.0, 1.0 ) ); // Magenta debug color for uninitialized rays
		// Debug or normal trace
		If( visMode.greaterThan( int( 0 ) ), () => {

			sampleColor.assign( TraceDebugMode(
				ray.origin, ray.direction,
				bvhTexture, bvhTexSize,
				triangleTexture, triangleTexSize,
				materialTexture, materialTexSize,
				envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
				envMarginalWeights, envConditionalWeights,
				envTotalSum, envResolution,
				useEnvMapIS,
				visMode, debugVisScale,
				pixelCoord, resolution,
				albedoMaps, normalMaps, bumpMaps,
				metalnessMaps, roughnessMaps, emissiveMaps,
				cameraProjectionMatrix, cameraViewMatrix,
			) );

		} ).Else( () => {

			// Normal path tracing
			const traceResult = TraceResult.wrap( Trace(
				ray, seed, rayIndex, pixelIndex,
				bvhTexture, bvhTexSize,
				triangleTexture, triangleTexSize,
				materialTexture, materialTexSize,
				albedoMaps, normalMaps, bumpMaps,
				metalnessMaps, roughnessMaps, emissiveMaps,
				displacementMaps,
				directionalLightsBuffer, numDirectionalLights,
				areaLightsBuffer, numAreaLights,
				pointLightsBuffer, numPointLights,
				spotLightsBuffer, numSpotLights,
				envTexture, environmentIntensity, envMatrix,
				envMarginalWeights, envConditionalWeights,
				envTotalSum, envResolution,
				enableEnvironmentLight, useEnvMapIS,
				maxBounceCount, transmissiveBounces,
				backgroundIntensity, showBackground,
				fireflyThreshold, globalIlluminationIntensity,
				totalTriangleCount, enableEmissiveTriangleSampling,
				pixelCoord, resolution, frame,
			) );

			sampleColor.assign( traceResult.radiance );

			// Accumulate edge detection data from primary rays
			If( rayIndex.equal( int( 0 ) ), () => {

				objectNormal.assign( traceResult.objectNormal );
				objectColor.assign( traceResult.objectColor );
				objectID.assign( traceResult.objectID );

				// Set MRT data from first hit
				worldNormal.assign( normalize( traceResult.objectNormal ) );

				// Compute proper NDC depth from actual hit point
				If( traceResult.firstHitDistance.lessThan( 1e9 ), () => {

					linearDepth.assign( computeNDCDepth(
						traceResult.firstHitPoint, cameraProjectionMatrix, cameraViewMatrix,
					) );

				} ).Else( () => {

					linearDepth.assign( 1.0 );

				} );

			} );

		} );

		pixelColor.addAssign( sampleColor );
		pixelSamples.addAssign( 1 );

	} );

	// Average samples
	If( pixelSamples.greaterThan( int( 0 ) ), () => {

		pixelColor.divAssign( float( pixelSamples ) );

	} );

	// Apply dithering AFTER averaging
	pixelColor.xyz.assign( dithering( pixelColor.xyz, baseSeed ) );

	// Edge Detection
	const depthDifference = fwidth( linearDepth );
	const depthEdge = smoothstep( float( 0.01 ), float( 0.05 ), depthDifference );

	const differenceNx = fwidth( objectNormal.x );
	const differenceNy = fwidth( objectNormal.y );
	const differenceNz = fwidth( objectNormal.z );
	const normalDifference = smoothstep( float( 0.3 ), float( 0.8 ), differenceNx )
		.add( smoothstep( float( 0.3 ), float( 0.8 ), differenceNy ) )
		.add( smoothstep( float( 0.3 ), float( 0.8 ), differenceNz ) );

	const objectDifference = min( fwidth( objectID ), 1.0 );

	// Mark pixel as edge
	If( depthEdge.greaterThan( 0.5 )
		.or( normalDifference.greaterThanEqual( 1.0 ) )
		.or( objectDifference.greaterThanEqual( 1.0 ) ), () => {

		pixelSharpness.assign( 1.0 );

	} );

	pixelColor.w.assign( pixelSharpness );

	// Temporal accumulation
	const finalColor = pixelColor.xyz.toVar();

	If( enableAccumulation.and( cameraIsMoving.not() ).and( frame.greaterThan( uint( 1 ) ) ).and( hasPreviousAccumulated ), () => {

		const prevUV = pixelCoord.div( resolution );
		const previousColor = texture( prevAccumTexture, prevUV, 0 ).xyz;
		finalColor.assign( previousColor.add( pixelColor.xyz.sub( previousColor ).mul( accumulationAlpha ) ) );

	} );

	// Clean MRT output
	return pathTracerOutputStruct( {
		// gColor: vec4( finalColor, 1.0 ),
		gColor: vec4( finalColor.xyz, 1.0 ),
		gNormalDepth: vec4( worldNormal.mul( 0.5 ).add( 0.5 ), linearDepth ),
		gAlbedo: vec4( objectColor, 1.0 ),
	} );

} );
