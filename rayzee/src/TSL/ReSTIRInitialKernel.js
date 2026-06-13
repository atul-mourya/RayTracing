/**
 * ReSTIRInitialKernel.js — Phase-1 ReSTIR DI canonical RIS (per-pixel 16×16, 2D screen dispatch).
 *
 * Runs AFTER bounce-0 Shade (the HIT buffer + material resolve all exist). Builds a fresh per-pixel
 * reservoir by streaming M analytic-light candidates (RIS, §3.2). The target p̂ is the UNSHADOWED
 * luminance of f·⟨n·ωᵢ⟩·Le (Eq. 1) with a TRUE clamped cosine (§3.1 / §7-R7) — never the floored
 * computeDotProducts().NoL. Visibility is deferred to restirResolve.
 *
 * Storage buffers (≤10 Metal-3 cap): hitBufferRO, rngBufferRW, materialBuffer, reservoirPoolRW = 4 SB.
 * (The primary ray is reconstructed from the camera, not the ray buffer — ShadeKernel has already
 * overwritten it with the bounce-1 continuation by the time this runs.) The 4 light buffers are UNIFORM
 * buffers (uniformArray) → 0 SB. Material map arrays are textures → 0 SB. bvh/tri NOT bound. ⇒ 4 SB. ✅
 *
 * TSL: the reservoir is carried as 8 scalar .toVar()s (NOT a struct .toVar() — TSL structs have no
 * whole-struct .assign(), StructNode.js:20). Each RIS step builds a transient Reservoir({…}) from the
 * scalars, calls the verified ReSTIRCore Fn, and shuttles the .wrap()'d result back into the scalars.
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, normalize, max, dot, Return,
	localId, workgroupId,
} from 'three/tsl';

import {
	readHitDistance, readHitNormal, readHitMaterialIndex,
	readHitBarycentrics,
} from '../Processor/PackedRayBuffer.js';
import { RandomValue } from './Random.js';
import { getMaterial, luminance, computeDotProducts } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { sampleLightWithImportance } from './LightsSampling.js';
import { LightSample } from './LightsCore.js';
import { deriveAnalyticLe, restirMISWeight } from './ReSTIRLighting.js';
import { sampleEquirectProbability } from './Environment.js';
import { sampleEmissiveTriangle, EmissiveSample } from './EmissiveSampling.js';
import { RayTracingMaterial, MaterialSamples, DotProducts } from './Struct.js';
import {
	Reservoir, reservoirUpdate, reservoirFinalizeInitial,
	reservoirSlotIndex, packReservoirCore, packReservoirAux,
	encodeLightSampleId, RESTIR_ID_NONE, RESTIR_LIGHT_TYPE_ENV, RESTIR_LIGHT_TYPE_EMISSIVE_TRI,
} from './ReSTIRCore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;
// M analytic-light candidates per pixel (re-tune empirically on the actual stack; §1.3/§1.10).
const M_CANDIDATES = 8;
// Environment (HDRI) candidates per pixel, drawn via the env CDF and resampled into the SAME reservoir.
// Start at 1; raise toward parity with M_CANDIDATES if env-only variance is high (tune empirically).
const M_ENV_CANDIDATES = 1;
// Emissive-triangle (mesh-light) candidates per pixel, drawn via the emissive CDF into the SAME reservoir.
const M_EMISSIVE_CANDIDATES = 1;

export function buildRestirInitialKernel( params ) {

	const {
		// Storage buffers
		hitBufferRO, rngBufferRW, materialBuffer, reservoirPoolRW, primaryHitBuffer,
		// Light buffers (uniform buffers — 0 SB)
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		// Material map texture arrays (textures — 0 SB)
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		// Camera (view dir from exact hit point)
		cameraWorldMatrix,
		// Environment (textures/uniforms — 0 SB): CDF importance sampling + Le re-derivation
		environmentTex, envCDFTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
		envTotalSum, envCompensationDelta, envResolution,
		// Emissive triangles (type 5): packed light buffer (CDF + cached emission) + geometry tri buffer (+2 SB).
		// Candidate uses the flat-CDF sampler (unbiased; RIS resampling refines it) — no L-BVH path needed here.
		lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost,
		emissiveTriangleCount, emissiveTotalPower, enableEmissiveTriangleSampling,
		// Uniforms
		frameParityUniform, resolutionUniform,
	} = params;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			// S is forced to 1 when ReSTIR is on, so rayID == pixelIndex.
			const pixelIndex = gy.mul( int( resolutionUniform.x ) ).add( gx );
			const rayID = uint( pixelIndex );

			// Bounce-0 hit — skip misses (no analytic-light reservoir on the background).
			const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
			If( hitDist.greaterThan( MISS_DIST ), () => {

				Return();

			} );

			const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
			const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
			const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

			// EXACT bounce-0 hit point captured from the actual jittered ray (restirCapture) — NOT the
			// pixel-centre reconstruction, which under-sampled sub-pixel lighting → a ~−5-7% dark bias.
			// V points to the camera: camPos = M·(0,0,0,1) (mat·vec avoids mat4 bracket-indexing in compute).
			const P = primaryHitBuffer.element( pixelIndex ).xyz.toVar();
			const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
			const V = normalize( camPos.sub( P ) ).toVar();

			// Rebuild material exactly as ShadeKernel (getMaterial + sampleAllMaterialTextures + clamps).
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
			// Two-sided shading parity with ShadeKernel: flip N toward the viewer when back-facing.
			If( dot( N, V ).lessThan( 0.0 ), () => {

				N.assign( N.negate() );

			} );

			// RIS shading origin (offset off the surface — matches calculateDirectLightingUnified).
			const sampleOrigin = P.add( N.mul( 0.001 ) ).toVar();
			const rngState = rngBufferRW.element( rayID ).toVar();

			// Reservoir carried as scalar vars (no whole-struct .assign in TSL).
			const rLightId = float( RESTIR_ID_NONE ).toVar();
			const rWSum = float( 0.0 ).toVar();
			const rW = float( 0.0 ).toVar();
			const rM = float( 0.0 ).toVar();
			const rPosX = float( 0.0 ).toVar();
			const rPosY = float( 0.0 ).toVar();
			const rPosZ = float( 0.0 ).toVar();
			const rPHatOwn = float( 0.0 ).toVar();

			const packCurrent = () => Reservoir( {
				lightSampleId: rLightId, wSum: rWSum, W: rW, M: rM,
				samplePosX: rPosX, samplePosY: rPosY, samplePosZ: rPosZ, pHatOwn: rPHatOwn,
			} );

			// Stream M candidate lights (WRS). Each candidate's source pdf p(x) is folded into wᵢ; reuse
			// passes never need p(x) again (only p̂ + carried W), so the pixel-dependence is not a bias source.
			for ( let candIdx = 0; candIdx < M_CANDIDATES; candIdx ++ ) {

				// Fresh random pair per candidate (x = uniform-fallback selection, y = area-light UV); the
				// sampler also draws its own RNG from rngState internally for the WRS walk.
				const lightRandom = vec2( RandomValue( rngState ), RandomValue( rngState ) ).toVar();

				const lightSample = LightSample.wrap( sampleLightWithImportance(
					sampleOrigin, N, material, lightRandom, int( 0 ), rngState,
					directionalLightsBuffer, numDirectionalLights,
					areaLightsBuffer, numAreaLights,
					pointLightsBuffer, numPointLights,
					spotLightsBuffer, numSpotLights,
				) );

				// World light POINT (§2.1, §3.6): samplePos = origin + dir·dist (area measure J=1 by re-eval).
				const samplePos = sampleOrigin.add( lightSample.direction.mul( lightSample.distance ) ).toVar();
				const candId = encodeLightSampleId( lightSample.lightType, lightSample.lightIndex ).toVar();

				// p̂ = luminance( f · max(dot(n,ωᵢ),0) · Le ). CRITICAL (ReSTIR's cardinal rule): evaluate the
				// target IDENTICALLY to the temporal + resolve kernels — reconstruct ωᵢ from the stored world
				// point at P and re-derive Le analytically. Using the sampler's raw emission/direction here
				// instead drifts vs the reuse-path eval and compounds through the temporal W-feedback into a
				// large converged bias (~+22% over-bright). TRUE clamped cosine, NOT floored .NoL (§3.1).
				const wi = normalize( samplePos.sub( P ) ).toVar();
				const pHatCosine = max( dot( N, wi ), float( 0.0 ) ).toVar();
				const sharedDots = DotProducts.wrap( computeDotProducts( N, V, wi ) );
				const f = evaluateMaterialResponseFromDots( material, sharedDots ).toVar();
				const Le = deriveAnalyticLe(
					candId, samplePos, P,
					directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
					environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
					lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost,
				).toVar();
				const pHat = luminance( { color: f.mul( pHatCosine ).mul( Le ) } ).toVar();

				// Invalid candidate (out of hemisphere / zero pdf / not valid) ⇒ weight 0, but still counts toward M.
				const validCand = lightSample.valid.and( lightSample.pdf.greaterThan( 0.0 ) ).and( pHat.greaterThan( 0.0 ) );
				const weight = validCand.select( pHat.div( max( lightSample.pdf, 1e-10 ) ), float( 0.0 ) ).toVar();

				const next = Reservoir.wrap( reservoirUpdate(
					packCurrent(), candId,
					samplePos.x, samplePos.y, samplePos.z,
					weight, pHat, rngState,
				) ).toVar();
				rLightId.assign( next.lightSampleId );
				rWSum.assign( next.wSum );
				rW.assign( next.W );
				rM.assign( next.M );
				rPosX.assign( next.samplePosX );
				rPosY.assign( next.samplePosY );
				rPosZ.assign( next.samplePosZ );
				rPHatOwn.assign( next.pHatOwn );

			}

			// Stream M_ENV environment candidates into the SAME reservoir (RIS union; M accumulates so
			// finalize divides by the true total count). Skipped when env off → analytic path byte-identical.
			// Each env candidate stores a UNIT DIRECTION (not a world point) in samplePos, type ENV; Le is
			// re-derived identically by deriveAnalyticLe (cardinal rule); spatial-reuse Jacobian = 1.
			If( enableEnvironmentLight.greaterThan( 0.5 ), () => {

				const envCandId = encodeLightSampleId( int( RESTIR_LIGHT_TYPE_ENV ), int( 0 ) ).toVar();

				for ( let e = 0; e < M_ENV_CANDIDATES; e ++ ) {

					// per-component capture — a collapsed vec2(f(s), f(s)) pair samples the env CDF
					// only on the u==v diagonal
					const r2u = RandomValue( rngState ).toVar();
					const r2v = RandomValue( rngState ).toVar();
					const r2 = vec2( r2u, r2v ).toVar();
					const envColorOut = vec3( 0.0 ).toVar();
					const envSample = sampleEquirectProbability(
						environmentTex, envCDFTexture, envMatrix, environmentIntensity,
						envTotalSum, envCompensationDelta, envResolution, r2, envColorOut,
					).toVar();
					const envDir = envSample.xyz.toVar(); // world-space unit dir (rotation baked in)
					const envPdf = envSample.w.toVar(); // solid-angle pdf (MIS-compensated)

					// p̂ identical recipe to analytic; Le via deriveAnalyticLe (NOT envColorOut) so the candidate
					// target matches the temporal/spatial/resolve re-eval exactly. TRUE clamped cosine.
					const envCos = max( dot( N, envDir ), float( 0.0 ) ).toVar();
					const envDots = DotProducts.wrap( computeDotProducts( N, V, envDir ) );
					const envF = evaluateMaterialResponseFromDots( material, envDots ).toVar();
					const envLe = deriveAnalyticLe(
						envCandId, envDir, P,
						directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
						environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
						lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost,
					).toVar();
					// Fold the strategy-A MIS weight into the TARGET pHat (not just the resolve) so the env
					// reservoir resamples ∝ w_A·f·cos·Le → unbiased MIS combine with strategy B (the resolve
					// applies the same w_A). Analytic candidates need no weight (helper returns 1).
					const envMisW = restirMISWeight(
						envCandId, envDir, envDots, material,
						environmentTex, envMatrix, envTotalSum, envCompensationDelta, envResolution,
						envDir, P, lightBuffer, emissiveVec4Offset, triangleBuffer, materialBuffer, emissiveTotalPower,
					).toVar();
					const envPHat = luminance( { color: envF.mul( envCos ).mul( envLe ) } ).mul( envMisW ).toVar();

					const envValid = envPdf.greaterThan( 0.0 ).and( envPHat.greaterThan( 0.0 ) );
					const envWeight = envValid.select( envPHat.div( max( envPdf, 1e-10 ) ), float( 0.0 ) ).toVar();

					const nextE = Reservoir.wrap( reservoirUpdate(
						packCurrent(), envCandId,
						envDir.x, envDir.y, envDir.z, // store DIRECTION in the samplePos slot
						envWeight, envPHat, rngState,
					) ).toVar();
					rLightId.assign( nextE.lightSampleId );
					rWSum.assign( nextE.wSum );
					rW.assign( nextE.W );
					rM.assign( nextE.M );
					rPosX.assign( nextE.samplePosX );
					rPosY.assign( nextE.samplePosY );
					rPosZ.assign( nextE.samplePosZ );
					rPHatOwn.assign( nextE.pHatOwn );

				}

			} );

			// Stream M_EMISSIVE emissive-triangle (mesh-light) candidates into the SAME reservoir. Skipped when
			// no emissive triangles → analytic/env path unchanged. Stores a world POINT (like area lights); Le
			// re-derived via deriveAnalyticLe (cached emission + front-face gate). Gated on the SAME toggle as
			// Shade's emissive partition (enableEmissiveTriangleSampling) — streaming the NEE arm while Shade's
			// emissive-hit MIS assumes it off double-counts (1 + w).
			If( emissiveTriangleCount.greaterThan( int( 0 ) )
				.and( enableEmissiveTriangleSampling.equal( int( 1 ) ) ), () => {

				for ( let e = 0; e < M_EMISSIVE_CANDIDATES; e ++ ) {

					const es = EmissiveSample.wrap( sampleEmissiveTriangle(
						P, N, rngState,
						lightBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower, triangleBuffer,
					) ).toVar();

					const emCandId = encodeLightSampleId( int( RESTIR_LIGHT_TYPE_EMISSIVE_TRI ), es.emissiveIndex ).toVar();
					const emPos = es.position.toVar(); // world point on the emissive triangle
					const emWi = normalize( emPos.sub( P ) ).toVar();
					const emCos = max( dot( N, emWi ), float( 0.0 ) ).toVar();
					const emDots = DotProducts.wrap( computeDotProducts( N, V, emWi ) );
					const emF = evaluateMaterialResponseFromDots( material, emDots ).toVar();
					const emLe = deriveAnalyticLe(
						emCandId, emPos, P,
						directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
						environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
						lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost,
					).toVar();
					// Fold the strategy-A powerHeuristic MIS weight into the TARGET pHat (env-model, not full-
					// replace) so the emissive reservoir composes unbiased with the surviving strategy-B
					// (emissive-on-hit at the next bounce, ungatable at bounce-0). Same helper as the resolve.
					const emMisW = restirMISWeight(
						emCandId, emWi, emDots, material,
						environmentTex, envMatrix, envTotalSum, envCompensationDelta, envResolution,
						emPos, P, lightBuffer, emissiveVec4Offset, triangleBuffer, materialBuffer, emissiveTotalPower,
					).toVar();
					const emPHat = luminance( { color: emF.mul( emCos ).mul( emLe ) } ).mul( emMisW ).toVar();

					const emValid = es.valid.and( es.pdf.greaterThan( 0.0 ) ).and( emPHat.greaterThan( 0.0 ) );
					const emWeight = emValid.select( emPHat.div( max( es.pdf, 1e-10 ) ), float( 0.0 ) ).toVar();

					const nextEm = Reservoir.wrap( reservoirUpdate(
						packCurrent(), emCandId,
						emPos.x, emPos.y, emPos.z,
						emWeight, emPHat, rngState,
					) ).toVar();
					rLightId.assign( nextEm.lightSampleId );
					rWSum.assign( nextEm.wSum );
					rW.assign( nextEm.W );
					rM.assign( nextEm.M );
					rPosX.assign( nextEm.samplePosX );
					rPosY.assign( nextEm.samplePosY );
					rPosZ.assign( nextEm.samplePosZ );
					rPHatOwn.assign( nextEm.pHatOwn );

				}

			} );

			// Finalize canonical UCW: W = wSum / (M · p̂(chosen)). pHatChosen = pHatOwn (canonical is at the
			// current pixel, so its own-domain target IS the current-pixel target). pHatOwn is write-once (§2.1).
			const finalRes = Reservoir.wrap( reservoirFinalizeInitial( packCurrent(), rPHatOwn ) ).toVar();

			// Write to the current-parity slot (core then aux).
			const baseIdx = reservoirSlotIndex( gx, gy, int( resolutionUniform.x ), frameParityUniform ).toVar();
			reservoirPoolRW.element( baseIdx ).assign( packReservoirCore( finalRes ) );
			reservoirPoolRW.element( baseIdx.add( int( 1 ) ) ).assign( packReservoirAux( finalRes ) );

			rngBufferRW.element( rayID ).assign( rngState );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_INITIAL_WG_SIZE };
