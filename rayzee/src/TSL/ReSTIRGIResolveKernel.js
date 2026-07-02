/**
 * ReSTIRGIResolveKernel.js — Phase-2 ReSTIR GI contribution (per-pixel 16×16, 2D dispatch).
 *
 * Spec: docs/specs/restir-gi-phase02.md §6. Reads the finalized cur GI reservoir {x1, n1, L_o, W}, traces
 * ONE visibility ray x0↔x1, and ADDS  globalIlluminationIntensity · f_{x0}(ω) · max(dot(n0,ω),0) · L_o · V · W
 * into RAY.RADIANCE_ALPHA with the SAME regularizePathContribution wrapper Shade uses — pathLength = 1 (the
 * replaced term lived at bounce 1). This re-injects the 1-bounce indirect that the ShadeKernel continuation-
 * kill removed at bounce 0. It adds NO env term (env@x0 is retained by Shade; env reached via the bounce is
 * already inside L_o).
 *
 * Storage buffers (≤10): bvh, tri, mat, hit, ray, giReservoirRO, primaryHit = 7 SB. Material maps → 0 SB.
 *
 * Shadow-ray origin = x0 + n0·0.001 (matches the BF indirect ray, ShadeKernel.js:870); shadowDist =
 * |x1−x0| − 0.001 (offset the far end too). traverseBVHShadow has NO tMin — the offset is the sole
 * self-shadow guard (calculateRayOffset's ~N·1e-4 reproduces the −1.6% DI dark bias; project_restir_shadow_offset_bias).
 *
 * PT-3c: k>1 reservoirs re-anchor at x_k — the prefix is random-replayed at this domain
 * (ReSTIRGIReplay, +1 replay/pixel) and the visibility ray moves to x'_{k−1}↔x_k; contribution =
 * prefixFactor · Lo(x'_{k−1}) · V · W · gi (the reconnection f·cos lives in prefixFactor). k≤1 keeps
 * the PT-2 path bit-for-bit.
 */

import {
	Fn, float, vec4, int, uint,
	If, normalize, max, dot, length, Return,
	localId, workgroupId,
} from 'three/tsl';

import {
	readHitDistance, readHitNormal, readHitMaterialIndex, readHitBarycentrics,
	readRayRadiance, writeRayRadiance,
} from '../Processor/PackedRayBuffer.js';
import { getMaterial, computeDotProducts } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { traceShadowRay } from './LightsDirect.js';
import { traverseBVHShadow } from './BVHTraversal.js';
import { regularizePathContribution } from './PathTracerCore.js';
import { RayTracingMaterial, MaterialSamples, DotProducts } from './Struct.js';
import { makeGILoEvaluator } from './ReSTIRGIEval.js';
import { makeGIPrefixReplay, GIReplayResult } from './ReSTIRGIReplay.js';
import {
	GIReservoir, readGIReservoir, reservoirSlotIndexGI, giPrimaryHitIndex, giX1, GI_VALID,
} from './ReSTIRGICore.js';

const WG_SIZE = 16;
const MISS_DIST = 1e19;

export function buildRestirGIResolveKernel( params ) {

	const {
		// Storage buffers
		bvhBuffer, triangleBuffer, materialBuffer,
		hitBufferRO, rayBufferRW, giReservoirPoolRO, primaryHitBuffer,
		// Camera (view dir from exact hit point)
		cameraWorldMatrix,
		// Uniforms
		frameParityUniform, resolutionUniform,
		globalIlluminationIntensity, fireflyThreshold, frame, maxBounceCount,
		transmissiveBounces, maxSubsurfaceSteps, restirGIRoughnessTau, enableAlphaShadows,
		emissiveTotalPower,
	} = params;

	// PT-2 shared domain evaluator — Lo = A + E·misW(own domain) + f1(V1_own)·B.
	const evalLo = makeGILoEvaluator( {
		materialBuffer, triangleBuffer,
		emissiveTotalPower,
	} );

	// PT-3c shared prefix replay — the SAME Fn gi-initial normalized the k>1 W against.
	const prefixReplay = makeGIPrefixReplay( {
		bvhBuffer, triangleBuffer, materialBuffer,
		maxBounceCount, transmissiveBounces, maxSubsurfaceSteps,
		restirGIRoughnessTau, enableAlphaShadows,
	} );

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( int( resolutionUniform.x ) ).and( gy.lessThan( int( resolutionUniform.y ) ) ), () => {

			const resW = int( resolutionUniform.x ).toVar();
			const pixelIndex = gy.mul( resW ).add( gx );
			const rayID = uint( pixelIndex );

			// Read the finalized cur GI reservoir (all 6 lanes).
			const baseIdx = reservoirSlotIndexGI( gx, gy, resW, frameParityUniform ).toVar();
			const reservoir = GIReservoir.wrap( readGIReservoir( giReservoirPoolRO, baseIdx ) ).toVar();

			// Skip invalid / zero-weight reservoirs.
			If(
				reservoir.validFlip.lessThan( float( GI_VALID ) )
					.or( reservoir.W.lessThanEqual( float( 1e-10 ) ) ), () => {

					Return();

				} );

			// Bounce-0 hit — misses carry no GI reservoir.
			const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
			If( hitDist.greaterThan( MISS_DIST ), () => {

				Return();

			} );

			const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
			const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
			const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();

			const P = primaryHitBuffer.element( giPrimaryHitIndex( pixelIndex, frameParityUniform ) ).xyz.toVar();
			const camPos = cameraWorldMatrix.mul( vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz.toVar();
			const V = normalize( camPos.sub( P ) ).toVar();

			// Rebuild x0 material (same as Shade) for the BRDF eval.
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

			If( reservoir.kPrefix.lessThanEqual( 1.0 ), () => {

				// ── k=1: the PT-2 path (bit-for-bit) ──
				// Reconnect to the stored sample point x1 from the SAME offset origin gi-initial traced the
				// candidate from (P + N·0.001) — so the reconnection direction wi == the candidate's traced
				// direction w0 EXACTLY. PT-2: the payload is EVALUATED at this domain through the shared
				// evalLo (A + per-domain-MIS E + f1(V1_own)·B) — the same function gi-initial normalized W against.
				const x1 = giX1( reservoir ).toVar();
				const Lo = evalLo( reservoir, P, N, V, material, int( 0 ) ).toVar();
				const shadowOrigin = P.add( N.mul( 0.001 ) ).toVar();
				const toX1 = x1.sub( shadowOrigin ).toVar();
				const dist = length( toX1 ).toVar();
				const wi = normalize( toX1 ).toVar();

				const cos0 = max( dot( N, wi ), float( 0.0 ) ).toVar();
				If( cos0.lessThanEqual( 0.0 ), () => {

					Return();

				} );

				const shadowDist = dist.sub( 0.001 ).toVar();
				const visibility = traceShadowRay(
					shadowOrigin, wi, shadowDist,
					traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
				).toVar();

				If( visibility.lessThanEqual( 0.0 ), () => {

					Return();

				} );

				// f at x0 for the reconnection direction (BSDF, no cosine baked in).
				const dots = DotProducts.wrap( computeDotProducts( N, V, wi ) );
				const f = evaluateMaterialResponseFromDots( material, dots ).toVar();

				// Contribution = giScale · f · cos · L_o · V · W (GI-resolve). giScale = globalIlluminationIntensity
				// (the replaced term is a bounce-1 indirect term — unlike DI's bounce-0 resolve which has no scale).
				const contribution = f.mul( cos0 ).mul( Lo ).mul( visibility ).mul( reservoir.W ).mul( globalIlluminationIntensity ).toVar();

				// ADD into RADIANCE_ALPHA. PT-1: per-depth BF-parity clamping already happened per-term inside the
				// suffix walker (ReSTIRPTWalk addTerm), so this wrap is a pure reuse-spike guard at the MOST
				// LENIENT depth factor (pathLength = maxBounces). The old pathLength=1 wrap clamped 30-70% of
				// above-threshold multi-bounce energy at low frame counts (suppress(a+b) ≠ Σsuppress — gap #13).
				const current = readRayRadiance( rayBufferRW, rayID ).toVar();
				const wrapped = regularizePathContribution(
					contribution, float( maxBounceCount ), fireflyThreshold, int( frame ),
				).toVar();
				writeRayRadiance( rayBufferRW, rayID, vec4( current.xyz.add( wrapped ), current.w ) );

			} ).Else( () => {

				// ── k>1: replay the prefix at THIS domain; re-anchor V at x'_{k−1}↔x_k ──
				const rep = GIReplayResult.wrap( prefixReplay( reservoir, P, N, V, material ) ).toVar();
				If( rep.valid.lessThan( 0.5 ), () => {

					Return();

				} );

				// matPrev rebuilt from the replay's handles (same recipe gi-initial's p̂ used)
				const matPrev = RayTracingMaterial.wrap( getMaterial( int( rep.matIdxPrev ), materialBuffer ) ).toVar();
				const msPrev = MaterialSamples.wrap( sampleAllMaterialTextures(
					matPrev, rep.uvPrev, rep.nGeoPrev,
				) ).toVar();
				matPrev.color.assign( msPrev.albedo );
				matPrev.metalness.assign( msPrev.metalness.clamp( 0.0, 1.0 ) );
				matPrev.roughness.assign( msPrev.roughness.clamp( 0.05, 1.0 ) );
				matPrev.sheenRoughness.assign( matPrev.sheenRoughness.clamp( 0.05, 1.0 ) );

				const LoPrev = evalLo(
					reservoir, rep.xPrev, rep.nPrev, rep.vPrev, matPrev,
					int( reservoir.kPrefix ).sub( int( 1 ) ),
				).toVar();

				const xk = giX1( reservoir ).toVar();
				const shadowOrigin = rep.xPrev.add( rep.nPrev.mul( 0.001 ) ).toVar();
				const toXk = xk.sub( shadowOrigin ).toVar();
				const dist = length( toXk ).toVar();
				const wi = normalize( toXk ).toVar();
				const shadowDist = dist.sub( 0.001 ).toVar();
				const visibility = traceShadowRay(
					shadowOrigin, wi, shadowDist,
					traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
				).toVar();

				If( visibility.lessThanEqual( 0.0 ), () => {

					Return();

				} );

				// the reconnection-edge f·cos (and the x0 fold) live in prefixFactor — nothing re-applied
				const contribution = rep.prefixFactor.mul( LoPrev ).mul( visibility )
					.mul( reservoir.W ).mul( globalIlluminationIntensity ).toVar();

				const current = readRayRadiance( rayBufferRW, rayID ).toVar();
				const wrapped = regularizePathContribution(
					contribution, float( maxBounceCount ), fireflyThreshold, int( frame ),
				).toVar();
				writeRayRadiance( rayBufferRW, rayID, vec4( current.xyz.add( wrapped ), current.w ) );

			} );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as RESTIR_GI_RESOLVE_WG_SIZE };
