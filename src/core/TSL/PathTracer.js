/**
 * PathTracer.js - Main Path Tracer Entry Point
 *
 * Contains:
 *  - dithering              — anti-banding dither pattern
 *  - computeNDCDepth        — world position to NDC depth [0,1]
 *  - getRequiredSamples     — adaptive sampling sample count
 *  - computeEdgeSharpness   — screen-space edge detection for sharpening
 *  - pathTracerMain         — main entry (sample loop, MRT, accumulation)
 *
 * MRT Outputs:
 *  - gColor:      RGB + alpha (transparent bg: per-sample hit/miss alpha, opaque: 1.0)
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
	clamp,
	mix,
	normalize,
	floor,
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

// Screen-space edge detection for sharpening mask
const computeEdgeSharpness = /*@__PURE__*/ wgslFn( `
	fn computeEdgeSharpness( objectNormal: vec3f, linearDepth: f32, objectID: f32 ) -> f32 {

		let depthEdge = smoothstep( 0.01f, 0.05f, fwidth( linearDepth ) );

		let normalFw = fwidth( objectNormal );
		let normalDifference = smoothstep( 0.3f, 0.8f, normalFw.x )
			+ smoothstep( 0.3f, 0.8f, normalFw.y )
			+ smoothstep( 0.3f, 0.8f, normalFw.z );

		let objectDifference = min( fwidth( objectID ), 1.0f );

		return select( 0.0f, 1.0f,
			depthEdge > 0.5f || normalDifference >= 1.0f || objectDifference >= 1.0f
		);
	}
` );

// =============================================================================
// Main Path Tracer Implementation
// =============================================================================

export const pathTracerMain = ( params ) => {

	const {
		resolution, frame,
		samplesPerPixel: numRaysPerPixel,
		visMode,
		cameraWorldMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, cameraProjectionMatrix,
		bvhBuffer, triangleBuffer, materialBuffer,
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
		showBackground, transparentBackground, backgroundIntensity,
		fireflyThreshold, globalIlluminationIntensity,
		totalTriangleCount, enableEmissiveTriangleSampling,
		emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower, emissiveBoost,
		lightBVHBuffer, lightBVHNodeCount,
		debugVisScale,
		enableAccumulation, hasPreviousAccumulated,
		prevAccumTexture, prevNormalDepthTexture, prevAlbedoTexture,
		accumulationAlpha, cameraIsMoving,
		useAdaptiveSampling, adaptiveSamplingTexture, adaptiveSamplingMin, adaptiveSamplingMax,
		enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale,
	} = params;

	return Fn( () => {

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

		// Accumulate per-sample alpha for transparent background (0.0 = env, 1.0 = geometry)
		const pixelAlpha = float( 0.0 ).toVar();

		const samplesCount = int( numRaysPerPixel ).toVar();

		// Adaptive sampling
		If( frame.greaterThan( uint( 2 ) ).and( useAdaptiveSampling ), () => {

			const adaptiveSamples = getRequiredSamples(
				pixelCoord, resolution,
				adaptiveSamplingTexture, adaptiveSamplingMin, adaptiveSamplingMax,
			);
			samplesCount.assign( adaptiveSamples );

			// Handle converged pixels — carry forward all data from previous frame
			If( samplesCount.equal( int( 0 ) ), () => {

				If( enableAccumulation.and( hasPreviousAccumulated ), () => {

					const prevUV = pixelCoord.div( resolution );
					const prevSample = texture( prevAccumTexture, prevUV, 0 );
					pixelColor.assign( prevSample );
					pixelAlpha.assign( prevSample.w );

					// Carry forward MRT data so accumulation blend preserves them
					// (without this, default worldNormal/linearDepth slowly corrupt the MRT)
					const prevND = texture( prevNormalDepthTexture, prevUV, 0 );
					worldNormal.assign( prevND.xyz.mul( 2.0 ).sub( 1.0 ) );
					linearDepth.assign( prevND.w );

				} ).Else( () => {

					samplesCount.assign( 1 );

				} );

			} );

		} );

		// Edge detection variables
		const objectNormal = vec3( 0.0 ).toVar();
		const objectColor = vec3( 0.0 ).toVar();
		const objectID = float( - 1000.0 ).toVar();

		// Pre-compute loop-invariant jitter scale
		const jitterScale = vec2( 2.0 ).div( resolution ).toVar();

		// Main sample loop
		Loop( { start: int( 0 ), end: samplesCount, type: 'int', condition: '<' }, ( { i: rayIndex } ) => {

			const seed = pcgHash( { state: baseSeed.add( uint( rayIndex ) ) } ).toVar();

			const stratifiedJitter = getStratifiedSample(
				pixelCoord, rayIndex, samplesCount, seed, resolution, frame,
			).toVar();

			// Debug mode 9: Visualize stratified samples
			If( visMode.equal( int( 9 ) ), () => {

				pixelColor.assign( vec4( stratifiedJitter, 1.0, 1.0 ) );
				pixelSamples.assign( 1 );
				Break();

			} );

			const jitter = stratifiedJitter.sub( 0.5 ).mul( jitterScale );
			const jitteredScreenPosition = screenPosition.add( jitter );

			const ray = Ray.wrap( generateRayFromCamera(
				jitteredScreenPosition, seed,
				cameraWorldMatrix, cameraProjectionMatrixInverse,
				enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale,
			) );

			const sampleColor = vec4( 0.0 ).toVar();

			// Debug or normal trace
			If( visMode.greaterThan( int( 0 ) ), () => {

				sampleColor.assign( TraceDebugMode(
					ray.origin, ray.direction,
					bvhBuffer,
					triangleBuffer,
					materialBuffer,
					envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
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
					backgroundIntensity, showBackground, transparentBackground,
					fireflyThreshold, globalIlluminationIntensity,
					totalTriangleCount, enableEmissiveTriangleSampling,
					emissiveTriangleBuffer, emissiveTriangleCount, emissiveTotalPower, emissiveBoost,
					lightBVHBuffer, lightBVHNodeCount,
					pixelCoord, resolution, frame,
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

					} );

				} );

			} );

			pixelColor.addAssign( sampleColor );
			pixelAlpha.addAssign( sampleColor.w );
			pixelSamples.addAssign( 1 );

		} );

		// Average samples
		If( pixelSamples.greaterThan( int( 0 ) ), () => {

			pixelColor.divAssign( float( pixelSamples ) );
			pixelAlpha.divAssign( float( pixelSamples ) );

		} );

		// Edge sharpness for post-process sharpening (stored in pixelColor.w, separate from alpha)
		pixelColor.w.assign( computeEdgeSharpness( objectNormal, linearDepth, objectID ) );

		// Temporal accumulation
		const finalColor = pixelColor.xyz.toVar();
		const finalNormalDepth = vec4( worldNormal.mul( 0.5 ).add( 0.5 ), linearDepth ).toVar();
		const finalAlbedo = vec3( objectColor ).toVar();

		// Output alpha: accumulated per-sample alpha when transparent, otherwise 1.0
		const outputAlpha = select( transparentBackground, pixelAlpha, float( 1.0 ) ).toVar();

		If( enableAccumulation.and( cameraIsMoving.not() ).and( frame.greaterThan( uint( 0 ) ) ).and( hasPreviousAccumulated ), () => {

			const prevUV = pixelCoord.div( resolution );
			const prevAccumSample = texture( prevAccumTexture, prevUV, 0 ).toVar();

			finalColor.assign( mix( prevAccumSample.xyz, pixelColor.xyz, accumulationAlpha ) );
			finalNormalDepth.assign( mix( texture( prevNormalDepthTexture, prevUV, 0 ), finalNormalDepth, accumulationAlpha ) );
			finalAlbedo.assign( mix( texture( prevAlbedoTexture, prevUV, 0 ).xyz, finalAlbedo, accumulationAlpha ) );

			// Temporally accumulate alpha from previous frame's gColor.w
			If( transparentBackground, () => {

				outputAlpha.assign( mix( prevAccumSample.w, pixelAlpha, accumulationAlpha ) );

			} );

		} );

		// Clean MRT output
		return pathTracerOutputStruct( {
			gColor: vec4( finalColor.xyz, outputAlpha ),
			gNormalDepth: finalNormalDepth,
			gAlbedo: vec4( finalAlbedo, 1.0 ),
		} );

	} )();

};
