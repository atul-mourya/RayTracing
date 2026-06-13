/**
 * ReSTIRGISpatialKernel.js — ReSTIR GI/PT SPATIAL reuse (per-pixel 16×16, 2D screen dispatch).
 *
 * Specs: restir-gi-phase02.md §4.2/§5 + restir-pt-phase03.md §PT-2. Runs AFTER gi-temporal (snapshot
 * slot S) and BEFORE gi-resolve. K-neighbor disk gather from S, cross-evaluated GRIS combine WITH the
 * per-arm reconnection Jacobians. PT-2: all four cross-targets evaluate through the SHARED domain
 * evaluator (ReSTIRGIEval) at their respective domains — the d=1 emissive/env MIS weights and f_{x1}
 * are re-derived at EACH prefix (this is where the spatial −0.5pp frozen-weight bias died).
 *
 * PT-3c-2: k-branched cross-targets — k≤1 keeps the PT-2 f·cos·evalLo formula bit-identical; k>1
 * targets replay the prefix at the given domain through the SHARED target evaluator (the same Fn
 * gi-initial's p̂ uses — Eq. 8 requires one target function), computed LIVE (no prefixPHatCache yet).
 * k>1 Jacobian endpoints are the two replays' terminal vertices x'_{k−1}, not the x0 offsets.
 *
 * Storage buffers (≤10): giReservoirRW, hit, mat, primaryHit, rng, triangleBuffer, bvh (PT-3c-2
 * replay) = 7 SB. Running-canonical accumulation goes through the CUR slot (write → re-read per fold;
 * same-invocation program-ordered) — replaces the scalar mirror vars.
 */

import {
	Fn, float, vec4, int, uint,
	If, Loop, Return, normalize, max, dot, abs, cos, sin, sqrt, round,
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
	GI_SNAPSHOT_SLOT, GI_SPATIAL_M_CAP_MULTIPLIER,
} from './ReSTIRGICore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;
const SPATIAL_K_MAX = 3;
const NORMAL_THRESHOLD = 0.9;
const DEPTH_REL_THRESHOLD = 0.1;
const TWO_PI = 6.2831853;

export function buildRestirGISpatialKernel( params ) {

	const {
		hitBufferRO, rngBufferRW, materialBuffer, triangleBuffer, bvhBuffer,
		giReservoirPoolRW, primaryHitBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		emissiveTotalPower,
		cameraWorldMatrix, cameraViewMatrix,
		frameParityUniform, resolutionUniform,
		restirGISpatialK, restirGISpatialRadius,
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

			// seed the running accumulator: my post-temporal reservoir S → cur
			const baseIdxSelfS = reservoirSlotIndexGI( gx, gy, resW, int( GI_SNAPSHOT_SLOT ) ).toVar();
			const baseIdxCur = reservoirSlotIndexGI( gx, gy, resW, frameParityUniform ).toVar();
			const selfS = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdxSelfS ) ).toVar();
			writeGIReservoir( giReservoirPoolRW, baseIdxCur, selfS );

			const rngState = rngBufferRW.element( rayID ).toVar();

			// M>0 = participating pixel; null canonical still folds neighbors (M-gating, not valid)
			If( selfS.M.greaterThan( float( 0.0 ) ), () => {

				const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
				const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
				const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

				const P = primaryHitBuffer.element( giPrimaryHitIndex( pixelIndex, frameParityUniform ) ).xyz.toVar();
				const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
				const V = normalize( camPos.sub( P ) ).toVar();
				const curViewZ = abs( cameraViewMatrix.mul( vec4( P, 1.0 ) ).z ).toVar();

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
				const x0self = P.add( N.mul( 0.001 ) ).toVar();

				// p̂ of a stored sample at a given DOMAIN surface — PT-2: the payload goes through evalLo
				// (per-domain MIS re-derivation + f1 re-eval), the x0-side f·cos through the domain's dots.
				const giPHat = ( r, atP, atN, atV, atMat ) => {

					const org = atP.add( atN.mul( 0.001 ) );
					const wi = normalize( giX1( r ).sub( org ) );
					const cosT = max( dot( atN, wi ), float( 0.0 ) );
					const dots = DotProducts.wrap( computeDotProducts( atN, atV, wi ) );
					const f = evaluateMaterialResponseFromDots( atMat, dots );
					return luminance( { color: f.mul( cosT ).mul( evalLo( r, atP, atN, atV, atMat, int( 0 ) ) ) } );

				};

				// RUNTIME Loop, not a JS unroll: the fold body carries 4 replayTarget call sites (PT-3c-2);
				// stamping it K_MAX× makes Metal's inliner explode (~60s pipeline compile → GPU-process
				// watchdog kills the device). One emission + the If keeps semantics and RNG order identical.
				Loop( { start: int( 0 ), end: int( SPATIAL_K_MAX ), type: 'int', condition: '<' }, ( { i } ) => {

					If( i.lessThan( restirGISpatialK ), () => {

						const r = restirGISpatialRadius.mul( sqrt( RandomValue( rngState ) ) ).toVar();
						const theta = RandomValue( rngState ).mul( float( TWO_PI ) ).toVar();
						const nx = gx.add( int( round( r.mul( cos( theta ) ) ) ) ).clamp( int( 0 ), resW.sub( int( 1 ) ) ).toVar();
						const ny = gy.add( int( round( r.mul( sin( theta ) ) ) ) ).clamp( int( 0 ), resH.sub( int( 1 ) ) ).toVar();

						If( nx.equal( gx ).and( ny.equal( gy ) ).not(), () => {

							const nIdx = ny.mul( resW ).add( nx ).toVar();
							const nRayID = uint( nIdx );
							const nHitDist = readHitDistance( hitBufferRO, nRayID ).toVar();
							const baseIdxNS = reservoirSlotIndexGI( nx, ny, resW, int( GI_SNAPSHOT_SLOT ) ).toVar();
							const nRes = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdxNS ) ).toVar();
							// M>0 (participating), regardless of valid — null-sample neighbors fold correctly
							const reuse = nHitDist.lessThanEqual( MISS_DIST )
								.and( nRes.M.greaterThan( float( 0.0 ) ) ).toVar();

							If( reuse, () => {

								// reconstruct the neighbor's surface (own-domain target + gates + Jacobian)
								const Pn = primaryHitBuffer.element( giPrimaryHitIndex( nIdx, frameParityUniform ) ).xyz.toVar();
								const Vn = normalize( camPos.sub( Pn ) ).toVar();
								const nViewZ = abs( cameraViewMatrix.mul( vec4( Pn, 1.0 ) ).z ).toVar();
								const depthOk = abs( curViewZ.sub( nViewZ ) ).div( max( curViewZ, float( 0.001 ) ) ).lessThanEqual( float( DEPTH_REL_THRESHOLD ) );

								const nHitN = readHitNormal( hitBufferRO, nRayID ).toVar();
								const nUV = readHitBarycentrics( hitBufferRO, nRayID ).toVar();
								const nMatIdx = readHitMaterialIndex( hitBufferRO, nRayID ).toVar();
								const matN = RayTracingMaterial.wrap( getMaterial( int( nMatIdx ), materialBuffer ) ).toVar();
								const msN = MaterialSamples.wrap( sampleAllMaterialTextures(
									albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
									matN, nUV, normalize( nHitN ),
								) ).toVar();
								matN.color.assign( msN.albedo );
								matN.metalness.assign( msN.metalness.clamp( 0.0, 1.0 ) );
								matN.roughness.assign( msN.roughness.clamp( 0.05, 1.0 ) );
								matN.sheenRoughness.assign( matN.sheenRoughness.clamp( 0.05, 1.0 ) );
								const Nn = msN.normal.toVar();
								If( dot( Nn, Vn ).lessThan( 0.0 ), () => {

									Nn.assign( Nn.negate() );

								} );
								const normalOk = dot( N, Nn ).greaterThanEqual( float( NORMAL_THRESHOLD ) );

								If( depthOk.and( normalOk ), () => {

									const run = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdxCur ) ).toVar();
									const maxM = run.M.mul( float( GI_SPATIAL_M_CAP_MULTIPLIER ) ).toVar();
									const nCapped = GIReservoir.wrap( giReservoirCapM( nRes, maxM ) ).toVar();

									const x0neigh = Pn.add( Nn.mul( 0.001 ) ).toVar();

									// four FRESH cross-targets through the shared evaluator. PT-3b: a nonReusable
									// arm (the x1-anchored glossy fallback) is an always-fail shift — its
									// FOREIGN-domain targets ≡ 0 in the w-arm AND the denominators (target-0 at
									// the call site).
									// PT-3c-2 k-branch: k≤1 keeps the f·cos·evalLo formula UNCHANGED; k>1
									// replays the prefix at the given domain through the shared target Fn —
									// computed LIVE, ONCE per domain (the same result feeds the w-arm and the
									// denominators). k>1 Jacobian endpoints = the replays' terminal vertices
									// x'_{k−1}; k≤1 arms keep the x0-offset endpoints. Replay failure ⇒ target
									// 0 ⇒ the combine drops that arm (garbage endpoints pair with 0 targets).
									const runK1 = run.kPrefix.lessThanEqual( float( 1.0 ) );
									const neighK1 = nCapped.kPrefix.lessThanEqual( float( 1.0 ) );
									const pHatCanonAtQ = float( 0.0 ).toVar();
									const xPrevCanonQ = x0self.toVar();
									const pHatCanonAtQprime = float( 0.0 ).toVar();
									const xPrevCanonQp = x0neigh.toVar();
									If( runK1, () => {

										pHatCanonAtQ.assign( giPHat( run, P, N, V, material ) );
										If( giIsReusable( run ), () => {

											pHatCanonAtQprime.assign( giPHat( run, Pn, Nn, Vn, matN ) );

										} );

									} ).Else( () => {

										const tQ = GIReplayTargetResult.wrap( replayTarget( run, P, N, V, material ) ).toVar();
										pHatCanonAtQ.assign( tQ.pHat );
										xPrevCanonQ.assign( tQ.xPrev );
										If( giIsReusable( run ), () => {

											const tQp = GIReplayTargetResult.wrap( replayTarget( run, Pn, Nn, Vn, matN ) ).toVar();
											pHatCanonAtQprime.assign( tQp.pHat );
											xPrevCanonQp.assign( tQp.xPrev );

										} );

									} );
									const pHatNeighAtQprime = float( 0.0 ).toVar();
									const xPrevNeighQp = x0neigh.toVar();
									const pHatNeighAtQ = float( 0.0 ).toVar();
									const xPrevNeighQ = x0self.toVar();
									If( neighK1, () => {

										pHatNeighAtQprime.assign( giPHat( nCapped, Pn, Nn, Vn, matN ) );
										If( giIsReusable( nCapped ), () => {

											pHatNeighAtQ.assign( giPHat( nCapped, P, N, V, material ) );

										} );

									} ).Else( () => {

										const tQp = GIReplayTargetResult.wrap( replayTarget( nCapped, Pn, Nn, Vn, matN ) ).toVar();
										pHatNeighAtQprime.assign( tQp.pHat );
										xPrevNeighQp.assign( tQp.xPrev );
										If( giIsReusable( nCapped ), () => {

											const tQ = GIReplayTargetResult.wrap( replayTarget( nCapped, P, N, V, material ) ).toVar();
											pHatNeighAtQ.assign( tQ.pHat );
											xPrevNeighQ.assign( tQ.xPrev );

										} );

									} );
									// per-cross-term reconnection Jacobians: canon mapped q→q′, neighbor q′→q
									const jacC = giReconnectionJacobian( giX1( run ), giN1( run ), xPrevCanonQp, xPrevCanonQ ).toVar();
									const jacS = giReconnectionJacobian( giX1( nCapped ), giN1( nCapped ), xPrevNeighQ, xPrevNeighQp ).toVar();

									const merged = GIReservoir.wrap( reservoirCombineGIShifted(
										run, nCapped,
										pHatCanonAtQ, pHatCanonAtQprime, pHatNeighAtQ, pHatNeighAtQprime,
										jacC, jacS, RandomValue( rngState ),
									) ).toVar();

									writeGIReservoir( giReservoirPoolRW, baseIdxCur, merged );

								} );

							} );

						} );

					} );

				} );

			} );

			rngBufferRW.element( rayID ).assign( rngState );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_GI_SPATIAL_WG_SIZE };
