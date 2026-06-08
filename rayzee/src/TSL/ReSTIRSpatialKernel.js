/**
 * ReSTIRSpatialKernel.js — Phase-1 ReSTIR DI SPATIAL reuse (per-pixel 16×16, 2D screen dispatch).
 *
 * Runs AFTER restirTemporal (which wrote its result to the SNAPSHOT slot S) and BEFORE restirResolve.
 * For each pixel: reads its own post-temporal reservoir from S, gathers K screen-space neighbors (also from
 * S — a stable, read-only snapshot, so the gather is race-free), and folds each valid neighbor in via the
 * UNBIASED cross-evaluated GRIS pairwise combine (reservoirCombineSpatialUnbiased — NOT the collapsed temporal
 * combine: the neighbor's own domain q′ has a different target function, so the MIS denominator must be fully
 * cross-evaluated). Writes the FINAL combined reservoir to the cur slot[P]; restirResolve reads it and does
 * the single shadow test + f·NoL·Le·V·W. Always runs (K=0 ⇒ S copied verbatim to cur = temporal-only).
 *
 * UNBIASEDNESS hinges on two things (the workflow's adversarial verdicts + measured validation, K3 converges
 * to brute-force within ~0.1%): (1) the cross-evaluated combine (each reservoir's OWN-domain target in the MIS
 * denominator); (2) recomputing all FOUR p̂ targets FRESH each fold from stored world points — NEVER a
 * reservoir's carried pHatOwn (a producing-pixel value). The neighbor's full surface (P, N, V, material) is
 * reconstructed from the HIT buffer (normal+matIndex) + primaryHit (world P). Visibility is NOT tested here
 * (p̂ unshadowed everywhere; resolve applies V once to the single survivor — same as BF NEE, no double-count).
 * AREA-light samples are gated OUT of reuse (delta-light shift Jacobian = 1; area's ≠ 1 needs the deferred
 * area-measure handling) — point/spot/directional only.
 *
 * (An earlier visibility-based "occlusion-boundary mask" was tried and REMOVED: the −1.6% bias it targeted was
 * actually the resolve shadow-ray offset, not occlusion — see project_restir_shadow_offset_bias. Gating
 * neighbors on V_q conditions the kept samples on visibility without correcting their UCW → over-bright +28%.)
 *
 * Runtime knobs (uniforms, no recompile): restirSpatialK ∈ [0, SPATIAL_K_MAX] folds (0 = passthrough),
 * restirSpatialRadius (px). The owning stage drives restirSpatialK per-frame (frame-count gate: spatial reuse
 * helps only while reservoirs are under-converged — low spp; its inter-pixel correlation raises per-pixel RMSE
 * once converged, so it is turned off past the first few accumulated frames).
 *
 * Storage buffers (≤10, per-pass): reservoirPoolRW, hitBufferRO, materialBuffer, primaryHitBuffer,
 * rngBufferRW = 5 SB. Light buffers are UNIFORM (0 SB); material-map arrays are textures (0 SB). The reservoir
 * pool is bound ONLY as the rw node — reads of slot S + neighbors' slot S and the write to cur slot[P] are
 * disjoint elements (S = slot 2, cur = slot 0/1), so there is no rw+ro alias and no intra-pass write/read hazard.
 */

import {
	Fn, float, vec3, vec4, int, uint,
	If, Return, normalize, max, dot, abs, cos, sin, sqrt, round,
	localId, workgroupId,
} from 'three/tsl';

import {
	readHitDistance, readHitNormal, readHitMaterialIndex, readHitBarycentrics,
} from '../Processor/PackedRayBuffer.js';
import { RandomValue } from './Random.js';
import { getMaterial, luminance, computeDotProducts } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { deriveAnalyticLe } from './ReSTIRLighting.js';
import { RayTracingMaterial, MaterialSamples, DotProducts } from './Struct.js';
import {
	Reservoir, unpackReservoir, reservoirCapM, reservoirCombineSpatialUnbiased,
	reservoirSlotIndex, packReservoirCore, packReservoirAux,
	decodeLightSampleId, RESTIR_LIGHT_TYPE_AREA, RESTIR_SPATIAL_M_CAP_MULTIPLIER,
	RESTIR_SNAPSHOT_SLOT, RESTIR_ID_NONE,
} from './ReSTIRCore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;
// Compile-time fold unroll bound. The runtime restirSpatialK uniform ∈ [0, SPATIAL_K_MAX] gates how many
// actually execute (folds 0..K-1 are identical across K values — RNG advances in lockstep). Re-tune K and the
// radius empirically (CUDA-era K wins routinely regress on WebGPU/Apple; equal-time benchmark, not fixed).
const SPATIAL_K_MAX = 3;
const NORMAL_THRESHOLD = 0.9;
const DEPTH_REL_THRESHOLD = 0.1;
const TWO_PI = 6.2831853;

export function buildRestirSpatialKernel( params ) {

	const {
		// Storage buffers (5 SB)
		hitBufferRO, rngBufferRW, materialBuffer, reservoirPoolRW, primaryHitBuffer,
		// Light buffers (uniform — 0 SB) for analytic Le re-eval
		directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
		// Material map texture arrays (0 SB)
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		// Camera (view dir from exact hit point + linear-view-Z depth gate). NO cameraProjectionMatrixInverse.
		cameraWorldMatrix, cameraViewMatrix,
		// Uniforms
		frameParityUniform, resolutionUniform,
		// Live-tunable spatial knobs (effective K is driven per-frame by the stage's frame-count gate)
		restirSpatialK, restirSpatialRadius,
	} = params;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			const resW = int( resolutionUniform.x ).toVar();
			const resH = int( resolutionUniform.y ).toVar();
			const pixelIndex = gy.mul( resW ).add( gx );
			const rayID = uint( pixelIndex );

			// My bounce-0 hit — misses carry no reservoir.
			const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
			If( hitDist.greaterThan( MISS_DIST ), () => {

				Return();

			} );

			const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
			const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
			const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

			// Exact bounce-0 hit point (restirCapture); V to the camera; my linear view-Z for the depth gate.
			const P = primaryHitBuffer.element( pixelIndex ).xyz.toVar();
			const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
			const V = normalize( camPos.sub( P ) ).toVar();
			const curViewZ = abs( cameraViewMatrix.mul( vec4( P, 1.0 ) ).z ).toVar();

			// Rebuild my material (same recipe as Initial/Temporal/Resolve) + two-sided N flip toward V.
			const material = RayTracingMaterial.wrap( getMaterial( int( hitMatIdx ), materialBuffer ) ).toVar();
			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
				albedoMaps, normalMaps, bumpMaps,
				metalnessMaps, roughnessMaps, emissiveMaps,
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

			// p̂ recipe — IDENTICAL to Initial/Temporal (true clamped cosine, deriveAnalyticLe, luminance).
			// Emits the subgraph inline; the running survivor + each neighbor are evaluated under BOTH domains.
			const pHat = ( point, atP, atN, atV, atMat, lightId ) => {

				const wi = normalize( point.sub( atP ) );
				const cosT = max( dot( atN, wi ), float( 0.0 ) );
				const dots = DotProducts.wrap( computeDotProducts( atN, atV, wi ) );
				const f = evaluateMaterialResponseFromDots( atMat, dots );
				const Le = deriveAnalyticLe(
					lightId, point, atP,
					directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
				);
				return luminance( { color: f.mul( cosT ).mul( Le ) } );

			};

			// Canonical = my post-temporal reservoir from the SNAPSHOT slot S.
			const baseIdxSelfS = reservoirSlotIndex( gx, gy, resW, int( RESTIR_SNAPSHOT_SLOT ) ).toVar();
			const canon = Reservoir.wrap( unpackReservoir(
				reservoirPoolRW.element( baseIdxSelfS ),
				reservoirPoolRW.element( baseIdxSelfS.add( int( 1 ) ) ),
			) ).toVar();

			// Running survivor as scalar .toVar()s (no whole-struct .assign in TSL), seeded from canonical.
			const outId = canon.lightSampleId.toVar();
			const outWSum = canon.wSum.toVar();
			const outW = canon.W.toVar();
			const outM = canon.M.toVar();
			const outX = canon.samplePosX.toVar();
			const outY = canon.samplePosY.toVar();
			const outZ = canon.samplePosZ.toVar();
			const outPHatOwn = canon.pHatOwn.toVar();
			const packRunning = () => Reservoir( {
				lightSampleId: outId, wSum: outWSum, W: outW, M: outM,
				samplePosX: outX, samplePosY: outY, samplePosZ: outZ, pHatOwn: outPHatOwn,
			} );

			const rngState = rngBufferRW.element( rayID ).toVar();

			// ── Gather up to SPATIAL_K_MAX neighbors (compile-time unrolled; runtime restirSpatialK gates). ──
			for ( let k = 0; k < SPATIAL_K_MAX; k ++ ) {

				If( int( k ).lessThan( restirSpatialK ), () => {

					// Uniform disk sample → integer neighbor offset.
					const r = restirSpatialRadius.mul( sqrt( RandomValue( rngState ) ) ).toVar();
					const theta = RandomValue( rngState ).mul( float( TWO_PI ) ).toVar();
					const nx = gx.add( int( round( r.mul( cos( theta ) ) ) ) ).clamp( int( 0 ), resW.sub( int( 1 ) ) ).toVar();
					const ny = gy.add( int( round( r.mul( sin( theta ) ) ) ) ).clamp( int( 0 ), resH.sub( int( 1 ) ) ).toVar();

					// Skip self (rounded offset 0,0) — avoids confidence double-count. All neighbor reads are INSIDE
					// the guards so a stale/garbage neighbor P never poisons a select-bool with NaN.
					If( nx.equal( gx ).and( ny.equal( gy ) ).not(), () => {

						const nIdx = ny.mul( resW ).add( nx ).toVar();
						const nRayID = uint( nIdx );

						const nHitDist = readHitDistance( hitBufferRO, nRayID ).toVar();
						const baseIdxNS = reservoirSlotIndex( nx, ny, resW, int( RESTIR_SNAPSHOT_SLOT ) ).toVar();
						const nRes = Reservoir.wrap( unpackReservoir(
							reservoirPoolRW.element( baseIdxNS ),
							reservoirPoolRW.element( baseIdxNS.add( int( 1 ) ) ),
						) ).toVar();
						const nNotArea = decodeLightSampleId( nRes.lightSampleId ).x.notEqual( float( RESTIR_LIGHT_TYPE_AREA ) );
						// neighborHit (background reject) + non-empty (M>0 rejects zeroed/cold S) + delta-only.
						const reuse = nHitDist.lessThanEqual( MISS_DIST )
							.and( nRes.lightSampleId.notEqual( float( RESTIR_ID_NONE ) ) )
							.and( nRes.M.greaterThan( float( 0.0 ) ) )
							.and( nNotArea ).toVar();

						If( reuse, () => {

							// Reconstruct the neighbor's surface for its own-domain target + the disocclusion gate.
							const Pn = primaryHitBuffer.element( nIdx ).xyz.toVar();
							const Vn = normalize( camPos.sub( Pn ) ).toVar();
							const nViewZ = abs( cameraViewMatrix.mul( vec4( Pn, 1.0 ) ).z ).toVar();
							const depthOk = abs( curViewZ.sub( nViewZ ) ).div( max( curViewZ, float( 0.001 ) ) ).lessThanEqual( float( DEPTH_REL_THRESHOLD ) );

							const nHitN = readHitNormal( hitBufferRO, nRayID ).toVar();
							const nUV = readHitBarycentrics( hitBufferRO, nRayID ).toVar();
							const nMatIdx = readHitMaterialIndex( hitBufferRO, nRayID ).toVar();
							const matN = RayTracingMaterial.wrap( getMaterial( int( nMatIdx ), materialBuffer ) ).toVar();
							const msN = MaterialSamples.wrap( sampleAllMaterialTextures(
								albedoMaps, normalMaps, bumpMaps,
								metalnessMaps, roughnessMaps, emissiveMaps,
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

								// M-cap the neighbor vs the RUNNING survivor's M (bounds spatial correlation).
								const maxM = outM.mul( float( RESTIR_SPATIAL_M_CAP_MULTIPLIER ) ).toVar();
								const nCapped = Reservoir.wrap( reservoirCapM( nRes, maxM ) ).toVar();

								// FOUR cross-target evaluations (fresh — never pHatOwn). yC = running survivor's point.
								const yN = vec3( nCapped.samplePosX, nCapped.samplePosY, nCapped.samplePosZ ).toVar();
								const yC = vec3( outX, outY, outZ ).toVar();
								const pHatNeighAtQ = pHat( yN, P, N, V, material, nCapped.lightSampleId ).toVar();
								const pHatNeighAtQprime = pHat( yN, Pn, Nn, Vn, matN, nCapped.lightSampleId ).toVar();
								const pHatCanonAtQ = pHat( yC, P, N, V, material, outId ).toVar();
								const pHatCanonAtQprime = pHat( yC, Pn, Nn, Vn, matN, outId ).toVar();

								const merged = Reservoir.wrap( reservoirCombineSpatialUnbiased(
									packRunning(), nCapped,
									pHatCanonAtQ, pHatCanonAtQprime, pHatNeighAtQ, pHatNeighAtQprime, rngState,
								) ).toVar();

								outId.assign( merged.lightSampleId );
								outWSum.assign( merged.wSum );
								outW.assign( merged.W );
								outM.assign( merged.M );
								outX.assign( merged.samplePosX );
								outY.assign( merged.samplePosY );
								outZ.assign( merged.samplePosZ );
								outPHatOwn.assign( merged.pHatOwn );

							} );

						} );

					} );

				} );

			}

			// Write FINAL to the cur slot[P] (resolve reads it; next frame's temporal reads it as prev).
			const result = packRunning().toVar();
			const baseIdxCur = reservoirSlotIndex( gx, gy, resW, frameParityUniform ).toVar();
			reservoirPoolRW.element( baseIdxCur ).assign( packReservoirCore( result ) );
			reservoirPoolRW.element( baseIdxCur.add( int( 1 ) ) ).assign( packReservoirAux( result ) );

			rngBufferRW.element( rayID ).assign( rngState );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_SPATIAL_WG_SIZE };
