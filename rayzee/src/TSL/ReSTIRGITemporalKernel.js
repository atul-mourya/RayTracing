/**
 * ReSTIRGITemporalKernel.js — ReSTIR GI/PT temporal reuse (per-pixel 16×16, 2D screen dispatch).
 *
 * Specs: restir-gi-phase02.md §4.3 + restir-pt-phase03.md §PT-2/PT-2b. Reprojects the prev-frame
 * reservoir via the motion vector, disocclusion-gates (normal + linear view-Z), M-caps, and merges via
 * the cross-evaluated GRIS combine. PT-2b: MOTION-CORRECT — the history arm's own-domain cross-target is
 * evaluated at the TRUE previous-frame jittered x0 (ping-ponged primaryHit, prev parity) with the real
 * per-arm reconnection Jacobians; the old x0_q′=x0_q collapse normalized the history W against a
 * different target than the combine evaluated (Eq. 11 violation under sub-pixel jitter — the measured
 * −0.8pp temporal carrier on close-emitter scenes, quadratic in the pdfs). All targets evaluate through
 * the SHARED PT-2 domain evaluator (ReSTIRGIEval).
 *
 * Arm engagement gates on M (confidence), NOT the realized sample (valid) — realization-dependent arm
 * selection is biased and wiped temporal history. M==0 = non-participating pixel (no kill) — skip.
 *
 * PT-3c-2: k-branched cross-targets — k≤1 keeps the PT-2 f·cos·evalLo formula bit-identical; k>1
 * arms are a SAME-DOMAIN merge: ONE replay at the CURRENT exact domain per arm (shared target Fn),
 * history own-domain target = STORED pHatOwn (Eq. 8 pairing), Jacobian endpoints at the x0 offsets.
 * Replaying at Q′ from quantized Nprev + current-frame material diverges from the true own-domain
 * replay through a glossy prefix — a CONSTANT jacS asymmetry; any jacS > cS/(cS−cC) turns the
 * temporal multiplier wSum·jacS·cS/(cS+cC·jacS) past 1 ⇒ exponential wSum blow-up (the mb4 ×10³
 * reuse explosion). Same-domain form: wS ≤ wSum_s·cS/cC, fixed-point multiplier 20/21 — stable.
 *
 * Storage buffers (≤10): hit, rng, mat, giReservoirRW, primaryHit, triangleBuffer (PT-2 emissive-pdf
 * re-derivation), bvh (PT-3c-2 replay) = 7 SB. Motion vector + prev normalDepth + material maps are
 * textures (0 SB). Write pattern: canonical → snapshot slot S first, merged overwrites on engage
 * (same-invocation program-ordered; replaces the scalar mirror vars).
 */

import {
	Fn, float, vec4, int, uint, ivec2,
	If, normalize, max, dot, abs, Return,
	textureLoad,
	localId, workgroupId,
} from 'three/tsl';

import {
	readHitDistance, readHitNormal, readHitMaterialIndex, readHitBarycentrics,
} from '../Processor/PackedRayBuffer.js';
import { RandomValue } from './Random.js';
import { getMaterial, luminance, computeDotProducts } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { RayTracingMaterial, MaterialSamples, DotProducts } from './Struct.js';
import { makeGILoEvaluator } from './ReSTIRGIEval.js';
import { makeGIPrefixReplay, makeGIReplayTarget, GIReplayTargetResult } from './ReSTIRGIReplay.js';
import {
	GIReservoir, giReservoirCapM, reservoirCombineGIShifted,
	reservoirSlotIndexGI, giPrimaryHitIndex, writeGIReservoir, readGIReservoir,
	giX1, giN1, giReconnectionJacobian, giIsReusable,
	GI_SNAPSHOT_SLOT, GI_TEMPORAL_M_CAP_MULTIPLIER,
} from './ReSTIRGICore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;
const NORMAL_THRESHOLD = 0.9;
const DEPTH_REL_THRESHOLD = 0.1;

export function buildRestirGITemporalKernel( params ) {

	const {
		hitBufferRO, rngBufferRW, materialBuffer, triangleBuffer, bvhBuffer,
		giReservoirPoolRW, primaryHitBuffer,
		motionVectorTex, prevNormalDepthTex,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		emissiveTotalPower,
		cameraWorldMatrix, cameraProjectionMatrixInverse, cameraViewMatrix,
		frameParityUniform, resolutionUniform,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		restirGIRoughnessTau, enableAlphaShadows,
	} = params;

	const evalLo = makeGILoEvaluator( {
		materialBuffer, triangleBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		emissiveTotalPower,
	} );

	// PT-3c-2: the SAME replay + target closures gi-initial/resolve build (Eq. 8 — one target function).
	const prefixReplay = makeGIPrefixReplay( {
		bvhBuffer, triangleBuffer, materialBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		restirGIRoughnessTau, enableAlphaShadows,
	} );
	const replayTarget = makeGIReplayTarget( {
		prefixReplay, evalLo, materialBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
	} );

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			const resW = int( resolutionUniform.x ).toVar();
			const resH = int( resolutionUniform.y ).toVar();
			const pixelIndex = gy.mul( resW ).add( gx );
			const rayID = uint( pixelIndex );

			const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
			If( hitDist.greaterThan( MISS_DIST ), () => {

				Return();

			} );

			// canonical (cur slot) → snapshot S unconditionally; merged overwrites below on engage
			const curParity = frameParityUniform;
			const baseIdxCur = reservoirSlotIndexGI( gx, gy, resW, curParity ).toVar();
			const canonical = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdxCur ) ).toVar();
			const baseIdxOut = reservoirSlotIndexGI( gx, gy, resW, int( GI_SNAPSHOT_SLOT ) ).toVar();
			writeGIReservoir( giReservoirPoolRW, baseIdxOut, canonical );

			const rngState = rngBufferRW.element( rayID ).toVar();

			// M>0 = participating pixel (reconnectable x0, continuation killed)
			If( canonical.M.greaterThan( float( 0.0 ) ), () => {

				const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
				const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
				const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

				const P = primaryHitBuffer.element( giPrimaryHitIndex( pixelIndex, curParity ) ).xyz.toVar();
				const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
				const V = normalize( camPos.sub( P ) ).toVar();

				const material = RayTracingMaterial.wrap( getMaterial( int( hitMatIdx ), materialBuffer ) ).toVar();
				const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
					albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
					material, hitUV, normalize( hitNormal ),
				) ).toVar();
				material.color.assign( matSamples.albedo );
				material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
				material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );
				material.sheenRoughness.assign( material.sheenRoughness.clamp( 0.05, 1.0 ) );

				const N = matSamples.normal.toVar();
				If( dot( N, V ).lessThan( 0.0 ), () => {

					N.assign( N.negate() );

				} );

				// p̂ of a stored sample at a given DOMAIN surface — the SHARED PT-2 evaluator re-derives the
				// frozen MIS weights + f_{x1} at that domain. PT-2b evaluates the history arm at the TRUE
				// previous-frame x0 (below), so the material here is the CURRENT pixel's rebuild — valid for
				// the prev surface too (same world surface under the disocclusion gate).
				const giPHatAt = ( r, atP, atN, atV ) => {

					const org = atP.add( atN.mul( 0.001 ) );
					const wi = normalize( giX1( r ).sub( org ) );
					const ndl = max( dot( atN, wi ), float( 0.0 ) );
					const dots = DotProducts.wrap( computeDotProducts( atN, atV, wi ) );
					const f = evaluateMaterialResponseFromDots( material, dots );
					return luminance( { color: f.mul( ndl ).mul( evalLo( r, atP, atN, atV, material, int( 0 ) ) ) } );

				};

				// reproject via the (1-frame-stale) motion vector
				const motion = textureLoad( motionVectorTex, ivec2( gx, gy ) ).toVar();
				const prevXf = float( gx ).add( 0.5 ).sub( motion.x.mul( float( resW ) ) ).toVar();
				const prevYf = float( gy ).add( 0.5 ).sub( motion.y.mul( float( resH ) ) ).toVar();
				const inBounds = motion.w.greaterThan( 0.5 )
					.and( prevXf.greaterThanEqual( 0.0 ) ).and( prevXf.lessThan( float( resW ) ) )
					.and( prevYf.greaterThanEqual( 0.0 ) ).and( prevYf.lessThan( float( resH ) ) );
				const gxPrev = int( prevXf ).clamp( int( 0 ), resW.sub( int( 1 ) ) ).toVar();
				const gyPrev = int( prevYf ).clamp( int( 0 ), resH.sub( int( 1 ) ) ).toVar();

				// disocclusion gate (normal + linear view-Z depth, same as DI)
				const prevND = textureLoad( prevNormalDepthTex, ivec2( gxPrev, gyPrev ) ).toVar();
				const prevN = prevND.xyz.mul( 2.0 ).sub( 1.0 ).toVar();
				const prevDepth = prevND.w.toVar();
				const curViewZ = abs( cameraViewMatrix.mul( vec4( P, 1.0 ) ).z ).toVar();
				const prevView = cameraProjectionMatrixInverse.mul(
					vec4( 0.0, 0.0, prevDepth.mul( 2.0 ).sub( 1.0 ), 1.0 ) ).toVar();
				const prevViewZ = abs( prevView.z.div( prevView.w ) ).toVar();
				const normalOk = dot( N, prevN ).greaterThanEqual( float( NORMAL_THRESHOLD ) );
				const depthDelta = abs( curViewZ.sub( prevViewZ ) ).div( max( curViewZ, float( 0.001 ) ) );
				const depthOk = depthDelta.lessThanEqual( float( DEPTH_REL_THRESHOLD ) );
				const reuse = inBounds.and( normalOk ).and( depthOk );

				If( reuse, () => {

					const prevParity = curParity.bitXor( int( 1 ) ).toVar();
					const baseIdxPrev = reservoirSlotIndexGI( gxPrev, gyPrev, resW, prevParity ).toVar();
					const shifted = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdxPrev ) ).toVar();

					// M>0 (confidence), regardless of valid — null-sample history folds correctly
					If( shifted.M.greaterThan( float( 0.0 ) ), () => {

						const maxM = canonical.M.mul( float( GI_TEMPORAL_M_CAP_MULTIPLIER ) ).toVar();
						const shiftedCapped = GIReservoir.wrap( giReservoirCapM( shifted, maxM ) ).toVar();

						// PT-2b motion-correct temporal: the history arm's own domain is the TRUE previous-
						// frame jittered x0 — its W was normalized against p̂ there; the old x0-collapse fed
						// the combine p̂(x0_cur) instead (the measured −0.8pp carrier on close-emitter scenes,
						// quadratic in the pdfs). x0_prev from the ping-ponged primaryHit; N_prev from the
						// history normalDepth the gate already decoded; V_prev from the CURRENT camera
						// (prev-camera uniform is a documented refinement — exact for the static-camera
						// validation regime; f's V-sensitivity is second-order vs the geometric pdf terms).
						const prevPixelIdx = gyPrev.mul( resW ).add( gxPrev ).toVar();
						const Pprev = primaryHitBuffer.element( giPrimaryHitIndex( prevPixelIdx, prevParity ) ).xyz.toVar();
						const Nprev = normalize( prevN ).toVar();
						const Vprev = normalize( camPos.sub( Pprev ) ).toVar();
						const x0curOff = P.add( N.mul( 0.001 ) ).toVar();
						const x0prevOff = Pprev.add( Nprev.mul( 0.001 ) ).toVar();

						// four cross-targets at their TRUE domains + the real reconnection Jacobians
						// (canonical mapped cur→prev for denomC; history mapped prev→cur for denomS + wS).
						// PT-3b: a nonReusable sample (the x1-anchored glossy fallback) is an always-fail
						// shift: its FOREIGN-domain targets ≡ 0 in the w-arm AND the denominators (target-0
						// here at the call site; fold-skipping would be realization-dependent).
						// PT-3c-2 k-branch: k≤1 keeps the f·cos·evalLo formula UNCHANGED; k>1 replays the
						// prefix at the given domain through the shared target Fn — computed LIVE, ONCE per
						// domain (the same result feeds the w-arm and the denominators). The k>1 Jacobian
						// endpoints are the replays' terminal vertices x'_{k−1} (the reconnection edge moved
						// to x_k); k≤1 arms keep the x0-offset endpoints. Replay failure ⇒ target 0 ⇒ the
						// combine drops that arm (a garbage endpoint is always paired with a 0 target).
						// PT-3c-2 k>1 TEMPORAL arms are a SAME-DOMAIN merge (the disocclusion gate asserts
						// same world surface): ONE replay at the CURRENT exact domain per arm; the history
						// arm's own-domain target = STORED pHatOwn (the exact value W was normalized
						// against — Eq. 8 pairing; capM preserves it); Jacobian endpoints stay at the x0
						// offsets (≈1 static, the k≤1-smooth class under motion). Replaying at Q′ from the
						// QUANTIZED Nprev + current-frame material diverges from the sample's true own-domain
						// replay — through a glossy prefix that is a CONSTANT Jacobian asymmetry, and any
						// jacS > cS/(cS−cC) makes the temporal multiplier wSum·jacS·cS/(cS+cC·jacS) exceed
						// 1 ⇒ exponential wSum blow-up (the mb4 reuse ×10³ explosion). With the pairing +
						// J=1 endpoints, wS ≤ wSum_s·cS/cC and the fixed-point multiplier is 20/21 — stable.
						const canonK1 = canonical.kPrefix.lessThanEqual( float( 1.0 ) );
						const shiftK1 = shiftedCapped.kPrefix.lessThanEqual( float( 1.0 ) );
						const pHatCanonAtQ = float( 0.0 ).toVar();
						const xPrevCanonQ = x0curOff.toVar();
						const pHatCanonAtQprime = float( 0.0 ).toVar();
						const xPrevCanonQp = x0prevOff.toVar();
						If( canonK1, () => {

							pHatCanonAtQ.assign( giPHatAt( canonical, P, N, V ) );
							If( giIsReusable( canonical ), () => {

								pHatCanonAtQprime.assign( giPHatAt( canonical, Pprev, Nprev, Vprev ) );

							} );

						} ).Else( () => {

							const tQ = GIReplayTargetResult.wrap( replayTarget( canonical, P, N, V, material ) ).toVar();
							pHatCanonAtQ.assign( tQ.pHat );
							If( giIsReusable( canonical ), () => {

								pHatCanonAtQprime.assign( tQ.pHat );

							} );

						} );
						const pHatShiftAtQprime = float( 0.0 ).toVar();
						const xPrevShiftQp = x0prevOff.toVar();
						const pHatShiftAtQ = float( 0.0 ).toVar();
						const xPrevShiftQ = x0curOff.toVar();
						If( shiftK1, () => {

							pHatShiftAtQprime.assign( giPHatAt( shiftedCapped, Pprev, Nprev, Vprev ) );
							If( giIsReusable( shiftedCapped ), () => {

								pHatShiftAtQ.assign( giPHatAt( shiftedCapped, P, N, V ) );

							} );

						} ).Else( () => {

							If( giIsReusable( shiftedCapped ), () => {

								const tQ = GIReplayTargetResult.wrap( replayTarget( shiftedCapped, P, N, V, material ) ).toVar();
								pHatShiftAtQ.assign( tQ.pHat );
								If( tQ.pHat.greaterThan( 0.0 ), () => {

									pHatShiftAtQprime.assign( shiftedCapped.pHatOwn );

								} );

							} );

						} );
						const jacC = giReconnectionJacobian( giX1( canonical ), giN1( canonical ), xPrevCanonQp, xPrevCanonQ ).toVar();
						const jacS = giReconnectionJacobian( giX1( shiftedCapped ), giN1( shiftedCapped ), xPrevShiftQ, xPrevShiftQp ).toVar();

						const merged = GIReservoir.wrap( reservoirCombineGIShifted(
							canonical, shiftedCapped,
							pHatCanonAtQ, pHatCanonAtQprime, pHatShiftAtQ, pHatShiftAtQprime,
							jacC, jacS, RandomValue( rngState ),
						) ).toVar();

						writeGIReservoir( giReservoirPoolRW, baseIdxOut, merged );

					} );

				} );

			} );

			rngBufferRW.element( rayID ).assign( rngState );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_GI_TEMPORAL_WG_SIZE };
