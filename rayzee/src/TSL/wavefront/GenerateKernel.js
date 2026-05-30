/**
 * GenerateKernel.js — Wavefront Primary Ray Generation
 *
 * 16×16 workgroup, 2D screen-space dispatch.
 * Generates primary camera rays and writes them to packed AoS ray buffer.
 *
 * Storage buffer bindings: 2 (rayBuffer_WR + rngBuffer_WR)
 */

import {
	Fn, float, vec2, vec4, int, uint,
	If, texture,
	localId, workgroupId,
} from 'three/tsl';

import {
	getDecorrelatedSeed,
	pcgHash,
	RandomValue,
} from '../Random.js';

import { generateRayFromCamera } from '../BVHTraversal.js';
import { Ray } from '../Struct.js';
import { getRequiredSamples } from '../PathTracer.js';
import { RAY_FLAG } from '../../Processor/QueueManager.js';
import {
	writeRayOriginPixel, writeRayDirFlags, writeRayThroughputPdf,
	writeRayRadiance, writeRayNormalDepth, writeRayAlbedoID,
	writeMediumStack,
} from '../../Processor/PackedRayBuffer.js';

const WG_SIZE = 16;

/**
 * Build the Generate compute kernel.
 *
 * @param {Object} params
 * @returns {Function} TSL Fn to compile via .compute()
 */
export function buildGenerateKernel( params ) {

	const {
		// Packed buffers
		rayBufferRW, rngBufferRW,
		// Uniforms
		resolution, frame,
		// Camera
		cameraWorldMatrix, cameraProjectionMatrixInverse,
		enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
		// Tile
		tileOffsetX, tileOffsetY, renderWidth, renderHeight,
		// Adaptive sampling
		useAdaptiveSampling, adaptiveSamplingTexture,
		adaptiveSamplingMin, adaptiveSamplingMax,
		// Accumulation (for converged pixel carry-forward)
		enableAccumulation, hasPreviousAccumulated,
		prevAccumTexture, prevNormalDepthTexture,
		// Phase 3 multi-sample: S samples/pixel/frame. samplesPerPass (JS const, default 1)
		// + maxRaysPerSample (JS const = w*h). When S>1 the dispatch covers h*S rows; row gy
		// decodes to (subSample = gy/h, pixelY = gy%h) and the ray lands in a distinct slot
		// subSample*maxRaysPerSample + pixelIndex. S=1 emits the original single-sample path.
		samplesPerPass = 1, maxRaysPerSample = 0,
	} = params;

	const S = samplesPerPass | 0;

	const computeFn = Fn( () => {

		const gx = tileOffsetX.add( int( workgroupId.x ).mul( WG_SIZE ) ).add( int( localId.x ) );
		const gyRaw = tileOffsetY.add( int( workgroupId.y ).mul( WG_SIZE ) ).add( int( localId.y ) );

		// Multi-sample row decode (no-op when S===1).
		const subSample = S > 1 ? gyRaw.div( renderHeight ).toVar() : int( 0 );
		const gy = S > 1 ? gyRaw.sub( subSample.mul( renderHeight ) ).toVar() : gyRaw;
		const yBound = S > 1 ? renderHeight.mul( int( S ) ) : renderHeight;

		If( gx.lessThan( renderWidth ).and( gyRaw.lessThan( yBound ) ), () => {

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const pixelIndex = gy.mul( int( resolution.x ) ).add( gx );
			const rayID = S > 1
				? uint( pixelIndex ).add( uint( subSample ).mul( uint( maxRaysPerSample ) ) )
				: uint( pixelIndex );

			// Screen position in NDC [-1, 1] with Y negated
			const screenPosition = pixelCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar();
			screenPosition.y.assign( screenPosition.y.negate() );

			// RNG seed — decorrelate per sub-sample so the S rays jitter independently.
			const baseSeed = getDecorrelatedSeed( { pixelCoord, rayIndex: subSample, frame } ).toVar();
			const seed = pcgHash( { state: baseSeed } ).toVar();

			// Check adaptive sampling — skip converged pixels
			const shouldTrace = int( 1 ).toVar();
			const carryForwardColor = vec4( 0.0 ).toVar();
			const carryForwardND = vec4( 0.0, 0.0, 1.0, 1.0 ).toVar();

			If( frame.greaterThan( uint( 2 ) ).and( useAdaptiveSampling ), () => {

				const adaptiveSamples = getRequiredSamples(
					pixelCoord, resolution,
					adaptiveSamplingTexture, adaptiveSamplingMin, adaptiveSamplingMax,
				);

				If( adaptiveSamples.equal( int( 0 ) ), () => {

					If( enableAccumulation.and( hasPreviousAccumulated ), () => {

						const prevUV = pixelCoord.div( resolution );
						carryForwardColor.assign( texture( prevAccumTexture, prevUV, 0 ) );
						carryForwardND.assign( texture( prevNormalDepthTexture, prevUV, 0 ) );
						shouldTrace.assign( 0 );

					} );

				} );

			} );

			If( shouldTrace.equal( 0 ), () => {

				// Converged pixel — write carry-forward data, mark inactive
				writeRayRadiance( rayBufferRW, rayID, carryForwardColor );
				writeRayDirFlags( rayBufferRW, rayID, vec4( 0.0 ).xyz, uint( 0 ) );
				writeRayOriginPixel( rayBufferRW, rayID, vec4( 0.0 ).xyz, uint( pixelIndex ) );
				writeRayNormalDepth( rayBufferRW, rayID, carryForwardND );
				writeRayAlbedoID( rayBufferRW, rayID, vec4( 0.0 ) );

			} ).Else( () => {

				// PCG jitter (pure arithmetic — avoids blue-noise texture binding)
				const stratifiedJitter = vec2( RandomValue( seed ), RandomValue( seed ) ).toVar();

				const jitterScale = vec2( 2.0 ).div( resolution );
				const jitter = stratifiedJitter.sub( 0.5 ).mul( jitterScale );
				const jitteredScreenPosition = screenPosition.add( jitter );

				// Generate camera ray
				const ray = Ray.wrap( generateRayFromCamera(
					jitteredScreenPosition, seed,
					cameraWorldMatrix, cameraProjectionMatrixInverse,
					enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
				) );

				// Write to packed ray buffer
				writeRayOriginPixel( rayBufferRW, rayID, ray.origin, uint( pixelIndex ) );
				writeRayDirFlags( rayBufferRW, rayID, ray.direction, uint( RAY_FLAG.ACTIVE ) );
				writeRayThroughputPdf( rayBufferRW, rayID, vec4( 1.0, 1.0, 1.0, 0.0 ).xyz, float( 1.0 ) );
				writeRayRadiance( rayBufferRW, rayID, vec4( 0.0 ) );

				// Initialize first-hit defaults (background)
				writeRayNormalDepth( rayBufferRW, rayID, vec4( 0.5, 0.5, 1.0, 1.0 ) );
				writeRayAlbedoID( rayBufferRW, rayID, vec4( 0.0, 0.0, 0.0, - 1000.0 ) );

				// Initialize medium stack (empty, transmissiveBounces from uniform)
				writeMediumStack( rayBufferRW, rayID, uint( 0 ), uint( 5 ), float( 1.0 ), float( 1.0 ), float( 1.0 ) );

				// Write RNG seed
				rngBufferRW.element( rayID ).assign( seed );

			} );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as GENERATE_WG_SIZE };
