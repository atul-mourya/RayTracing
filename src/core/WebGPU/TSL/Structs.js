import { vec3, float, bool, int } from 'three/tsl';

/**
 * TSL Data Structures for ray tracing.
 * These are helper functions to create structured data in TSL.
 */

/**
 * Creates a ray structure with origin and direction.
 *
 * @param {TSLNode} origin - Ray origin as vec3
 * @param {TSLNode} direction - Ray direction as vec3 (normalized)
 * @returns {Object} Ray object with origin and direction
 */
export const createRay = ( origin, direction ) => ( {
	origin,
	direction
} );

/**
 * Creates an initial hit info structure with default values.
 * Used to track closest intersection during traversal.
 *
 * @returns {Object} HitInfo object with default values
 */
export const createHitInfo = () => ( {
	didHit: bool( false ),
	dst: float( 1e20 ),
	hitPoint: vec3( 0, 0, 0 ),
	normal: vec3( 0, 1, 0 ),
	materialIndex: int( - 1 )
} );

/**
 * Creates a mutable hit info for use in loops.
 * Variables are declared with toVar() for mutability.
 *
 * @returns {Object} Mutable HitInfo with toVar declarations
 */
export const createMutableHitInfo = () => ( {
	didHit: bool( false ).toVar( 'didHit' ),
	dst: float( 1e20 ).toVar( 'closestDst' ),
	hitPoint: vec3( 0, 0, 0 ).toVar( 'hitPoint' ),
	normal: vec3( 0, 1, 0 ).toVar( 'hitNormal' ),
	materialIndex: int( - 1 ).toVar( 'hitMaterial' )
} );

/**
 * Triangle vertex data structure.
 * Matches the TRIANGLE_DATA_LAYOUT from Constants.js.
 */
export const TRIANGLE_OFFSETS = {
	POSITION_A: 0,
	POSITION_B: 1,
	POSITION_C: 2,
	NORMAL_A: 3,
	NORMAL_B: 4,
	NORMAL_C: 5,
	UV_AB: 6,
	UV_C_MAT: 7,
	VEC4_PER_TRIANGLE: 8
};
