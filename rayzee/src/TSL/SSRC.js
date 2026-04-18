// Screen-Space Radiance Cache (SSRC) — TSL compute shader builders
//
// Two passes per frame:
//   Pass 1 (Temporal): Reproject previous cache via motion vectors, EMA blend
//   Pass 2 (Spatial):  8-tap neighbor reuse weighted by normal/depth similarity

import {
	Fn,
	vec3,
	vec4,
	float,
	int,
	ivec2,
	uvec2,
	If,
	max,
	min,
	mix,
	textureLoad,
	textureStore,
	localId,
	workgroupId,
} from 'three/tsl';
import { normalDepthWeight } from './Common.js';

// ── Pass 1: Temporal Accumulation ──────────────────────────────────────────

/**
 * Build the temporal reprojection + EMA accumulation compute shader.
 *
 * @param {object} params
 * @param {TextureNode} params.colorTexNode       — pathtracer:color (current frame)
 * @param {TextureNode} params.ndTexNode          — pathtracer:normalDepth (current frame)
 * @param {TextureNode} params.motionTexNode      — motionVector:screenSpace
 * @param {TextureNode} params.readCacheTexNode   — previous frame's cache (ping-pong read)
 * @param {TextureNode} params.readPrevNDTexNode  — previous frame's normalDepth (ping-pong read)
 * @param {StorageTexture} params.writeCacheTex   — this frame's cache output (ping-pong write)
 * @param {StorageTexture} params.writePrevNDTex  — current normalDepth saved for next frame
 * @param {uniform} params.resW / params.resH     — render dimensions
 * @param {uniform} params.temporalAlpha          — EMA blend factor (0.05–0.2)
 * @param {uniform} params.phiNormal              — normal edge-stopping exponent
 * @param {uniform} params.phiDepth               — depth edge-stopping scale
 * @param {uniform} params.maxHistory             — history frame cap
 * @param {uniform} params.framesSinceReset       — frames since last reset; 0 = skip cache lookup
 * @returns {Fn} — call `.compute([dX, dY, 1], [8, 8, 1])` on the result
 */
export function buildTemporalPass( {
	colorTexNode,
	ndTexNode,
	motionTexNode,
	readCacheTexNode,
	readPrevNDTexNode,
	writeCacheTex,
	writePrevNDTex,
	resW,
	resH,
	temporalAlpha,
	phiNormal,
	phiDepth,
	maxHistory,
	framesSinceReset,
} ) {

	const WG_SIZE = 8;

	return Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

			const coord = ivec2( gx, gy );

			// Current frame data
			const currentColor = textureLoad( colorTexNode, coord ).xyz;
			const currentND = textureLoad( ndTexNode, coord );

			// Default: pass-through, history = 1 (used on reset frames or cache misses)
			const result = vec4( currentColor, 1.0 ).toVar();

			// Skip cache lookup on the first frame after a reset — prevents stale data bleeding in
			If( framesSinceReset.greaterThan( int( 0 ) ), () => {

				// Read motion vector (.xy = UV-space offset, .w = validity)
				const motion = textureLoad( motionTexNode, coord );
				const motionValid = motion.w.greaterThan( 0.5 );

				// Reprojected pixel coordinates (ASVGF convention: current - motion * res)
				const prevXf = float( gx ).sub( motion.x.mul( resW ) );
				const prevYf = float( gy ).sub( motion.y.mul( resH ) );
				const prevOnScreen = prevXf.greaterThanEqual( 0.0 )
					.and( prevXf.lessThan( float( resW ) ) )
					.and( prevYf.greaterThanEqual( 0.0 ) )
					.and( prevYf.lessThan( float( resH ) ) );

				If( motionValid.and( prevOnScreen ), () => {

					const prevX = int( prevXf ).clamp( int( 0 ), int( resW ).sub( 1 ) );
					const prevY = int( prevYf ).clamp( int( 0 ), int( resH ).sub( 1 ) );
					const prevCoord = ivec2( prevX, prevY );

					// Edge-stopping: compare normals and depths
					// Normals packed in [0,1] in normalDepth texture — decode to [-1,1]
					const currentNormal = currentND.xyz.mul( 2.0 ).sub( 1.0 );
					const prevND = textureLoad( readPrevNDTexNode, prevCoord );
					const prevNormal = prevND.xyz.mul( 2.0 ).sub( 1.0 );

					const similarity = normalDepthWeight(
						currentNormal, prevNormal,
						currentND.w, prevND.w,
						phiNormal, phiDepth
					);

					If( similarity.greaterThan( 0.01 ), () => {

						// Read previous cache: .rgb = radiance, .w = history count
						const prevCache = textureLoad( readCacheTexNode, prevCoord );
						const prevColor = prevCache.xyz;
						const prevHistory = prevCache.w;

						// Effective alpha: at least temporalAlpha, but use 1/(history+1) when
						// history is low so the first few frames converge faster
						const historyAlpha = float( 1.0 ).div( prevHistory.add( 1.0 ) );
						const effectiveAlpha = max( temporalAlpha, historyAlpha );

						// Weigh alpha by similarity to suppress bleeding across edges
						const blendAlpha = min( effectiveAlpha.div( max( similarity, float( 0.1 ) ) ), 1.0 );

						const blended = mix( prevColor, currentColor, blendAlpha );
						const newHistory = min( prevHistory.add( 1.0 ), maxHistory );

						result.assign( vec4( blended, newHistory ) );

					} ).Else( () => {

						// Edge detected or similarity too low — start fresh
						result.assign( vec4( currentColor, 1.0 ) );

					} );

				} ).Else( () => {

					// Off-screen or invalid motion — start fresh
					result.assign( vec4( currentColor, 1.0 ) );

				} );

			} ); // end framesSinceReset guard

			// Always write — even on reset frames (seeds cache with current color,
			// and saves normalDepth so the next frame has valid prevND for edge-stopping)
			textureStore( writeCacheTex, uvec2( gx, gy ), result ).toWriteOnly();
			textureStore( writePrevNDTex, uvec2( gx, gy ), currentND ).toWriteOnly();

		} );

	} );

}

// ── Pass 2: Spatial Neighbor Reuse ─────────────────────────────────────────

/**
 * Build the spatial 8-tap neighbor reuse compute shader.
 *
 * Samples 8 neighbors at ±spatialRadius in a cross + diagonal pattern.
 * Spatial influence fades as temporal history accumulates (trust temporal over spatial).
 *
 * @param {object} params
 * @param {TextureNode} params.ndTexNode          — pathtracer:normalDepth (current frame)
 * @param {TextureNode} params.readCacheTexNode   — temporal cache from pass 1 (just-written)
 * @param {StorageTexture} params.outputTex       — final SSRC output
 * @param {uniform} params.resW / params.resH
 * @param {uniform} params.spatialRadius          — neighbor offset in pixels (int)
 * @param {uniform} params.spatialWeight          — max spatial contribution weight
 * @param {uniform} params.phiNormal              — normal edge-stopping exponent
 * @param {uniform} params.phiDepth               — depth edge-stopping scale
 * @returns {Fn}
 */
export function buildSpatialPass( {
	colorTexNode,
	ndTexNode,
	readCacheTexNode,
	outputTex,
	resW,
	resH,
	spatialRadius,
	spatialWeight,
	phiNormal,
	phiDepth,
} ) {

	const WG_SIZE = 8;

	// 8 neighbor offsets: axis-aligned ×4 + diagonal ×4
	const OFFSETS = [
		[ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ],
		[ 1, 1 ], [ - 1, 1 ], [ 1, - 1 ], [ - 1, - 1 ],
	];

	return Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

			const coord = ivec2( gx, gy );

			// Center pixel
			const centerCache = textureLoad( readCacheTexNode, coord );
			const centerColor = centerCache.xyz;
			const centerHistory = centerCache.w;
			const centerND = textureLoad( ndTexNode, coord );
			const centerNormal = centerND.xyz.mul( 2.0 ).sub( 1.0 );

			// Adaptive spatial weight: fades to 0 once history >= 16
			// (temporal data is reliable by then)
			const historyFactor = float( 1.0 ).sub(
				centerHistory.div( 16.0 ).clamp( 0.0, 1.0 )
			);
			const effectiveSpatialWeight = spatialWeight.mul( historyFactor );

			// Weighted sum over 8 neighbors
			const weightedSum = vec3( centerColor ).toVar();
			const weightSum = float( 1.0 ).toVar();

			for ( let i = 0; i < OFFSETS.length; i ++ ) {

				const [ ox, oy ] = OFFSETS[ i ];

				const nx = gx.add( int( spatialRadius ).mul( ox ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const ny = gy.add( int( spatialRadius ).mul( oy ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );

				const neighborCoord = ivec2( nx, ny );
				const neighborCache = textureLoad( readCacheTexNode, neighborCoord );
				const neighborColor = neighborCache.xyz;

				const neighborND = textureLoad( ndTexNode, neighborCoord );
				const neighborNormal = neighborND.xyz.mul( 2.0 ).sub( 1.0 );

				const w = normalDepthWeight(
					centerNormal, neighborNormal,
					centerND.w, neighborND.w,
					phiNormal, phiDepth
				);

				weightedSum.addAssign( neighborColor.mul( w ) );
				weightSum.addAssign( w );

			}

			// Blend: (1 - effective spatial) * temporal + effective spatial * spatial average
			const spatialAverage = weightedSum.div( max( weightSum, 0.0001 ) );
			const finalColor = mix( centerColor, spatialAverage, effectiveSpatialWeight );

			// Pass through path tracer alpha to support transparentBackground mode
			const ptAlpha = textureLoad( colorTexNode, coord ).w;
			textureStore( outputTex, uvec2( gx, gy ), vec4( finalColor, ptAlpha ) ).toWriteOnly();

		} );

	} );

}
