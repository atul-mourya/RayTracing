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
	wgslFn,
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
export const computeNDCDepth = /*@__PURE__*/ wgslFn( `
	fn computeNDCDepth( worldPos: vec3f, cameraProjectionMatrix: mat4x4f, cameraViewMatrix: mat4x4f ) -> f32 {
		let clipPos = cameraProjectionMatrix * cameraViewMatrix * vec4f( worldPos, 1.0f );
		let ndcDepth = clipPos.z / clipPos.w * 0.5f + 0.5f;
		return clamp( ndcDepth, 0.0f, 1.0f );
	}
` );

// Get required samples from adaptive sampling texture
export const getRequiredSamples = Fn( ( [
	pixelCoord, resolution,
	adaptiveSamplingTexture, adaptiveSamplingMin, adaptiveSamplingMax,
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
		result.assign( clamp( samples, adaptiveSamplingMin, adaptiveSamplingMax ) );

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
		params.bvhBuffer,
		params.triangleBuffer,
		params.materialBuffer,
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
		params.transparentBackground,
		params.backgroundIntensity,
		params.fireflyThreshold,
		params.globalIlluminationIntensity,
		params.totalTriangleCount,
		params.enableEmissiveTriangleSampling,
		params.emissiveTriangleBuffer,
		params.emissiveTriangleCount,
		params.emissiveTotalPower,
		params.emissiveBoost,
		params.skipFirstBounceNEE,
		// Debug
		params.debugVisScale,
		// Accumulation
		params.enableAccumulation,
		params.hasPreviousAccumulated,
		params.prevAccumTexture,
		params.prevNormalDepthTexture,
		params.prevAlbedoTexture,
		params.accumulationAlpha,
		params.cameraIsMoving,
		// Adaptive sampling
		params.useAdaptiveSampling,
		params.adaptiveSamplingTexture,
		params.adaptiveSamplingMin,
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
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
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
	showBackground, transparentBackground, backgroundIntensity,
	fireflyThreshold, globalIlluminationIntensity,
	totalTriangleCount, enableEmissiveTriangleSampling,
	emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower, emissiveBoost,
	skipFirstBounceNEE,
	// Debug
	debugVisScale,
	// Accumulation
	enableAccumulation, hasPreviousAccumulated,
	prevAccumTexture, prevNormalDepthTexture, prevAlbedoTexture,
	accumulationAlpha, cameraIsMoving,
	// Adaptive sampling
	useAdaptiveSampling, adaptiveSamplingTexture, adaptiveSamplingMin, adaptiveSamplingMax,
	// DOF / Camera lens
	enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale,
] ) => {

	const pixelCoord = screenCoordinate.xy.toVar();

	// Screen position in NDC [-1, 1]
	// Negate Y because screenCoordinate.y is top-down but NDC expects bottom-up
	const screenPosition = pixelCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar();
	screenPosition.y.assign( screenPosition.y.negate() );

	// Initialize pixel accumulator
	const pixelColor = vec4( 0.0 ).toVar();
	const pixelSamples = int( 0 ).toVar();

	const baseSeed = getDecorrelatedSeed( { pixelCoord, rayIndex: int( 0 ), frame } ).toVar();
	const pixelIndex = int( pixelCoord.y ).mul( int( resolution.x ) ).add( int( pixelCoord.x ) ).toVar();

	// MRT data
	const worldNormal = vec3( 0.0, 0.0, 1.0 ).toVar();
	const linearDepth = float( 1.0 ).toVar();

	// Track primary ray geometry hit for transparent background (1.0 = hit, 0.0 = miss)
	const primaryHitAlpha = float( 0.0 ).toVar();

	const samplesCount = int( numRaysPerPixel ).toVar();

	// Adaptive sampling
	If( frame.greaterThan( uint( 2 ) ).and( useAdaptiveSampling ), () => {

		const adaptiveSamples = getRequiredSamples(
			pixelCoord, resolution,
			adaptiveSamplingTexture, adaptiveSamplingMin, adaptiveSamplingMax,
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

		const seed = pcgHash( { state: baseSeed.add( uint( rayIndex ) ) } ).toVar();

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
				bvhBuffer,
				triangleBuffer,
				materialBuffer,
				envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
				envMarginalWeights, envConditionalWeights,
				envTotalSum, envResolution,
				useEnvMapIS,
				visMode, debugVisScale,
				pixelCoord, resolution,
				albedoMaps, normalMaps, bumpMaps,
				metalnessMaps, roughnessMaps, emissiveMaps,
				cameraProjectionMatrix, cameraViewMatrix,
				frame,
			) );

		} ).Else( () => {

			// Normal path tracing
			const traceResult = TraceResult.wrap( Trace(
				ray, seed, rayIndex, pixelIndex,
				bvhBuffer,
				triangleBuffer,
				materialBuffer,
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
				emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower, emissiveBoost,
				pixelCoord, resolution, frame,
				skipFirstBounceNEE,
			) );

			sampleColor.assign( traceResult.radiance );

			// Accumulate edge detection data from primary rays
			If( rayIndex.equal( int( 0 ) ), () => {

				objectNormal.assign( traceResult.objectNormal );
				objectColor.assign( traceResult.objectColor );
				objectID.assign( traceResult.objectID );

				// Set MRT data from first hit (only for geometry hits — miss rays have zero normal,
				// and normalize(vec3(0)) = NaN which would corrupt the OIDN denoiser input)
				If( traceResult.firstHitDistance.lessThan( 1e9 ), () => {

					worldNormal.assign( normalize( traceResult.objectNormal ) );

					linearDepth.assign( computeNDCDepth( {
						worldPos: traceResult.firstHitPoint, cameraProjectionMatrix, cameraViewMatrix,
					} ) );

					// Primary ray hit geometry — pixel is opaque for transparent background
					primaryHitAlpha.assign( 1.0 );

				} ).Else( () => {

					// Background: keep initialized values — worldNormal stays (0,0,1), linearDepth stays 1.0

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

	// primaryHitAlpha is set in the sample loop based on firstHitDistance

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
	const finalNormalDepth = vec4( worldNormal.mul( 0.5 ).add( 0.5 ), linearDepth ).toVar();
	const finalAlbedo = vec3( objectColor ).toVar();

	If( enableAccumulation.and( cameraIsMoving.not() ).and( frame.greaterThan( uint( 0 ) ) ).and( hasPreviousAccumulated ), () => {

		const prevUV = pixelCoord.div( resolution );
		const previousColor = texture( prevAccumTexture, prevUV, 0 ).xyz;
		finalColor.assign( previousColor.add( pixelColor.xyz.sub( previousColor ).mul( accumulationAlpha ) ) );

		const prevND = texture( prevNormalDepthTexture, prevUV, 0 );
		finalNormalDepth.assign( prevND.add( finalNormalDepth.sub( prevND ).mul( accumulationAlpha ) ) );

		const prevAlbedo = texture( prevAlbedoTexture, prevUV, 0 ).xyz;
		finalAlbedo.assign( prevAlbedo.add( finalAlbedo.sub( prevAlbedo ).mul( accumulationAlpha ) ) );

	} );

	// Output alpha: 1.0 if primary ray hit any geometry (including glass), 0.0 for pure background
	const outputAlpha = select( transparentBackground, primaryHitAlpha, 1.0 );

	// Clean MRT output
	return pathTracerOutputStruct( {
		gColor: vec4( finalColor.xyz, outputAlpha ),
		gNormalDepth: finalNormalDepth,
		gAlbedo: vec4( finalAlbedo, 1.0 ),
	} );

} );
