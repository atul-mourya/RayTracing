/**
 * FinalWriteKernel.js — wavefront final output: temporal accumulation + MRT StorageTexture writes (16×16, 2D).
 */

import {
	Fn, wgslFn, float, vec2, vec4, int, uint, uvec2,
	If, mix, select, texture, textureStore,
	localId, workgroupId,
} from 'three/tsl';

import {
	readRayRadiance, readGBuffer, gbDecodeNormalDepth, gbDecodeAlbedo,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 16;

// Debug mode 11: NaN/Inf detector — red where the accumulated color is NaN/Inf, black elsewhere.
const nanInfToRed = /*@__PURE__*/ wgslFn( `
	fn nanInfToRed( c: vec3f ) -> vec3f {
		let isNan = c.x != c.x || c.y != c.y || c.z != c.z;
		let isInf = abs( c.x ) > 1e30f || abs( c.y ) > 1e30f || abs( c.z ) > 1e30f;
		if ( isNan || isInf ) { return vec3f( 1.0f, 0.0f, 0.0f ); }
		return vec3f( 0.0f );
	}
` );

export function buildFinalWriteKernel( params ) {

	const {
		rayBufferRO, gBufferRO,
		writeColorTex, writeNDTex, writeAlbedoTex,
		resolution, frame,
		enableAccumulation, hasPreviousAccumulated, accumulationAlpha, cameraIsMoving,
		transparentBackground,
		prevAccumTexture, prevAlbedoTexture,
		renderWidth, renderHeight,
		visMode,
		// Aux MRT (normalDepth + albedo) feeds only the denoiser/OIDN. Gated by a live uniform (1 = denoiser
		// on): when off, skip the G-buffer decode, the prev-frame aux mix, and the two aux stores.
		auxGBufferEnabled,
	} = params;

	const auxOn = auxGBufferEnabled.greaterThan( uint( 0 ) );

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( renderWidth ).and( gy.lessThan( renderHeight ) ), () => {

			const pixelIndex = gy.mul( int( resolution.x ) ).add( gx );
			const rayID = uint( pixelIndex );

			const sampleColor = readRayRadiance( rayBufferRO, rayID );
			const finalColor = sampleColor.xyz.toVar();
			const outputAlpha = select( transparentBackground, sampleColor.w, float( 1.0 ) ).toVar();

			// MRT comes from the per-pixel G-buffer (rayID == pixelIndex). Half-packed: decode.
			// auxOn gates the decode + stores so a no-denoiser frame does no G-buffer read and no aux writes.
			const finalNormalDepth = vec4( 0.0 ).toVar();
			const finalAlbedo = vec4( 0.0 ).xyz.toVar();
			If( auxOn, () => {

				const gbuf = readGBuffer( gBufferRO, rayID );
				finalNormalDepth.assign( gbDecodeNormalDepth( gbuf ) );
				finalAlbedo.assign( vec4( gbDecodeAlbedo( gbuf ), 0.0 ).xyz );

			} );

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const prevUV = pixelCoord.div( resolution );

			// visMode 11 (NaN/Inf) bypasses accumulation (megakernel parity main_TSL_PathTracer.js:355) so the
			// detector runs on each frame's fresh color — else mix() propagates a transient NaN and it stays red forever.
			If( enableAccumulation.and( cameraIsMoving.not() ).and( frame.greaterThan( uint( 0 ) ) ).and( hasPreviousAccumulated ).and( visMode.notEqual( int( 11 ) ) ), () => {

				const prevAccumSample = texture( prevAccumTexture, prevUV, 0 ).toVar();

				finalColor.assign( mix( prevAccumSample.xyz, sampleColor.xyz, accumulationAlpha ) );
				If( auxOn, () => {

					// Albedo averages cleanly (it's a colour). The NORMAL must NOT: averaging jittered
					// unit normals collapses toward the flat geometric mean (worse at distance), which made
					// OIDN smooth bump detail away. Keep this frame's point-sampled normal — it varies with
					// the bump, which is exactly what OIDN's edge-stop needs to preserve it.
					finalAlbedo.assign( mix( texture( prevAlbedoTexture, prevUV, 0 ).xyz, finalAlbedo, accumulationAlpha ) );

				} );

				If( transparentBackground, () => {

					outputAlpha.assign( mix( prevAccumSample.w, sampleColor.w, accumulationAlpha ) );

				} );

			} );

			// Debug mode 11: flag NaN/Inf on the accumulated color (red on NaN/Inf, black elsewhere).
			If( visMode.equal( int( 11 ) ), () => {

				finalColor.assign( nanInfToRed( finalColor ) );

			} );

			const uintCoord = uvec2( uint( gx ), uint( gy ) );
			textureStore( writeColorTex, uintCoord, vec4( finalColor, outputAlpha ) ).toWriteOnly();
			If( auxOn, () => {

				textureStore( writeNDTex, uintCoord, finalNormalDepth ).toWriteOnly();
				textureStore( writeAlbedoTex, uintCoord, vec4( finalAlbedo, 1.0 ) ).toWriteOnly();

			} );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as FINALWRITE_WG_SIZE };
