/**
 * GenerateKernel.js — wavefront primary ray generation (16×16, 2D screen-space dispatch).
 */

import {
	Fn, float, vec2, vec4, int, uint,
	If, texture, atomicAdd,
	localId, workgroupId,
} from 'three/tsl';

import {
	getDecorrelatedSeed,
	pcgHash,
	getStratifiedSample,
} from './Random.js';

import { generateRayFromCamera } from './BVHTraversal.js';
import { Ray } from './Struct.js';
import { getRequiredSamples } from './PathTracerCore.js';
import { RAY_FLAG, COUNTER } from '../Processor/QueueManager.js';
import {
	writeRayOriginMeta, writeRayDirFlags, writeRayThroughputPdf,
	writeRayRadiance, writeRayNormalDepth, writeRayAlbedoID,
	writeMediumStack,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 16;

export function buildGenerateKernel( params ) {

	const {
		rayBufferRW, rngBufferRW,
		resolution, frame,
		cameraWorldMatrix, cameraProjectionMatrixInverse,
		enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
		renderWidth, renderHeight,
		useAdaptiveSampling, adaptiveSamplingTexture,
		adaptiveSamplingMin, adaptiveSamplingMax,
		enableAccumulation, hasPreviousAccumulated,
		prevAccumTexture, prevNormalDepthTexture,
		// Multi-sample: S primary rays/pixel/frame; S>1 dispatch covers h*S rows, ray lands in slot subSample*maxRaysPerSample + pixelIndex.
		samplesPerPass = 1, maxRaysPerSample = 0,
		// Stream-compaction (functional path): when present, generate atomic-appends each traced ray to the dense active list, skipping carried-forward (converged) pixels so bounce-0 Extend never touches them.
		counters, activeIndicesWriteRW,
	} = params;

	const S = samplesPerPass | 0;
	const streamCompact = counters !== undefined && activeIndicesWriteRW !== undefined;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gyRaw = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		const subSample = S > 1 ? gyRaw.div( renderHeight ).toVar() : int( 0 );
		const gy = S > 1 ? gyRaw.sub( subSample.mul( renderHeight ) ).toVar() : gyRaw;
		const yBound = S > 1 ? renderHeight.mul( int( S ) ) : renderHeight;

		If( gx.lessThan( renderWidth ).and( gyRaw.lessThan( yBound ) ), () => {

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const pixelIndex = gy.mul( int( resolution.x ) ).add( gx );
			const rayID = S > 1
				? uint( pixelIndex ).add( uint( subSample ).mul( uint( maxRaysPerSample ) ) )
				: uint( pixelIndex );

			const screenPosition = pixelCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar();
			screenPosition.y.assign( screenPosition.y.negate() );

			const baseSeed = getDecorrelatedSeed( { pixelCoord, rayIndex: subSample, frame } ).toVar();
			const seed = pcgHash( { state: baseSeed } ).toVar();

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

				// Converged pixel: carry forward, mark inactive.
				writeRayRadiance( rayBufferRW, rayID, carryForwardColor );
				writeRayDirFlags( rayBufferRW, rayID, vec4( 0.0 ).xyz, uint( 0 ) );
				writeRayOriginMeta( rayBufferRW, rayID, vec4( 0.0 ).xyz, int( 0 ), int( 0 ) );
				writeRayNormalDepth( rayBufferRW, rayID, carryForwardND );
				writeRayAlbedoID( rayBufferRW, rayID, vec4( 0.0 ) );

			} ).Else( () => {

				const stratifiedJitter = getStratifiedSample( pixelCoord, subSample, int( S ), seed, resolution, frame ).toVar();

				const jitterScale = vec2( 2.0 ).div( resolution );
				const jitter = stratifiedJitter.sub( 0.5 ).mul( jitterScale );
				const jitteredScreenPosition = screenPosition.add( jitter );

				const ray = Ray.wrap( generateRayFromCamera(
					jitteredScreenPosition, seed,
					cameraWorldMatrix, cameraProjectionMatrixInverse,
					enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
				) );

				writeRayOriginMeta( rayBufferRW, rayID, ray.origin, int( 0 ), int( 0 ) );
				writeRayDirFlags( rayBufferRW, rayID, ray.direction, uint( RAY_FLAG.ACTIVE ) );
				writeRayThroughputPdf( rayBufferRW, rayID, vec4( 1.0, 1.0, 1.0, 0.0 ).xyz, float( 1.0 ) );
				writeRayRadiance( rayBufferRW, rayID, vec4( 0.0 ) );

				writeRayNormalDepth( rayBufferRW, rayID, vec4( 0.5, 0.5, 1.0, 1.0 ) );
				writeRayAlbedoID( rayBufferRW, rayID, vec4( 0.0, 0.0, 0.0, - 1000.0 ) );

				writeMediumStack( rayBufferRW, rayID, uint( 0 ), uint( 5 ), float( 1.0 ), float( 1.0 ), float( 1.0 ) );

				rngBufferRW.element( rayID ).assign( seed );

				// Stream-compact: append this traced ray to the dense active list (only while adaptive sampling
				// is skipping converged pixels — frame>2 gate matches the carry-forward branch above). Converged
				// pixels take the shouldTrace==0 branch and are never appended, so bounce-0 Extend skips them.
				if ( streamCompact ) {

					If( useAdaptiveSampling.and( frame.greaterThan( uint( 2 ) ) ), () => {

						const writeIdx = atomicAdd( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 1 ) );
						activeIndicesWriteRW.element( writeIdx ).assign( rayID );

					} );

				}

			} );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as GENERATE_WG_SIZE };
