/**
 * GenerateKernel.js — wavefront primary ray generation (16×16, 2D screen-space dispatch).
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, select,
	localId, workgroupId,
} from 'three/tsl';

import {
	getDecorrelatedSeed,
	pcgHash,
	getStratifiedSample,
} from './Random.js';

import { generateRayFromCamera } from './BVHTraversal.js';
import { Ray } from './Struct.js';
import { RAY_FLAG } from '../Processor/QueueManager.js';
import {
	writeRayOriginMeta, writeRayDirFlags, writeRayThroughputPdf,
	writeRayRadiance, writeGBuffer,
	writeMediumStack,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 16;

export function buildGenerateKernel( params ) {

	const {
		rayBufferRW, rngBufferRW, gBufferRW,
		resolution, frame,
		cameraWorldMatrix, cameraProjectionMatrixInverse,
		enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
		renderWidth, renderHeight,
		// Multi-sample: S primary rays/pixel/frame; S>1 dispatch covers h*S rows, ray lands in slot subSample*(w*h) + pixelIndex.
		samplesPerPass = 1,
		transmissiveBounces, // per-ray refraction budget (megakernel parity: PathTracerCore.js:606)
		transparentBackground, // alpha inits to 1 here (megakernel parity: PathTracerCore.js:554) — env-escape-without-opaque zeroes it in Shade
	} = params;

	const S = samplesPerPass | 0;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gyRaw = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		const subSample = S > 1 ? gyRaw.div( renderHeight ).toVar() : int( 0 );
		const gy = S > 1 ? gyRaw.sub( subSample.mul( renderHeight ) ).toVar() : gyRaw;
		const yBound = S > 1 ? renderHeight.mul( int( S ) ) : renderHeight;

		If( gx.lessThan( renderWidth ).and( gyRaw.lessThan( yBound ) ), () => {

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const pixelIndex = gy.mul( int( resolution.x ) ).add( gx );
			// maxRaysPerSample = w*h, derived from the resolution uniform (NOT baked) so resize never changes the WGSL.
			const rayID = S > 1
				? uint( pixelIndex ).add( uint( subSample ).mul( uint( resolution.x ).mul( uint( resolution.y ) ) ) )
				: uint( pixelIndex );

			const screenPosition = pixelCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar();
			screenPosition.y.assign( screenPosition.y.negate() );

			const baseSeed = getDecorrelatedSeed( { pixelCoord, rayIndex: subSample, frame } ).toVar();
			const seed = pcgHash( { state: baseSeed } ).toVar();

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
			// Alpha inits to 1 in transparent-bg mode (megakernel parity: PathTracerCore.js:554). Shade zeroes
			// it only on env-escape-without-opaque; a ray that dies inside geometry (e.g. SSS walk termination)
			// keeps alpha 1 → solid. Non-transparent mode is inert (FinalWrite forces alpha 1).
			writeRayRadiance( rayBufferRW, rayID, vec4( vec3( 0.0 ), select( transparentBackground, float( 1.0 ), float( 0.0 ) ) ) );

			If( subSample.equal( int( 0 ) ), () => {

				// default: normal +Z, depth 1 (far), black albedo (background/miss)
				writeGBuffer( gBufferRW, uint( pixelIndex ), vec3( 0.0, 0.0, 1.0 ), float( 1.0 ), vec3( 0.0 ) );

			} );

			writeMediumStack( rayBufferRW, rayID, uint( 0 ), uint( transmissiveBounces ), float( 1.0 ), float( 1.0 ), float( 1.0 ) );

			rngBufferRW.element( rayID ).assign( seed );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as GENERATE_WG_SIZE };
