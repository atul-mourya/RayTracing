/**
 * ReSTIRGIReplay.js — PT-3c shared prefix replay for k>1 reservoirs (the hybrid shift).
 *
 * Spec: docs/specs/restir-pt-phase03.md §PT-3c. Re-runs the candidate's x0 scatter + prefix walk
 * x0→…→x'_{k−1} at a DOMAIN from the stored pre-xi0 seed: the chain VALUES are domain-independent
 * (gi-initial: seed→S1→S2 = the xi0 pair; walker stream = pcgHash(S2 ^ 0x517cc1b7), one xi pair per
 * opaque vertex; interior helper draws are frozen Fn-param reads — never advance the chain), so the
 * replay reproduces the EXACT randoms; domain differences enter only through geometry/material.
 *
 * Per replayed segment the PSS fold f·cos/p^domain (f via evaluateMaterialResponse, cos/p via the
 * realized throughputNoF = cosineWeight/combinedPdf — strategy-correct |cos| for transmission-lobe
 * draws) goes into prefixFactor; the reconnection edge x'_{k−1}→x_k contributes f·cos in SOLID
 * ANGLE (no /p — the RIS denominator carries the source's p_{k−1}). NO NEE, NO RR (the walker
 * disables both pre-anchor). Stratum preservation: reconnectability satisfied at any replayed pair
 * ⇒ invalid (the Eq. 11 partition); terminate-class interactions (miss, transmissive/SSS continue)
 * ⇒ invalid. 3c-2 walker-divergence closures: a ROUGH domain x0 (roughness ≥ τ) is out-of-stratum
 * for ANY k>1 sample (the walker anchors rough x0 at x1 ALWAYS) ⇒ invalid before any work; alpha
 * skips mirror the walker's EXACT pre-x1 gate (continue only when MASK + alphaShadows, throughput
 * untouched — anything the walker terminated leaves the generation support ⇒ invalid; post-x1
 * skips fold the interaction throughput).
 *
 * Used by gi-initial (own-domain canonical p̂), the resolve, and — via makeGIReplayTarget, the
 * shared k>1 target evaluator — the temporal/spatial cross-targets (Eq. 8: one target function).
 */

import {
	Fn, float, vec2, vec3, int, uint,
	If, Loop, normalize, max, dot, length,
} from 'three/tsl';

import { struct } from './patches.js';
import { pcgHash, RandomValue } from './Random.js';
import { getMaterial, luminance, classifyMaterial } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { traverseBVH } from './BVHTraversal.js';
import { handleMaterialTransparency, MaterialInteractionResult } from './MaterialTransmission.js';
import { calculateIndirectLighting } from './LightsIndirect.js';
import { IndirectLightingResult } from './LightsCore.js';
import { generateSampledDirection } from './PathTracerCore.js';
import { getImportanceSamplingInfo } from './MaterialProperties.js';
import { sampleClearcoat, ClearcoatResult } from './Clearcoat.js';
import {
	Ray, HitInfo, RayTracingMaterial, MaterialSamples, DirectionSample,
	ImportanceSamplingInfo, MaterialClassification, BRDFWeights, MaterialCache,
} from './Struct.js';
import { RESTIR_PT_TAU1, RESTIR_PT_DMIN } from './ReSTIRPTWalk.js';
import { giX1, giN1 } from './ReSTIRGICore.js';

export const GIReplayResult = struct( {
	valid: 'float', // 1 = shift valid; 0 = invalid (target-0 at the call site)
	prefixFactor: 'vec3', // Π f_j·cos_j/p_j (segments 0..k−2, PSS) · f_{k−1}·cos_{k−1} (solid angle)
	xPrev: 'vec3', // x'_{k−1} — the replayed reconnection-edge origin
	nPrev: 'vec3', // flipped shading normal at x'_{k−1} (evalLo's domain normal)
	vPrev: 'vec3', // incidence at x'_{k−1} (negated incoming replayed direction)
	nGeoPrev: 'vec3', // UNFLIPPED interpolated normal (the texture-rebuild basis for matPrev)
	matIdxPrev: 'float', // x'_{k−1} material index (callers rebuild matPrev from these handles)
	uvPrev: 'vec2', // x'_{k−1} texture uv
} );

/**
 * Build the replay Fn (closure over scene buffers/uniforms — kernel-builder pattern).
 * Returned Fn: ( r [GIReservoir], P0, N0, V0, mat0 ) → GIReplayResult (callers .wrap()).
 * P0/N0/V0/mat0 = the DOMAIN's primary hit (same contract as evalLo). Never called for k ≤ 1.
 */
export function makeGIPrefixReplay( params ) {

	const {
		bvhBuffer, triangleBuffer, materialBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		restirGIRoughnessTau, enableAlphaShadows,
	} = params;

	return Fn( ( [ r, P0, N0, V0, mat0 ] ) => {

		const resValid = float( 0.0 ).toVar();
		const resPrefixFactor = vec3( 0.0 ).toVar();
		const resXPrev = vec3( 0.0 ).toVar();
		const resNPrev = vec3( 0.0, 0.0, 1.0 ).toVar();
		const resVPrev = vec3( 0.0, 0.0, 1.0 ).toVar();
		const resNGeoPrev = vec3( 0.0, 0.0, 1.0 ).toVar();
		const resMatIdxPrev = float( 0.0 ).toVar();
		const resUvPrev = vec2( 0.0 ).toVar();

		// 3c-2a rough-destination invalidation: the walker's k-selection anchors rough x0 at x1
		// ALWAYS (the k≡1 stratum), so a k>1 sample shifted INTO a rough-x0 domain is
		// out-of-stratum ⇒ invalid immediately (this Fn is only called for k>1).
		If( mat0.roughness.lessThan( restirGIRoughnessTau ), () => {

			const emptyWeights = BRDFWeights( {
				specular: float( 0.0 ), diffuse: float( 0.0 ), sheen: float( 0.0 ),
				clearcoat: float( 0.0 ), transmission: float( 0.0 ), iridescence: float( 0.0 ),
			} );
			const emptyCache = MaterialCache( {
				F0: vec3( 0.04 ), NoV: float( 1.0 ), diffuseColor: vec3( 0.0 ), isPurelyDiffuse: false,
				alpha: float( 0.0 ), k: float( 0.0 ), alpha2: float( 0.0 ),
				invRoughness: float( 0.5 ), metalFactor: float( 0.5 ), iorFactor: float( 0.67 ), maxSheenColor: float( 0.0 ),
			} );

			// reassemble the pre-xi0 seed integrally (float arithmetic is inexact) and re-derive
			// gi-initial's exact chain: S1, S2 = the xi0 pair (RandomValue's exact mapping).
			const seed = uint( r.seedHi ).shiftLeft( uint( 16 ) ).bitOr( uint( r.seedLo ) ).toVar();
			const s1 = pcgHash( { state: seed } ).toVar();
			const s2 = pcgHash( { state: s1 } ).toVar();
			const xi0 = vec2(
				float( s1.shiftRight( 8 ) ).mul( 1.0 / 16777216.0 ),
				float( s2.shiftRight( 8 ) ).mul( 1.0 / 16777216.0 ),
			).toVar();
			// the chain var the x0-sample helpers receive (frozen-param reads — value S2, as in gi-initial)
			const chain = s2.toVar();

			// re-run the x0 sample exactly as gi-initial does (clearcoat-or-gsd + calculateIndirectLighting;
			// sampleClearcoat reads only ray.direction + hit.normal — the reconstruction is exact)
			const mc0 = MaterialClassification.wrap( classifyMaterial(
				mat0.metalness, mat0.roughness, mat0.transmission,
				mat0.clearcoat, mat0.emissive, mat0.subsurface,
			) ).toVar();
			const bs0Dir = vec3( 0.0 ).toVar();
			const bs0Value = vec3( 0.0 ).toVar();
			const bs0Pdf = float( 0.0 ).toVar();
			If( mat0.clearcoat.greaterThan( 0.0 ), () => {

				const ccRay = Ray( { origin: P0.sub( V0 ), direction: V0.negate() } );
				const ccHit = HitInfo( {
					didHit: true, dst: float( 1.0 ), hitPoint: P0, normal: N0, uv: vec2( 0.0 ),
					materialIndex: int( 0 ), meshIndex: int( 0 ),
					triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
				} );
				const ccResult = ClearcoatResult.wrap( sampleClearcoat(
					ccRay, ccHit, mat0, xi0, chain,
				) );
				bs0Dir.assign( ccResult.L );
				bs0Value.assign( ccResult.brdf );
				bs0Pdf.assign( ccResult.pdf );

			} ).Else( () => {

				const bs0 = DirectionSample.wrap( generateSampledDirection(
					V0, N0, mat0, xi0, chain, mc0, false, emptyWeights, false, emptyCache,
				) );
				bs0Dir.assign( bs0.direction );
				bs0Value.assign( bs0.value );
				bs0Pdf.assign( bs0.pdf );

			} );

			const si0 = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo( mat0, int( 0 ), mc0 ) ).toVar();
			const ind0 = IndirectLightingResult.wrap( calculateIndirectLighting(
				V0, N0, mat0, bs0Dir, bs0Pdf, bs0Value, chain, si0,
			) ).toVar();
			const w0 = ind0.direction.toVar();
			const f0 = evaluateMaterialResponse( V0, w0, N0, mat0 ).toVar();
			const pdf0 = max( ind0.combinedPdf, float( 1e-8 ) ).toVar();
			const cos0 = max( dot( N0, w0 ), float( 0.0 ) ).toVar();

			// PSS fold of segment 0 (gi-initial's walkValid mirror gates the start)
			const prefixFactor = f0.mul( cos0 ).div( pdf0 ).toVar();

			// the walker stream — same constant as ReSTIRPTWalk.js
			const stream = pcgHash( { state: s2.bitXor( uint( 0x517cc1b7 ) ) } ).toVar();

			const rayOrigin = P0.add( N0.mul( 0.001 ) ).toVar();
			const rayDir = w0.toVar();
			const prevRough = mat0.roughness.toVar();
			const prevPos = rayOrigin.toVar();
			const kLast = int( r.kPrefix ).sub( int( 1 ) ).toVar();
			const vIdx = int( 0 ).toVar();
			const iter = int( 1 ).toVar();
			const maxIter = int( maxBounceCount ).add( int( transmissiveBounces ) ).add( int( maxSubsurfaceSteps ) ).toVar();
			const active = bs0Pdf.greaterThan( 0.0 ).and( cos0.greaterThan( 0.0 ) ).toVar();

			Loop( active.and( iter.lessThanEqual( maxIter ) ), () => {

				const ray = Ray( { origin: rayOrigin, direction: rayDir } );
				const hit = HitInfo.wrap( traverseBVH( ray, bvhBuffer, triangleBuffer ).toVar() );

				If( hit.didHit.not(), () => {

					active.assign( false ); // miss before x'_{k−1} ⇒ invalid

				} ).Else( () => {

					const hitPoint = hit.hitPoint.toVar();
					const nGeo = normalize( hit.normal ).toVar();

					// the walker's exact normal pipeline: textures with the UNFLIPPED interpolated normal
					// → N := matSamples.normal → transparency with that N → flip toward V
					const material = RayTracingMaterial.wrap( getMaterial( hit.materialIndex, materialBuffer ) ).toVar();
					const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
						albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
						material, hit.uv, nGeo,
					) ).toVar();
					material.color.assign( matSamples.albedo );
					material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
					material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );
					material.sheenRoughness.assign( material.sheenRoughness.clamp( 0.05, 1.0 ) );
					const N = matSamples.normal.toVar();

					const interaction = MaterialInteractionResult.wrap( handleMaterialTransparency(
						ray, N, material, stream,
						int( transmissiveBounces ),
						float( 1.0 ), float( 1.0 ),
						float( 0.0 ),
					) ).toVar();

					If( interaction.continueRay, () => {

						If( interaction.isTransmissive.or( interaction.isSubsurface ), () => {

							active.assign( false ); // terminate-class ⇒ invalid

						} ).Else( () => {

							// alpha skip — the walker's EXACT gate (3c-2b): pre-x1 (vIdx==0, no opaque
							// vertex yet) the walker terminates unless MASK + alphaShadows and continues
							// with throughput UNTOUCHED; a replayed free-bounce there would leave the
							// generation support ⇒ invalid. Post-x1 skips fold the interaction throughput
							// (the walker's realized pre-anchor transport).
							const preX1ExactOk = material.alphaMode.equal( int( 1 ) )
								.and( enableAlphaShadows.equal( int( 1 ) ) );
							If( vIdx.equal( int( 0 ) ).and( preX1ExactOk.not() ), () => {

								active.assign( false );

							} ).Else( () => {

								If( vIdx.greaterThan( int( 0 ) ), () => {

									prefixFactor.mulAssign( interaction.throughput );

								} );
								rayOrigin.assign( hitPoint.add( rayDir.mul( 0.001 ) ) );

							} );

						} );

					} ).Else( () => {

						// ── replayed opaque vertex x'_v ──
						vIdx.addAssign( int( 1 ) );
						const V = rayDir.negate().toVar();
						If( dot( N, V ).lessThan( 0.0 ), () => {

							N.assign( N.negate() );

						} );

						// stratum check (the hybrid-shift invertibility condition): reconnectability
						// satisfied EARLY ⇒ the shifted path leaves the source's stratum ⇒ invalid
						const pairOk = prevRough.greaterThanEqual( restirGIRoughnessTau )
							.and( material.roughness.greaterThanEqual( RESTIR_PT_TAU1 ) )
							.and( length( hitPoint.sub( prevPos ) ).greaterThanEqual( RESTIR_PT_DMIN ) ).toVar();

						If( pairOk, () => {

							active.assign( false );

						} ).ElseIf( vIdx.equal( kLast ), () => {

							// x'_{k−1}: reconnection-edge validity + solid-angle factor (NO /p)
							const xk = giX1( r ).toVar();
							const toK = xk.sub( hitPoint ).toVar();
							const dK = length( toK ).toVar();
							// x_k roughness via the SAME texture recipe the walker's anchor test used (textured
							// + clamped — evalLo's rebuild :119-127); the raw base value can sit on the other
							// side of τ₁ on roughness-mapped materials, nulling anchors the walker accepted.
							// Stored handles ⇒ domain-independent; frozen sentinel (matIdx1 < 0, clearcoat /
							// fallback anchor): the walker verified the true value at capture ⇒ pass.
							const roughK = float( 1.0 ).toVar();
							If( r.matIdx1.greaterThanEqual( 0.0 ), () => {

								const matK = RayTracingMaterial.wrap( getMaterial( int( r.matIdx1 ), materialBuffer ) ).toVar();
								const msK = MaterialSamples.wrap( sampleAllMaterialTextures(
									albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
									matK, vec2( r.uv1x, r.uv1y ), giN1( r ),
								) ).toVar();
								roughK.assign( msK.roughness.clamp( 0.05, 1.0 ) );

							} );
							const edgeOk = material.roughness.greaterThanEqual( restirGIRoughnessTau )
								.and( roughK.greaterThanEqual( RESTIR_PT_TAU1 ) )
								.and( dK.greaterThanEqual( RESTIR_PT_DMIN ) );
							If( edgeOk, () => {

								const wK = toK.div( max( dK, float( 1e-6 ) ) ).toVar();
								const fK = evaluateMaterialResponse( V, wK, N, material );
								const cosK = max( dot( N, wK ), float( 0.0 ) );
								prefixFactor.mulAssign( fK.mul( cosK ) );
								resValid.assign( 1.0 );
								resXPrev.assign( hitPoint );
								resNPrev.assign( N );
								resVPrev.assign( V );
								resNGeoPrev.assign( nGeo );
								resMatIdxPrev.assign( float( hit.materialIndex ) );
								resUvPrev.assign( hit.uv );

							} );
							active.assign( false );

						} ).Else( () => {

							// interior vertex: scatter only — same draws, same order as the walker (xi pair
							// advances the stream; everything else is a frozen-param read). NO NEE, NO RR.
							const mc = MaterialClassification.wrap( classifyMaterial(
								material.metalness, material.roughness, material.transmission,
								material.clearcoat, material.emissive, material.subsurface,
							) ).toVar();
							// per-component capture (a collapsed vec2 pair would desync from the walker's draws)
							const xiX = RandomValue( stream ).toVar();
							const xiY = RandomValue( stream ).toVar();
							const xi = vec2( xiX, xiY ).toVar();
							const brdfDir = vec3( 0.0 ).toVar();
							const brdfValue = vec3( 0.0 ).toVar();
							const brdfPdf = float( 0.0 ).toVar();
							If( material.clearcoat.greaterThan( 0.0 ), () => {

								const ccHit = HitInfo( {
									didHit: true, dst: hit.dst, hitPoint, normal: N, uv: hit.uv,
									materialIndex: hit.materialIndex, meshIndex: int( 0 ),
									triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
								} );
								const ccResult = ClearcoatResult.wrap( sampleClearcoat(
									ray, ccHit, material, xi, stream,
								) );
								brdfDir.assign( ccResult.L );
								brdfValue.assign( ccResult.brdf );
								brdfPdf.assign( ccResult.pdf );

							} ).Else( () => {

								const bs = DirectionSample.wrap( generateSampledDirection(
									V, N, material, xi, stream, mc, false, emptyWeights, false, emptyCache,
								) );
								brdfDir.assign( bs.direction );
								brdfValue.assign( bs.value );
								brdfPdf.assign( bs.pdf );

							} );

							const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
								material, iter, mc,
							) ).toVar();
							const ind = IndirectLightingResult.wrap( calculateIndirectLighting(
								V, N, material, brdfDir, brdfPdf, brdfValue, stream, samplingInfo,
							) ).toVar();

							// PSS fold f_j·cos_j/p_j via the walker's REALIZED throughputNoF
							// (= cosineWeight/combinedPdf, pre-floored): strategy-correct |cos| for
							// transmission-lobe draws (LightsIndirect :333-391) — max(dot,0) here zeroed
							// below-surface continuations the walker transports (support hole). The
							// validInput fallback ⇒ throughputNoF=0 ⇒ target-0 (was f·cos/MIN_PDF spike).
							const fJ = evaluateMaterialResponse( V, ind.direction, N, material );
							prefixFactor.mulAssign( fJ.mul( ind.throughputNoF ) );

							rayOrigin.assign( hitPoint.add( N.mul( 0.001 ) ) );
							rayDir.assign( ind.direction );
							prevRough.assign( material.roughness );
							prevPos.assign( hitPoint );

						} );

					} );

				} );

				iter.addAssign( int( 1 ) );

			} );

			resPrefixFactor.assign( prefixFactor );

		} );

		return GIReplayResult( {
			valid: resValid,
			prefixFactor: resPrefixFactor,
			xPrev: resXPrev,
			nPrev: resNPrev,
			vPrev: resVPrev,
			nGeoPrev: resNGeoPrev,
			matIdxPrev: resMatIdxPrev,
			uvPrev: resUvPrev,
		} );

	} );

}

export const GIReplayTargetResult = struct( {
	// NOT named `target` — a WGSL reserved keyword (struct field names are emitted verbatim; the kernel
	// fails CreateShaderModule and silently no-ops — the PT-3c-2 all-zero-pool regression).
	pHat: 'float', // luminance( prefixFactor · evalLo@x'_{k−1} ); 0 = replay failed (shift invalid)
	xPrev: 'vec3', // the replay's terminal vertex x'_{k−1} — the k>1 Jacobian endpoint (0 on failure)
} );

/**
 * Build the shared k>1 TARGET evaluator — the ONE target function Eq. 8 requires at every call site
 * (gi-initial's k>1 p̂ + the temporal/spatial k-branched cross-targets). Takes the ALREADY-BUILT
 * prefixReplay + evalLo Fns (building them here would stamp a second replay body into kernels that
 * also call them directly).
 * Returned Fn: ( r [GIReservoir], atP, atN, atV, atMat ) → GIReplayTargetResult (callers .wrap()).
 * Never called for k ≤ 1.
 */
export function makeGIReplayTarget( params ) {

	const {
		prefixReplay, evalLo, materialBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
	} = params;

	return Fn( ( [ r, atP, atN, atV, atMat ] ) => {

		const pHat = float( 0.0 ).toVar();
		const xPrev = vec3( 0.0 ).toVar();

		const rep = GIReplayResult.wrap( prefixReplay( r, atP, atN, atV, atMat ) ).toVar();
		If( rep.valid.greaterThan( 0.5 ), () => {

			// matPrev rebuilt from the replay's handles (the same recipe as x0/x1)
			const matPrev = RayTracingMaterial.wrap( getMaterial( int( rep.matIdxPrev ), materialBuffer ) ).toVar();
			const msPrev = MaterialSamples.wrap( sampleAllMaterialTextures(
				albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
				matPrev, rep.uvPrev, rep.nGeoPrev,
			) ).toVar();
			matPrev.color.assign( msPrev.albedo );
			matPrev.metalness.assign( msPrev.metalness.clamp( 0.0, 1.0 ) );
			matPrev.roughness.assign( msPrev.roughness.clamp( 0.05, 1.0 ) );
			matPrev.sheenRoughness.assign( matPrev.sheenRoughness.clamp( 0.05, 1.0 ) );
			// the reconnection-edge f·cos lives in prefixFactor — no x0-side f·cos here
			const LoPrev = evalLo(
				r, rep.xPrev, rep.nPrev, rep.vPrev, matPrev,
				int( r.kPrefix ).sub( int( 1 ) ),
			).toVar();
			pHat.assign( luminance( { color: rep.prefixFactor.mul( LoPrev ) } ) );
			xPrev.assign( rep.xPrev );

		} );

		return GIReplayTargetResult( { pHat, xPrev } );

	} );

}
