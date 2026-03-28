// Light BVH Sampling - GPU-side stochastic Light BVH traversal
// Single-path descent: at each inner node pick left or right proportional to power/dist²

import {
	Fn,
	vec2,
	vec3,
	float,
	int,
	bool as tslBool,
	If,
	Loop,
	Break,
	dot,
	sqrt,
	max,
	normalize,
	cross,
	length,
} from 'three/tsl';
import { MIN_PDF } from './Common.js';
import { RandomValue } from './Random.js';
import {
	EmissiveSample,
	sampleTriangle,
	interpolateNormal,
	fetchTriangleData,
	TriangleData,
	sampleSphericalTriangle,
	barycentricFromPoint,
	useSphericalSampling,
	SphericalTriangleSampleResult,
} from './EmissiveSampling.js';

// Number of TSL structs / layout constants
const LBVH_STRIDE = 4; // 4 vec4s per node
const EMISSIVE_STRIDE = 2; // 2 vec4s per emissive entry (matches EmissiveSampling.js)
const MAX_LBVH_DEPTH = 32;

/**
 * Sample one emissive triangle using the Light BVH for spatially-aware importance sampling.
 *
 * Tree descent:
 *   - Start at root (nodeIndex = 0)
 *   - At each inner node: pick child proportional to childPower / max(dist²_to_child_center, 0.01)
 *   - At leaf: pick one triangle proportional to its power
 *   - Accumulate selection PDF as product of per-level probabilities
 *
 * Returns an EmissiveSample struct.
 */
export const sampleLightBVHTriangle = Fn( ( [
	hitPoint, surfaceNormal,
	rngState,
	lbvhBuffer,
	emissiveTriangleBuffer,
	triangleBuffer,
] ) => {

	const result = EmissiveSample( {
		position: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		emission: vec3( 0.0 ),
		direction: vec3( 0.0 ),
		distance: float( 0.0 ),
		pdf: float( 0.0 ),
		area: float( 0.0 ),
		cosThetaLight: float( 0.0 ),
		valid: false,
	} ).toVar();

	// Accumulated selection PDF (product of per-level choice probabilities)
	const selectionPdf = float( 1.0 ).toVar();
	const nodeIndex = int( 0 ).toVar();
	const foundLeaf = tslBool( false ).toVar();

	// Tree descent: at most MAX_LBVH_DEPTH iterations
	Loop( MAX_LBVH_DEPTH, () => {

		// Read this node's data (d0 not needed during descent — only at leaf)
		const base = nodeIndex.mul( int( LBVH_STRIDE ) );
		const d1 = lbvhBuffer.element( base.add( int( 1 ) ) ); // [maxX, maxY, maxZ, isLeaf]
		const d2 = lbvhBuffer.element( base.add( int( 2 ) ) ); // [leftChild/emissiveStart, rightChild/emissiveCount, 0, 0]

		const isLeaf = d1.w.greaterThan( 0.5 );

		If( isLeaf, () => {

			foundLeaf.assign( tslBool( true ) );
			Break();

		} );

		// Inner node: compute importance for each child
		const leftChildIdx = int( d2.x );
		const rightChildIdx = int( d2.y );

		// Read left child
		const lBase = leftChildIdx.mul( int( LBVH_STRIDE ) );
		const ld0 = lbvhBuffer.element( lBase ); // [minX, minY, minZ, totalPower]
		const ld1 = lbvhBuffer.element( lBase.add( int( 1 ) ) ); // [maxX, maxY, maxZ, isLeaf]

		// Read right child
		const rBase = rightChildIdx.mul( int( LBVH_STRIDE ) );
		const rd0 = lbvhBuffer.element( rBase ); // [minX, minY, minZ, totalPower]
		const rd1 = lbvhBuffer.element( rBase.add( int( 1 ) ) ); // [maxX, maxY, maxZ, isLeaf]

		// Compute center of each child's AABB
		const lCenter = vec3(
			ld0.x.add( ld1.x ).mul( 0.5 ),
			ld0.y.add( ld1.y ).mul( 0.5 ),
			ld0.z.add( ld1.z ).mul( 0.5 )
		);
		const rCenter = vec3(
			rd0.x.add( rd1.x ).mul( 0.5 ),
			rd0.y.add( rd1.y ).mul( 0.5 ),
			rd0.z.add( rd1.z ).mul( 0.5 )
		);

		// Compute squared distance from hitPoint to each child center
		const lDiff = lCenter.sub( hitPoint );
		const rDiff = rCenter.sub( hitPoint );
		const lDistSq = max( dot( lDiff, lDiff ), float( 0.01 ) );
		const rDistSq = max( dot( rDiff, rDiff ), float( 0.01 ) );

		// Child power
		const lPower = max( ld0.w, float( 0.0 ) );
		const rPower = max( rd0.w, float( 0.0 ) );

		// Importance = power / dist²
		const lImportance = lPower.div( lDistSq );
		const rImportance = rPower.div( rDistSq );
		const totalImportance = lImportance.add( rImportance );

		If( totalImportance.lessThanEqual( float( 0.0 ) ), () => {

			// Both importances zero — fall back to left child (no PDF update)
			nodeIndex.assign( leftChildIdx );

		} ).Else( () => {

			// Probability of choosing left child
			const pLeft = lImportance.div( totalImportance );

			// Sample random value to pick child
			const rand = RandomValue( rngState );

			If( rand.lessThan( pLeft ), () => {

				// Choose left child
				selectionPdf.mulAssign( pLeft );
				nodeIndex.assign( leftChildIdx );

			} ).Else( () => {

				// Choose right child
				selectionPdf.mulAssign( float( 1.0 ).sub( pLeft ) );
				nodeIndex.assign( rightChildIdx );

			} );

		} );

	} );

	// If we found a leaf, sample a triangle from it
	If( foundLeaf, () => {

		const base = nodeIndex.mul( int( LBVH_STRIDE ) );
		const d0 = lbvhBuffer.element( base ); // [minX, minY, minZ, totalPower]
		const d2 = lbvhBuffer.element( base.add( int( 2 ) ) ); // [emissiveStart, emissiveCount, 0, 0]

		const emissiveStart = int( d2.x );
		const emissiveCount = int( d2.y );
		const leafTotalPower = max( d0.w, float( 1e-10 ) );

		// Sample one triangle proportional to power within the leaf
		// Linear scan: pick random threshold against cumulative power sum
		const randLeaf = RandomValue( rngState ).mul( leafTotalPower );
		const cumPower = float( 0.0 ).toVar();

		// Default to last entry as fallback
		const selectedEmissiveIndex = emissiveStart.add( emissiveCount.sub( int( 1 ) ) ).toVar();
		const selectedPower = float( 1e-10 ).toVar();

		Loop( { start: int( 0 ), end: emissiveCount }, ( { i } ) => {

			const entryIdx = emissiveStart.add( i );
			const baseIdx = entryIdx.mul( int( EMISSIVE_STRIDE ) );
			const emData0 = emissiveTriangleBuffer.element( baseIdx );
			const triPower = max( emData0.g, float( 0.0 ) );
			cumPower.addAssign( triPower );

			If( cumPower.greaterThanEqual( randLeaf ).and( triPower.greaterThan( float( 0.0 ) ) ), () => {

				selectedEmissiveIndex.assign( entryIdx );
				selectedPower.assign( triPower );
				Break();

			} );

		} );

		// Incorporate leaf selection PDF: selectedPower / leafTotalPower
		selectionPdf.mulAssign( selectedPower.div( leafTotalPower ) );

		// Now sample the selected triangle (same path as flat CDF sampling)
		const baseIdx = selectedEmissiveIndex.mul( int( EMISSIVE_STRIDE ) );
		const emissiveData0 = emissiveTriangleBuffer.element( baseIdx );
		const emissiveData1 = emissiveTriangleBuffer.element( baseIdx.add( int( 1 ) ) );

		const triangleIndex = int( emissiveData0.r );
		const emission = emissiveData1.xyz;
		const area = emissiveData1.w;

		// Fetch triangle geometry
		const triData = TriangleData.wrap( fetchTriangleData( triangleIndex, triangleBuffer ) );

		// Generate random numbers for point sampling
		const xi_r1 = RandomValue( rngState ).toVar();
		const xi_r2 = RandomValue( rngState ).toVar();
		const xi = vec2( xi_r1, xi_r2 );

		const geoNormal = normalize( cross( triData.v1.sub( triData.v0 ), triData.v2.sub( triData.v0 ) ) );

		// Heuristic: spherical sampling for close/large triangles, area for far/small
		If( useSphericalSampling( triData.v0, triData.v1, triData.v2, hitPoint ), () => {

			// ---- SPHERICAL TRIANGLE SAMPLING (Arvo 1995) ----
			const sphResult = SphericalTriangleSampleResult.wrap(
				sampleSphericalTriangle( triData.v0, triData.v1, triData.v2, hitPoint, xi )
			);

			If( sphResult.valid.and( sphResult.solidAngle.greaterThan( float( 1e-7 ) ) ), () => {

				const dir = sphResult.direction;
				const samplePos = sphResult.position;

				const surfaceFacing = dot( dir, surfaceNormal );
				const emissiveFacing = dot( dir, geoNormal.negate() );

				If( surfaceFacing.greaterThan( float( 0.0 ) ).and( emissiveFacing.greaterThan( float( 0.0 ) ) ), () => {

					// Interpolate normal at sampled point via barycentric coords
					const barycentricCoords = barycentricFromPoint( samplePos, triData.v0, triData.v1, triData.v2 );
					const sampleNormal = normalize(
						triData.n0.mul( barycentricCoords.x )
							.add( triData.n1.mul( barycentricCoords.y ) )
							.add( triData.n2.mul( barycentricCoords.z ) )
					);

					const dist = length( samplePos.sub( hitPoint ) );

					// PDF: selectionPdf / solidAngle (in solid angle measure)
					const pdfSolidAngle = selectionPdf.div( max( sphResult.solidAngle, float( 1e-10 ) ) );

					result.position.assign( samplePos );
					result.normal.assign( sampleNormal );
					result.emission.assign( emission );
					result.direction.assign( dir );
					result.distance.assign( dist );
					result.pdf.assign( max( pdfSolidAngle, MIN_PDF ) );
					result.area.assign( area );
					result.cosThetaLight.assign( emissiveFacing );
					result.valid.assign( true );

				} );

			} );

		} ).Else( () => {

			// ---- AREA SAMPLING (for far/small triangles) ----
			const samplePos = sampleTriangle( triData.v0, triData.v1, triData.v2, xi );
			const sampleNormal = interpolateNormal( triData.n0, triData.n1, triData.n2, xi );

			const toEmissive = samplePos.sub( hitPoint );
			const distSq = dot( toEmissive, toEmissive );
			const dist = sqrt( distSq );
			const dir = toEmissive.div( dist );

			const surfaceFacing = dot( dir, surfaceNormal );
			const emissiveFacing = dot( dir, sampleNormal.negate() );

			If( surfaceFacing.greaterThan( float( 0.0 ) ).and( emissiveFacing.greaterThan( float( 0.0 ) ) ), () => {

				// PDF: selectionPdf / area, converted to solid angle: pdfArea * distSq / cosLight
				const pdfArea = selectionPdf.div( max( area, float( 1e-10 ) ) );
				const pdfSolidAngle = pdfArea.mul( distSq ).div( emissiveFacing );

				result.position.assign( samplePos );
				result.normal.assign( sampleNormal );
				result.emission.assign( emission );
				result.direction.assign( dir );
				result.distance.assign( dist );
				result.pdf.assign( max( pdfSolidAngle, MIN_PDF ) );
				result.area.assign( area );
				result.cosThetaLight.assign( emissiveFacing );
				result.valid.assign( true );

			} );

		} );

	} );

	return result;

} );
