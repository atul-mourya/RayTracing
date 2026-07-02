/**
 * ReSTIRResolveKernel.js — Phase-1 ReSTIR DI shadow test + contribution (per-pixel 16×16, 2D dispatch).
 *
 * Reads the finalized cur-parity reservoir, traces ONE shadow ray to the chosen world light point,
 * computes f·⟨n·ωᵢ⟩·Le·V·W (Eq. 18) with a TRUE clamped cosine (§3.1), and ADDS it into the ray's
 * RAY.RADIANCE_ALPHA with the SAME regularizePathContribution firefly wrapper Shade uses — so the
 * production accumulator picks it up with zero FinalWrite changes. This REPLACES the bounce-0
 * discrete-light directLight add that ShadeKernel gates off when ReSTIR is on (§3.8 / §4.3).
 *
 * Storage buffers (≤10): bvhBuffer, triangleBuffer, materialBuffer, hitBufferRO, rayBufferRW,
 * reservoirPoolRO = 6 SB. The 4 light buffers are UNIFORM buffers (uniformArray) → 0 SB; material map
 * arrays → 0 SB. No rngBufferRW (the reservoir stores the exact world point — no area-light resample).
 *
 * TSL: reservoir read via unpackReservoir().wrap; no whole-struct mutation.
 */

import {
	Fn, float, vec3, vec4, int, uint,
	If, normalize, max, dot, length, select, Return,
	localId, workgroupId,
} from 'three/tsl';

import {
	readHitDistance, readHitNormal, readHitMaterialIndex,
	readHitBarycentrics, readRayRadiance, writeRayRadiance,
} from '../Processor/PackedRayBuffer.js';
import { getMaterial, computeDotProducts } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { traceShadowRay } from './LightsDirect.js';
import { traverseBVHShadow } from './BVHTraversal.js';
import { regularizePathContribution } from './PathTracerCore.js';
import { deriveAnalyticLe, restirMISWeight } from './ReSTIRLighting.js';
import { RayTracingMaterial, MaterialSamples, DotProducts } from './Struct.js';
import {
	Reservoir, unpackReservoir, reservoirSlotIndex, RESTIR_ID_NONE,
	decodeLightSampleId, RESTIR_LIGHT_TYPE_ENV,
} from './ReSTIRCore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;

export function buildRestirResolveKernel( params ) {

	const {
		// Storage buffers
		bvhBuffer, triangleBuffer, materialBuffer,
		hitBufferRO, rayBufferRW, reservoirPoolRO, primaryHitBuffer,
		// Light buffers (uniform buffers — 0 SB) for Le re-eval
		directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
		// Camera (view dir from exact hit point)
		cameraWorldMatrix,
		// Environment (textures/uniforms — 0 SB) for env Le re-derivation
		environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
		envTotalSum, envCompensationDelta, envResolution,
		// Emissive triangles (type 5): cached emission + geo-normal for Le re-derivation. triangleBuffer above.
		lightBuffer, emissiveVec4Offset, emissiveBoost, emissiveTotalPower,
		// Uniforms
		frameParityUniform, resolutionUniform,
		fireflyThreshold, frame,
	} = params;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			const resW = int( resolutionUniform.x ).toVar();
			const pixelIndex = gy.mul( resW ).add( gx );
			const rayID = uint( pixelIndex );

			// Read the finalized cur reservoir.
			const baseIdx = reservoirSlotIndex( gx, gy, resW, frameParityUniform ).toVar();
			const reservoir = Reservoir.wrap( unpackReservoir(
				reservoirPoolRO.element( baseIdx ),
				reservoirPoolRO.element( baseIdx.add( int( 1 ) ) ),
			) ).toVar();

			// Skip empty / zero-weight reservoirs (no valid analytic-light sample).
			If(
				reservoir.lightSampleId.equal( float( RESTIR_ID_NONE ) )
					.or( reservoir.W.lessThanEqual( float( 1e-10 ) ) ), () => {

					Return();

				} );

			// Bounce-0 hit — misses carry no reservoir.
			const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
			If( hitDist.greaterThan( MISS_DIST ), () => {

				Return();

			} );

			const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
			const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
			const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

			// EXACT bounce-0 hit point from the actual jittered ray (restirCapture), NOT the pixel-centre
			// reconstruction (which under-sampled sub-pixel lighting → a ~−5-7% dark bias vs NEE). RADIANCE_ALPHA
			// is at a different ray-buffer slot, intact, still read/written via rayBufferRW below.
			// V points to the camera: camPos = M·(0,0,0,1) (mat·vec avoids mat4 bracket-indexing in compute).
			const P = primaryHitBuffer.element( pixelIndex ).xyz.toVar();
			const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
			const V = normalize( camPos.sub( P ) ).toVar();

			// Rebuild material at this pixel (same as Shade) for the final BRDF eval.
			const material = RayTracingMaterial.wrap( getMaterial( int( hitMatIdx ), materialBuffer ) ).toVar();
			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
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

			// Decode the chosen sample. For analytic types y is a world light POINT — recompute the
			// connecting direction + distance at THIS pixel (DI Jacobian = 1, §3.6). For ENV, y is already
			// a UNIT DIRECTION: wi = y directly, no finite distance (infinite light).
			const yPos = vec3( reservoir.samplePosX, reservoir.samplePosY, reservoir.samplePosZ ).toVar();
			const isEnv = int( decodeLightSampleId( reservoir.lightSampleId ).x ).equal( int( RESTIR_LIGHT_TYPE_ENV ) ).toVar();
			const toLight = yPos.sub( P ).toVar();
			const analyticDist = length( toLight ).toVar();
			const wi = select( isEnv, normalize( yPos ), normalize( toLight ) ).toVar();

			const NoL = max( dot( N, wi ), float( 0.0 ) ).toVar();
			If( NoL.lessThanEqual( 0.0 ), () => {

				Return();

			} );

			// One shadow ray toward the light point. Origin offset MUST match BF's discrete-light NEE EXACTLY
			// (calculateDirectLightingUnified: hitPoint + N·0.001) — calculateRayOffset returned ~N·1e-4 (6.7-10×
			// smaller), and since traverseBVHShadow has no tMin, the normal offset is the SOLE self-shadow guard:
			// a too-small offset let grazing shadow rays self-intersect the originating surface → spurious
			// self-shadow → a measured ~-1.6% dark bias vs BF. The fixed 1e-3 restores byte parity (one-signed fix).
			const shadowOrigin = P.add( N.mul( 0.001 ) ).toVar();
			// ENV is an infinite light → any-hit to ~infinity; analytic → up to the light point.
			const shadowDist = select( isEnv, float( MISS_DIST ), analyticDist.sub( 0.001 ) ).toVar();
			const visibility = traceShadowRay(
				shadowOrigin, wi, shadowDist,
				traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
			).toVar();

			If( visibility.lessThanEqual( 0.0 ), () => {

				Return();

			} );

			// Re-derive Le from the carried lightSampleId at the current connecting direction (env: along yPos).
			const Le = deriveAnalyticLe(
				reservoir.lightSampleId, yPos, P,
				directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
				environmentTex, envMatrix, environmentIntensity, enableEnvironmentLight,
				lightBuffer, emissiveVec4Offset, triangleBuffer, emissiveBoost,
			).toVar();

			// f at the current pixel (BSDF, no cosine baked in).
			const dots = DotProducts.wrap( computeDotProducts( N, V, wi ) );
			const f = evaluateMaterialResponseFromDots( material, dots ).toVar();

			// MIS weight (SAME helper used in the target pHat → consistent). Analytic → 1; ENV →
			// balanceHeuristic(envPdf, bsdfPdf) so the env reservoir composes unbiased with the surviving
			// strategy-B (bounce-1 miss-hits-env) term instead of double-counting it.
			const misWeight = restirMISWeight(
				reservoir.lightSampleId, wi, dots, material,
				environmentTex, envMatrix, envTotalSum, envCompensationDelta, envResolution,
				yPos, P, lightBuffer, emissiveVec4Offset, triangleBuffer, materialBuffer, emissiveTotalPower,
			).toVar();

			// Contribution = f · ⟨n·ωᵢ⟩ · Le · V · W · misWeight (Eq. 18). W = wSum/p̂(survivor) (finalized).
			const contribution = f.mul( NoL ).mul( Le ).mul( visibility ).mul( reservoir.W ).mul( misWeight ).toVar();

			// ADD into RADIANCE_ALPHA with the SAME firefly wrapper Shade uses (bounce 0 ⇒ giScale = 1,
			// throughput = 1). Read-modify-write .xyz; preserve .w (alpha).
			const current = readRayRadiance( rayBufferRW, rayID ).toVar();
			const wrapped = regularizePathContribution(
				contribution, float( 0.0 ), fireflyThreshold, int( frame ),
			).toVar();
			writeRayRadiance( rayBufferRW, rayID, vec4( current.xyz.add( wrapped ), current.w ) );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_RESOLVE_WG_SIZE };
