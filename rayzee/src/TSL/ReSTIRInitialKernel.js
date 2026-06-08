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
	Fn, float, vec2, vec4, int, uint,
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
import { deriveAnalyticLe } from './ReSTIRLighting.js';
import { RayTracingMaterial, MaterialSamples, DotProducts } from './Struct.js';
import {
	Reservoir, reservoirUpdate, reservoirFinalizeInitial,
	reservoirSlotIndex, packReservoirCore, packReservoirAux,
	encodeLightSampleId, RESTIR_ID_NONE,
} from './ReSTIRCore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;
// M analytic-light candidates per pixel (re-tune empirically on the actual stack; §1.3/§1.10).
const M_CANDIDATES = 8;

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
