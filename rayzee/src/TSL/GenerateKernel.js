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
	writeRayRadiance, writeGBuffer, writeGBufferSurfaceID,
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
		transmissiveBounces, // per-ray refraction budget (megakernel parity: PathTracerCore.js:606)
		transparentBackground, // alpha inits to 1 here (megakernel parity: PathTracerCore.js:554) — env-escape-without-opaque zeroes it in Shade
		auxGBufferEnabled, // live uniform: 1 = init the per-pixel G-buffer (denoiser on), 0 = skip it
	} = params;

	const auxOn = auxGBufferEnabled.greaterThan( uint( 0 ) );

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( renderWidth ).and( gy.lessThan( renderHeight ) ), () => {

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const pixelIndex = gy.mul( int( resolution.x ) ).add( gx );
			// One ray per pixel: rayID is the pixel index.
			const rayID = uint( pixelIndex );

			const screenPosition = pixelCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar();
			screenPosition.y.assign( screenPosition.y.negate() );

			const baseSeed = getDecorrelatedSeed( { pixelCoord, rayIndex: int( 0 ), frame } ).toVar();
			const seed = pcgHash( { state: baseSeed } ).toVar();

			const stratifiedJitter = getStratifiedSample( pixelCoord, int( 0 ), int( 1 ), seed, resolution, frame ).toVar();

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
			// pdf inits to 0 = prevBouncePdf (megakernel parity PathTracerCore.js:556). The bounce>0 env/emissive
			// MIS gate skips until an opaque scatter writes a real combinedPdf; free bounces preserve it.
			writeRayThroughputPdf( rayBufferRW, rayID, vec4( 1.0, 1.0, 1.0, 0.0 ).xyz, float( 0.0 ) );
			// Alpha inits to 1 in transparent-bg mode (megakernel parity: PathTracerCore.js:554). Shade zeroes
			// it only on env-escape-without-opaque; a ray that dies inside geometry (e.g. SSS walk termination)
			// keeps alpha 1 → solid. Non-transparent mode is inert (FinalWrite forces alpha 1).
			writeRayRadiance( rayBufferRW, rayID, vec4( vec3( 0.0 ), select( transparentBackground, float( 1.0 ), float( 0.0 ) ) ) );

			If( auxOn, () => {

				// default: normal +Z, depth 1 (far), black albedo (background/miss)
				writeGBuffer( gBufferRW, uint( pixelIndex ), vec3( 0.0, 0.0, 1.0 ), float( 1.0 ), vec3( 0.0 ) );
				// surface-ID lane defaults to invalid (valid=0); Shade overwrites it at the bounce-0 hit.
				writeGBufferSurfaceID( gBufferRW, uint( pixelIndex ), uint( 0 ), uint( 0 ), float( 0.0 ), float( 0.0 ), uint( 0 ) );

			} );

			writeMediumStack( rayBufferRW, rayID, uint( 0 ), uint( transmissiveBounces ), float( 1.0 ), float( 1.0 ), float( 1.0 ) );

			rngBufferRW.element( rayID ).assign( seed );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as GENERATE_WG_SIZE };
