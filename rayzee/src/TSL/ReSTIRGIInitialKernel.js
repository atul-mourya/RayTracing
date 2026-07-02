/**
 * ReSTIRGIInitialKernel.js — ReSTIR GI/PT canonical RIS (per-pixel 16×16, 2D screen dispatch).
 *
 * Specs: docs/specs/restir-gi-phase02.md (base) + docs/specs/restir-pt-phase03.md (PT-1 walk, PT-2 split).
 * Runs AFTER bounce-0 Shade. For each reconnectable primary hit x0: BSDF-sample ω0 (clearcoat-aware,
 * mirroring Shade), run the SUFFIX WALKER (full multi-bounce path → the split payload {A, Le+triIdx, B,
 * ω1out, mat1 handle}), then RIS with p̂ computed through the SHARED domain evaluator (ReSTIRGIEval) on
 * the STORED/quantized candidate representation — the eval-after-store canonicalization that keeps
 * W = wSum/(M·p̂) normalized against the exact function the reuse kernels and the resolve evaluate.
 *
 * Storage buffers (≤10 Metal-3 cap): bvh, tri, mat, hit, ray, rng, giReservoirPool, primaryHit,
 * lightStorage = 9 SB (ray = PT-3c prefix-radiance add). Light/emissive uniforms + material-map/env
 * textures → 0 SB. ✅
 *
 * Reconnectability (shared gate — MUST match the ShadeKernel continuation-kill EXACTLY): roughness ≥ τ
 * AND DETERMINISTIC-OPAQUE (transmission ≤ 0, subsurface ≤ 0, alphaMode OPAQUE or MASK-above-cutoff).
 *
 * M_CANDIDATES = 1 (ReSTIR PT canonical count — reuse supplies the resampling power).
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, normalize, max, dot, select, Return,
	localId, workgroupId,
} from 'three/tsl';

import {
	readHitDistance, readHitNormal, readHitMaterialIndex, readHitBarycentrics,
	readRayRadiance, writeRayRadiance,
} from '../Processor/PackedRayBuffer.js';
import { RandomValue } from './Random.js';
import { getMaterial, luminance, classifyMaterial } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { generateSampledDirection } from './PathTracerCore.js';
import { calculateIndirectLighting } from './LightsIndirect.js';
import { getImportanceSamplingInfo } from './MaterialProperties.js';
import { sampleClearcoat, ClearcoatResult } from './Clearcoat.js';
import { IndirectLightingResult } from './LightsCore.js';
import {
	Ray, HitInfo, RayTracingMaterial, MaterialSamples, DirectionSample,
	MaterialClassification, BRDFWeights, MaterialCache, ImportanceSamplingInfo,
} from './Struct.js';
import { makeSuffixWalker, PTWalkResult } from './ReSTIRPTWalk.js';
import { makeGILoEvaluator } from './ReSTIRGIEval.js';
import { makeGIPrefixReplay, makeGIReplayTarget, GIReplayTargetResult } from './ReSTIRGIReplay.js';
import {
	GIReservoir, giReservoirUpdate, giReservoirFinalizeInitial,
	emptyGIReservoir, writeGIReservoir, readGIReservoir,
	reservoirSlotIndexGI, giPrimaryHitIndex, octEncodeNormal, makeValidFlip,
} from './ReSTIRGICore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;
// ReSTIR PT canonical candidate count: each candidate is a FULL multi-bounce path ≈ one BF sample.
const M_CANDIDATES = 1;

export function buildRestirGIInitialKernel( params ) {

	const {
		// Storage buffers
		bvhBuffer, triangleBuffer, materialBuffer,
		hitBufferRO, rayBufferRW, rngBufferRW, giReservoirPoolRW, primaryHitBuffer,
		// Packed light buffer (emissive NEE/MIS in the walker) — the 8th SB
		lightBuffer,
		// Light buffers (uniform buffers — 0 SB)
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		// Emissive-set uniforms (0 SB)
		emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
		emissiveBoost, enableEmissiveTriangleSampling, lightBVHNodeCount,
		// Environment resources (textures — 0 SB)
		envTexture, environmentIntensity, envMatrix, envCDFTexture,
		envTotalSum, envCompensationDelta, envResolution, enableEnvironmentLight, useEnvMapIS,
		// Camera (view dir from exact hit point)
		cameraWorldMatrix,
		// Uniforms
		frameParityUniform, resolutionUniform, restirGIRoughnessTau,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		enableAlphaShadows,
		globalIlluminationIntensity, fireflyThreshold, frame,
	} = params;

	const suffixWalk = makeSuffixWalker( {
		bvhBuffer, triangleBuffer, materialBuffer,
		lightBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
		emissiveBoost, enableEmissiveTriangleSampling, lightBVHNodeCount,
		envTexture, environmentIntensity, envMatrix, envCDFTexture,
		envTotalSum, envCompensationDelta, envResolution, enableEnvironmentLight, useEnvMapIS,
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		enableAlphaShadows,
		globalIlluminationIntensity, fireflyThreshold, frame,
		restirGIRoughnessTau,
	} );

	// The SHARED domain evaluator — same closure inputs the reuse kernels/resolve use.
	const evalLo = makeGILoEvaluator( {
		materialBuffer, triangleBuffer,
		emissiveTotalPower,
	} );

	// PT-3c shared prefix replay — own-domain canonical p̂ for k>1 candidates (the same Fn the
	// resolve uses).
	const prefixReplay = makeGIPrefixReplay( {
		bvhBuffer, triangleBuffer, materialBuffer,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		restirGIRoughnessTau, enableAlphaShadows,
	} );

	// PT-3c-2: the shared k>1 target evaluator — the SAME Fn the reuse kernels' k-branched
	// cross-targets call (Eq. 8: one target function at every site).
	const replayTarget = makeGIReplayTarget( {
		prefixReplay, evalLo, materialBuffer,
	} );

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			const pixelIndex = gy.mul( int( resolutionUniform.x ) ).add( gx );
			const rayID = uint( pixelIndex );
			const baseIdx = reservoirSlotIndexGI( gx, gy, int( resolutionUniform.x ), frameParityUniform ).toVar();

			// Helper: write an empty (M=0 = non-participating pixel) reservoir — ALL lanes — and bail.
			const writeEmptyAndReturn = () => {

				const empty = GIReservoir.wrap( emptyGIReservoir() ).toVar();
				writeGIReservoir( giReservoirPoolRW, baseIdx, empty );
				Return();

			};

			const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
			If( hitDist.greaterThan( MISS_DIST ), () => {

				writeEmptyAndReturn();

			} );

			const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
			const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
			const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

			const P = primaryHitBuffer.element( giPrimaryHitIndex( pixelIndex, frameParityUniform ) ).xyz.toVar();
			const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
			const V = normalize( camPos.sub( P ) ).toVar();

			const material = RayTracingMaterial.wrap( getMaterial( int( hitMatIdx ), materialBuffer ) ).toVar();
			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
				material, hitUV, normalize( hitNormal ),
			) ).toVar();
			material.color.assign( matSamples.albedo );
			material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
			material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );
			material.sheenRoughness.assign( material.sheenRoughness.clamp( 0.05, 1.0 ) );

			// Participation gate (lockstep with the ShadeKernel kill): DETERMINISTIC-OPAQUE, and (PT-3b)
			// glossy x0 participates at mb≥2. mb=1 keeps the τ gate (the realtime tier: widening buys
			// nothing at k≡1 while enlarging the walker-omission surface). PT-3c-2: only the x1-anchored
			// glossy FALLBACK (kOut ≤ 1) stays CANONICAL-ONLY — a proper deferred anchor is replayable
			// at foreign domains, so it is reusable (nonReusable decided after the walk, below).
			const maskCutoff = select( material.alphaTest.greaterThan( 0.0 ), material.alphaTest, float( 0.5 ) );
			const alphaOk = material.alphaMode.equal( int( 0 ) )
				.or( material.alphaMode.equal( int( 1 ) ).and( material.color.a.greaterThanEqual( maskCutoff ) ) );
			const roughEnough = material.roughness.greaterThanEqual( restirGIRoughnessTau );
			const participates = roughEnough.or( int( maxBounceCount ).greaterThanEqual( int( 2 ) ) )
				.and( material.transmission.lessThanEqual( 0.0 ) )
				.and( material.subsurface.lessThanEqual( 0.0 ) )
				.and( alphaOk );
			// PT-3c walker k-selection: rough x0 pins the anchor to x1 (the bit-compatible k=1 path)
			const anchorAtX1 = select( roughEnough, float( 1.0 ), float( 0.0 ) ).toVar();
			If( participates.not(), () => {

				writeEmptyAndReturn();

			} );

			const N = matSamples.normal.toVar();
			If( dot( N, V ).lessThan( 0.0 ), () => {

				N.assign( N.negate() );

			} );

			const sampleOrigin = P.add( N.mul( 0.001 ) ).toVar();
			const mc = MaterialClassification.wrap( classifyMaterial(
				material.metalness, material.roughness, material.transmission,
				material.clearcoat, material.emissive, material.subsurface,
			) ).toVar();

			const emptyWeights = BRDFWeights( {
				specular: float( 0.0 ), diffuse: float( 0.0 ), sheen: float( 0.0 ),
				clearcoat: float( 0.0 ), transmission: float( 0.0 ), iridescence: float( 0.0 ),
			} );
			const emptyCache = MaterialCache( {
				F0: vec3( 0.04 ), NoV: float( 1.0 ), diffuseColor: vec3( 0.0 ), isPurelyDiffuse: false,
				alpha: float( 0.0 ), k: float( 0.0 ), alpha2: float( 0.0 ),
				invRoughness: float( 0.5 ), metalFactor: float( 0.5 ), iorFactor: float( 0.67 ), maxSheenColor: float( 0.0 ),
			} );

			const rngState = rngBufferRW.element( rayID ).toVar();

			// Running reservoir: written to the pool after each fold, re-read for the next (the pool slot
			// IS the accumulator — same-invocation R/W to one element is program-ordered; avoids 24 scalar
			// mirror vars).
			{

				const empty = GIReservoir.wrap( emptyGIReservoir() ).toVar();
				writeGIReservoir( giReservoirPoolRW, baseIdx, empty );

			}

			for ( let candIdx = 0; candIdx < M_CANDIDATES; candIdx ++ ) {

				// PT-3: per-candidate PRE-xi0 rng snapshot — the replay seed (the walker stream alone cannot
				// reproduce the x0 scatter; pcgHash is not invertible). Split 16/16 into f32-exact lanes
				// BEFORE any float-struct crossing; rides the WRS as cand fields.
				const candSeed = rngState.toVar();
				const seedLo = float( candSeed.bitAnd( uint( 0xFFFF ) ) ).toVar();
				const seedHi = float( candSeed.shiftRight( uint( 16 ) ) ).toVar();

				// clearcoat-aware ω0 sample (mirror Shade :653-680). Per-component capture — the
				// collapsed pair (f(S2), f(S2)) breaks the replay's xi0 = (f(S1), f(S2)) contract.
				const xi0X = RandomValue( rngState ).toVar();
				const xi0Y = RandomValue( rngState ).toVar();
				const xi0 = vec2( xi0X, xi0Y ).toVar();
				const bs0Dir = vec3( 0.0 ).toVar();
				const bs0Value = vec3( 0.0 ).toVar();
				const bs0Pdf = float( 0.0 ).toVar();
				If( material.clearcoat.greaterThan( 0.0 ), () => {

					const ccRay = Ray( { origin: camPos, direction: V.negate() } );
					const ccHit = HitInfo( {
						didHit: true, dst: hitDist, hitPoint: P, normal: N, uv: hitUV,
						materialIndex: int( hitMatIdx ), meshIndex: int( 0 ),
						triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
					} );
					const ccResult = ClearcoatResult.wrap( sampleClearcoat(
						ccRay, ccHit, material, xi0, rngState,
					) );
					bs0Dir.assign( ccResult.L );
					bs0Value.assign( ccResult.brdf );
					bs0Pdf.assign( ccResult.pdf );

				} ).Else( () => {

					const bs0 = DirectionSample.wrap( generateSampledDirection(
						V, N, material, xi0, rngState, mc, false, emptyWeights, false, emptyCache,
					) );
					bs0Dir.assign( bs0.direction );
					bs0Value.assign( bs0.value );
					bs0Pdf.assign( bs0.pdf );

				} );

				const samplingInfo0 = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo( material, int( 0 ), mc ) ).toVar();
				const ind0 = IndirectLightingResult.wrap( calculateIndirectLighting(
					V, N, material, bs0Dir, bs0Pdf, bs0Value, rngState, samplingInfo0,
				) ).toVar();
				const w0 = ind0.direction.toVar();
				const f0 = evaluateMaterialResponse( V, w0, N, material ).toVar();
				// TRUE marginal density — pre-floored at MIN_PDF (the RIS division uses it untouched)
				const pdf0 = max( ind0.combinedPdf, float( 1e-8 ) ).toVar();
				const cos0 = max( dot( N, w0 ), float( 0.0 ) ).toVar();
				const samplerPdf0 = bs0Pdf.toVar();

				const walkValid = samplerPdf0.greaterThan( 0.0 ).and( cos0.greaterThan( 0.0 ) ).and( pdf0.greaterThan( 0.0 ) ).toVar();

				If( walkValid, () => {

					const walk = PTWalkResult.wrap( suffixWalk(
						sampleOrigin, w0, pdf0, ind0.throughput, rngState, anchorAtX1,
					) ).toVar();

					// PT-3c: pre-anchor (glossy-prefix) vertex terms are per-pixel BF — straight to RAY
					// radiance. BF-clamped per term at capture; NO extra regularize wrap (no W
					// amplification on the canonical path).
					If( luminance( { color: walk.prefixRad } ).greaterThan( 0.0 ), () => {

						const cur = readRayRadiance( rayBufferRW, rayID ).toVar();
						writeRayRadiance( rayBufferRW, rayID, vec4(
							cur.xyz.add( ind0.throughput.mul( globalIlluminationIntensity ).mul( walk.prefixRad ) ),
							cur.w,
						) );

					} );

					If( walk.flags.greaterThan( 0.5 ), () => {

						// PT-3c-2: only the x1-anchored glossy FALLBACK is non-reusable; a deferred
						// anchor (kOut > 1) passed the pair gates and shifts via the replay.
						const nonReusable = roughEnough.not().and( walk.kOut.lessThanEqual( float( 1.0 ) ) );

						// Build the candidate in its STORED representation (n1 quantized through the
						// 12-bit oct) so the adoption-p̂ below is computed by the exact function the
						// reuse kernels and the resolve will evaluate (eval-after-store canonicalization).
						const cand = GIReservoir( {
							wSum: float( 0.0 ), W: float( 0.0 ), M: float( 0.0 ), pHatOwn: float( 0.0 ),
							x1x: walk.x1.x, x1y: walk.x1.y, x1z: walk.x1.z,
							n1packed: octEncodeNormal( walk.n1 ),
							AR: walk.A.x, AG: walk.A.y, AB: walk.A.z,
							validFlip: makeValidFlip( walk.flip.greaterThan( 0.5 ), nonReusable ),
							BR: walk.B.x, BG: walk.B.y, BB: walk.B.z, om1x: walk.om1.x,
							matIdx1: walk.matIdx1, uv1x: walk.uv1.x, uv1y: walk.uv1.y, om1y: walk.om1.y,
							LeR: walk.Le.x, LeG: walk.Le.y, LeB: walk.Le.z, triIdx1: walk.triIdx1,
							// PT-3c: k from the walker's anchor policy (1 = x1 / fallback)
							seedLo, seedHi, kPrefix: walk.kOut, prefixPHatCache: float( 0.0 ),
						} ).toVar();

						// p̂ through the SHARED evaluator on the STORED representation. k>1: the own-domain
						// prefix replay supplies the PSS prefix factor + the replayed edge-origin surface
						// (eval-after-store still holds — the replay reads only stored lanes + the domain);
						// the RIS denominator becomes the source's reconnection-segment pdf p_{k−1}.
						const pHat = float( 0.0 ).toVar();
						const risDenom = pdf0.toVar();
						If( walk.kOut.lessThanEqual( 1.0 ), () => {

							const LoDomain = evalLo( cand, P, N, V, material, int( 0 ) ).toVar();
							pHat.assign( luminance( { color: f0.mul( cos0 ).mul( LoDomain ) } ) );

						} ).Else( () => {

							risDenom.assign( walk.pAnchor );
							// the shared k>1 target (replay + matPrev rebuild + evalLo inside) — the
							// exact function the reuse kernels' k-branched cross-targets evaluate
							const rt = GIReplayTargetResult.wrap( replayTarget( cand, P, N, V, material ) ).toVar();
							pHat.assign( rt.pHat );

						} );
						const weight = pHat.greaterThan( 0.0 ).select( pHat.div( max( risDenom, 1e-10 ) ), float( 0.0 ) ).toVar();
						// zero-weight candidates still count toward M (participating pixel, null draw)
						If( weight.lessThanEqual( 0.0 ), () => {

							cand.validFlip.assign( float( 0.0 ) );

						} );

						const running = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdx ) ).toVar();
						const next = GIReservoir.wrap( giReservoirUpdate(
							running, cand, weight, pHat, RandomValue( rngState ),
						) ).toVar();
						writeGIReservoir( giReservoirPoolRW, baseIdx, next );

					} ).Else( () => {

						// invalid walk (pre-x1 termination / env-off miss): a participating pixel with a
						// null draw — M increments, sample stays null.
						const running = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdx ) ).toVar();
						const nullCand = GIReservoir.wrap( emptyGIReservoir() ).toVar();
						const next = GIReservoir.wrap( giReservoirUpdate(
							running, nullCand, float( 0.0 ), float( 0.0 ), RandomValue( rngState ),
						) ).toVar();
						writeGIReservoir( giReservoirPoolRW, baseIdx, next );

					} );

				} ).Else( () => {

					const running = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdx ) ).toVar();
					const nullCand = GIReservoir.wrap( emptyGIReservoir() ).toVar();
					const next = GIReservoir.wrap( giReservoirUpdate(
						running, nullCand, float( 0.0 ), float( 0.0 ), RandomValue( rngState ),
					) ).toVar();
					writeGIReservoir( giReservoirPoolRW, baseIdx, next );

				} );

			}

			// Finalize canonical UCW: W = wSum / (M · p̂(chosen)); invalidate when W collapses to 0.
			const acc = GIReservoir.wrap( readGIReservoir( giReservoirPoolRW, baseIdx ) ).toVar();
			const finalRes = GIReservoir.wrap( giReservoirFinalizeInitial( acc, acc.pHatOwn ) ).toVar();
			If( finalRes.W.lessThanEqual( 0.0 ), () => {

				finalRes.validFlip.assign( float( 0.0 ) );

			} );
			writeGIReservoir( giReservoirPoolRW, baseIdx, finalRes );

			rngBufferRW.element( rayID ).assign( rngState );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_GI_INITIAL_WG_SIZE };
