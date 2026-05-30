/**
 * FinalWriteKernel.js — wavefront final output: temporal accumulation + MRT StorageTexture writes (16×16, 2D).
 */

import {
	Fn, float, vec2, vec4, int, uint, uvec2,
	If, mix, select, texture, textureStore,
	localId, workgroupId,
} from 'three/tsl';

import {
	readRayRadiance, readRayNormalDepth, readRayAlbedoID,
} from '../../Processor/PackedRayBuffer.js';

const WG_SIZE = 16;

export function buildFinalWriteKernel( params ) {

	const {
		rayBufferRO,
		writeColorTex, writeNDTex, writeAlbedoTex,
		resolution, frame,
		enableAccumulation, hasPreviousAccumulated, accumulationAlpha, cameraIsMoving,
		transparentBackground,
		prevAccumTexture, prevNormalDepthTexture, prevAlbedoTexture,
		tileOffsetX, tileOffsetY, renderWidth, renderHeight,
		// Multi-sample: average S sample-slots per pixel (slots pixel + k*maxRaysPerSample).
		samplesPerPass = 1, maxRaysPerSample = 0,
	} = params;

	const S = samplesPerPass | 0;

	const computeFn = Fn( () => {

		const gx = tileOffsetX.add( int( workgroupId.x ).mul( WG_SIZE ) ).add( int( localId.x ) );
		const gy = tileOffsetY.add( int( workgroupId.y ).mul( WG_SIZE ) ).add( int( localId.y ) );

		If( gx.lessThan( renderWidth ).and( gy.lessThan( renderHeight ) ), () => {

			const pixelIndex = gy.mul( int( resolution.x ) ).add( gx );
			const rayID = uint( pixelIndex );

			// Average the S sub-samples; MRT (normal/depth/albedo) from sub-sample 0.
			const sampleColor = ( () => {

				if ( S <= 1 ) return readRayRadiance( rayBufferRO, rayID );
				const acc = readRayRadiance( rayBufferRO, rayID ).toVar();
				for ( let k = 1; k < S; k ++ ) {

					acc.addAssign( readRayRadiance( rayBufferRO, rayID.add( uint( k * maxRaysPerSample ) ) ) );

				}

				acc.assign( acc.div( float( S ) ) );
				return acc;

			} )();
			const normalDepth = readRayNormalDepth( rayBufferRO, rayID );
			const albedoID = readRayAlbedoID( rayBufferRO, rayID );

			const finalColor = sampleColor.xyz.toVar();
			const finalNormalDepth = normalDepth.toVar();
			const finalAlbedo = albedoID.xyz.toVar();
			const outputAlpha = select( transparentBackground, sampleColor.w, float( 1.0 ) ).toVar();

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const prevUV = pixelCoord.div( resolution );

			If( enableAccumulation.and( cameraIsMoving.not() ).and( frame.greaterThan( uint( 0 ) ) ).and( hasPreviousAccumulated ), () => {

				const prevAccumSample = texture( prevAccumTexture, prevUV, 0 ).toVar();

				finalColor.assign( mix( prevAccumSample.xyz, sampleColor.xyz, accumulationAlpha ) );
				finalNormalDepth.assign( mix( texture( prevNormalDepthTexture, prevUV, 0 ), finalNormalDepth, accumulationAlpha ) );
				finalAlbedo.assign( mix( texture( prevAlbedoTexture, prevUV, 0 ).xyz, finalAlbedo, accumulationAlpha ) );

				If( transparentBackground, () => {

					outputAlpha.assign( mix( prevAccumSample.w, sampleColor.w, accumulationAlpha ) );

				} );

			} );

			const uintCoord = uvec2( uint( gx ), uint( gy ) );
			textureStore( writeColorTex, uintCoord, vec4( finalColor, outputAlpha ) ).toWriteOnly();
			textureStore( writeNDTex, uintCoord, finalNormalDepth ).toWriteOnly();
			textureStore( writeAlbedoTex, uintCoord, vec4( finalAlbedo, 1.0 ) ).toWriteOnly();

		} );

	} );

	return computeFn;

}

export { WG_SIZE as FINALWRITE_WG_SIZE };
