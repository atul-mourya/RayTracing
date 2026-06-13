/**
 * ReSTIRGIEval.js — PT-2 domain-aware reservoir-payload evaluation (the ONE shared evalLo).
 *
 * Spec: docs/specs/restir-pt-phase03.md §PT-2. Replaces "Lo = stored radiance" at EVERY touch-point
 * (gi-initial adoption-p̂/finalize, temporal/spatial cross-targets, resolve contribution) with
 *
 *   Lo(domain) = A  +  E·misW(domain)  +  f_{x1}(V1_domain, ω1out)·B
 *
 * — A = frozen d=1 terms; E = the d=1 emissive-hit (or env) UNWEIGHTED radiance whose MIS weight is the
 * one frozen quantity with a LIVE partner at the domain (the broken-partition term — re-derived here per
 * domain with the multi-lobe evaluateCombinedLobePdf + a per-domain calculateEmissiveLightPdf); B = the
 * suffix without f_{x1}, re-multiplied by the domain-incidence BSDF at x1.
 *
 * Eval-after-store canonicalization: gi-initial MUST call this on the stored (quantized n1, rebuilt mat1)
 * candidate representation — never the walker's in-register exact values — so W is normalized against the
 * exact function the combine/resolve evaluate (Eq. 8 consistency). The canonical domain reproduces the
 * walker's folded values: same decode, same texture rebuild, same flip order.
 *
 * Hemisphere gate: domains behind x1's shaded side return 0 ENTIRELY (A and E too — they are
 * front-hemisphere radiance), applied identically everywhere so p̂=0 ⇔ contribution=0.
 */

import {
	Fn, float, vec2, vec3, int,
	If, max, dot, length, select,
} from 'three/tsl';

import { getMaterial, luminance, classifyMaterial, powerHeuristic, balanceHeuristic } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { evaluateCombinedLobePdf } from './LightsIndirect.js';
import { getImportanceSamplingInfo } from './MaterialProperties.js';
import { calculateEmissiveLightPdf } from './EmissiveSampling.js';
import { RayTracingMaterial, MaterialSamples, MaterialClassification, ImportanceSamplingInfo } from './Struct.js';
import {
	giX1, giA, giB, giLe, giN1, giOm1, giFlipBit, GI_MAT_ENV,
} from './ReSTIRGICore.js';

/**
 * Build the evaluator (closure over scene buffers — kernel-builder pattern).
 * Returned Fn: ( r [GIReservoir], P0, N0, V0, mat0, bounceIdx ) → vec3 Lo(domain).
 *   P0/N0/V0/mat0 = the reconnection-edge ORIGIN surface (the domain's x0 for k=1; the replayed
 *   x'_{k−1} for k>1 — PT-3c re-anchoring). bounceIdx (int) feeds the E-reweight's
 *   getImportanceSamplingInfo — int(0) for k=1, k−1 under re-anchoring. Null payloads (A=B=E=0)
 *   return 0 naturally — no validity gate needed.
 */
export function makeGILoEvaluator( params ) {

	const {
		materialBuffer, triangleBuffer,
		albedoMaps, normalMaps, bumpMaps,
		metalnessMaps, roughnessMaps, emissiveMaps,
		emissiveTotalPower,
	} = params;

	return Fn( ( [ r, P0, N0, V0, mat0, bounceIdx ] ) => {

		const out = vec3( 0.0 ).toVar();

		const x1 = giX1( r ).toVar();
		const origin0 = P0.add( N0.mul( 0.001 ) ).toVar();
		const toX1 = x1.sub( origin0 ).toVar();
		const dist = max( length( toX1 ), float( 1e-6 ) ).toVar();
		const wd = toX1.div( dist ).toVar(); // domain reconnection direction x0d→x1
		const V1d = wd.negate().toVar(); // domain incidence at x1

		// Hemisphere gate: the payload is radiance into the hemisphere the path SHADED (n1 oriented by
		// the stored flip bit). A domain behind that tangent plane gets 0 — floored dots would otherwise
		// evaluate f1 through the surface. Env candidates store n1 = −ω ⇒ dot ≈ 1, always pass.
		const n1u = giN1( r ).toVar(); // UNFLIPPED interpolated normal (rebuild basis)
		const nOriented = select( giFlipBit( r ), n1u.negate(), n1u ).toVar();
		If( dot( nOriented, V1d ).greaterThan( 0.0 ), () => {

			out.assign( giA( r ) );

			// ── E term: the d=1 emissive-hit / env radiance, MIS-re-weighted PER DOMAIN ──
			const Le = giLe( r ).toVar();
			If( luminance( { color: Le } ).greaterThan( 0.0 ), () => {

				// pdf0 at the DOMAIN for ωd — the SAME multi-lobe mixture the source weight baked
				// (calculateMaterialPDF's 2-lobe weights would zero dielectric specular — disqualified).
				const mc0 = MaterialClassification.wrap( classifyMaterial(
					mat0.metalness, mat0.roughness, mat0.transmission,
					mat0.clearcoat, mat0.emissive, mat0.subsurface,
				) ).toVar();
				const si0 = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo( mat0, bounceIdx, mc0 ) ).toVar();
				const pdf0d = evaluateCombinedLobePdf( V0, N0, mat0, wd, si0 ).toVar();

				If( r.matIdx1.equal( float( GI_MAT_ENV ) ), () => {

					// env: triIdx1 lane carries the stored envPdf (direction parallax-stable to the 1e5-far
					// x1). envPdf==0 ⇔ env-IS off at capture ⇒ weight 1 (BF parity).
					const envPdf = r.triIdx1;
					const wEnv = select( envPdf.greaterThan( 0.0 ), balanceHeuristic( { pdf1: pdf0d, pdf2: envPdf } ), float( 1.0 ) );
					out.addAssign( Le.mul( wEnv ) );

				} ).Else( () => {

					// emissive hit: BOTH MIS arguments re-derived at the domain (the stored lightPdf would
					// bake d_src²/cosθ_src). Shade's hit-arm convention: flat pdf, powerHeuristic vs prevPdf.
					const lightPdf = calculateEmissiveLightPdf(
						int( r.triIdx1 ), dist, wd, origin0,
						triangleBuffer, materialBuffer, emissiveTotalPower,
					);
					out.addAssign( Le.mul( powerHeuristic( { pdf1: pdf0d, pdf2: lightPdf } ) ) );

				} );

			} );

			// ── f1·B: the suffix re-multiplied by the domain-incidence BSDF at x1 ──
			const B = giB( r ).toVar();
			If( r.matIdx1.greaterThanEqual( 0.0 ).and( luminance( { color: B } ).greaterThan( 0.0 ) ), () => {

				// rebuild x1's material EXACTLY as the walker shaded it: textures sampled with the
				// UNFLIPPED interpolated normal, THEN the perturbed normal flipped toward the domain V1
				// (the hemisphere gate guarantees the domain is on the shaded side, so this matches the
				// walker's source-side flip at the canonical).
				const mat1 = RayTracingMaterial.wrap( getMaterial( int( r.matIdx1 ), materialBuffer ) ).toVar();
				const ms1 = MaterialSamples.wrap( sampleAllMaterialTextures(
					albedoMaps, normalMaps, bumpMaps, metalnessMaps, roughnessMaps, emissiveMaps,
					mat1, vec2( r.uv1x, r.uv1y ), n1u,
				) ).toVar();
				mat1.color.assign( ms1.albedo );
				mat1.metalness.assign( ms1.metalness.clamp( 0.0, 1.0 ) );
				mat1.roughness.assign( ms1.roughness.clamp( 0.05, 1.0 ) );
				mat1.sheenRoughness.assign( mat1.sheenRoughness.clamp( 0.05, 1.0 ) );
				const N1 = ms1.normal.toVar();
				If( dot( N1, V1d ).lessThan( 0.0 ), () => {

					N1.assign( N1.negate() );

				} );
				const f1 = evaluateMaterialResponse( V1d, giOm1( r ), N1, mat1 );
				out.addAssign( f1.mul( B ) );

			} );

		} );

		return out;

	} );

}
