import {
	Fn,
	float,
	vec3,
	vec4,
	vec2,
	int,
	uint,
	bool,
	max,
	min,
	clamp,
	mix,
	dot,
	normalize,
	length,
	floor,
	fwidth,
	smoothstep,
	If,
	Loop,
	Break,
	struct,
	texture,
	uv,
	color,
	abs,
	greaterThanEqual,
	notEqual,
	reflect
} from 'three/tsl';

import {
	RandomValue,
	getDecorrelatedSeed,
	getStratifiedSample,
} from './Random_v2.js';

import {
	maxComponent,
	minComponent,
	luminance,
	equirectDirectionToUv,
	buildOrthonormalBasis,
	localToWorld,
	fresnelSchlick,
	distributionGGX,
	geometrySmith,
	importanceSampleCosine,
	importanceSampleGGX
} from './Common_v2.js';

import {
	traverseBVH,
} from './BVHTraversal_v2.js';

const PI = Math.PI;
const PI_INV = 1.0 / PI;
const TRI_VEC4_PER_TRIANGLE = 8;
const PIXELS_PER_MATERIAL = 27;

// ================================================================================
// STRUCTS (from your definitions)
// ================================================================================

export const Pixel = struct( {
	color: 'vec4',
	samples: 'int',
} );

export const Ray = struct( {
	origin: 'vec3',
	direction: 'vec3'
} );

export const DirectionSample = struct( {
	direction: 'vec3',
	value: 'vec3',
	pdf: 'float',
} );

export const MaterialClassification = struct( {
	isMetallic: 'bool',
	isRough: 'bool',
	isSmooth: 'bool',
	isTransmissive: 'bool',
	hasClearcoat: 'bool',
	isEmissive: 'bool',
	complexityScore: 'float',
} );

export const BRDFWeights = struct( {
	specular: 'float',
	diffuse: 'float',
	sheen: 'float',
	clearcoat: 'float',
	transmission: 'float',
	iridescence: 'float',
} );

export const MaterialCache = struct( {
	F0: 'vec3',
	NoV: 'float',
	diffuseColor: 'vec3',
	specularColor: 'vec3',
	isMetallic: 'bool',
	isPurelyDiffuse: 'bool',
	hasSpecialFeatures: 'bool',
	alpha: 'float',
	k: 'float',
	alpha2: 'float',
	invRoughness: 'float',
	metalFactor: 'float',
	iorFactor: 'float',
	maxSheenColor: 'float',
} );

export const PathState = struct( {
	brdfWeights: BRDFWeights,
	materialCache: MaterialCache,
	materialClass: MaterialClassification,
	weightsComputed: 'bool',
	classificationCached: 'bool',
	materialCacheCached: 'bool',
	pathImportance: 'float',
	lastMaterialIndex: 'int',
} );

export const pathTracerOutputStruct = struct( {
	gColor: 'vec4',
	gNormalDepth: 'vec4',
	gAlbedo: 'vec4'
} );

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

export const dithering = Fn( ( [ color, seed ] ) => {

	const gridPosition = RandomValue( seed );
	const ditherShiftRGB = vec3( 0.25 / 255.0, - 0.25 / 255.0, 0.25 / 255.0 ).toVar( 'ditherShiftRGB' );
	ditherShiftRGB.assign(
		mix( ditherShiftRGB.mul( 2.0 ), ditherShiftRGB.mul( - 2.0 ), gridPosition )
	);
	return color.add( ditherShiftRGB );

} );

export const computeNDCDepth = Fn( ( [ worldPos, cameraProjectionMatrix, cameraViewMatrix ] ) => {

	const clipPos = cameraProjectionMatrix.mul( cameraViewMatrix ).mul( vec4( worldPos, 1.0 ) );
	const ndcDepth = clipPos.z.div( clipPos.w ).mul( 0.5 ).add( 0.5 );
	return clamp( ndcDepth, 0.0, 1.0 );

} );

const generateRayFromCamera = Fn( ( [ screenPosition, cameraWorldMatrix, cameraProjectionMatrixInverse ] ) => {

	const ndc = screenPosition;
	const clipPos = vec4( ndc.x, ndc.y, float( - 1.0 ), float( 1.0 ) );
	const viewPos = cameraProjectionMatrixInverse.mul( clipPos );
	const viewDir = viewPos.xyz.div( viewPos.w );
	const worldDirRaw = cameraWorldMatrix.mul( vec4( viewDir, 0.0 ) ).xyz;
	const worldDir = worldDirRaw.normalize();
	const worldOrigin = vec3(
		cameraWorldMatrix.element( 3 ).x,
		cameraWorldMatrix.element( 3 ).y,
		cameraWorldMatrix.element( 3 ).z
	);
	return Ray( {
		origin: worldOrigin,
		direction: worldDir
	} );

} );

// ================================================================================
// SIMPLIFIED VERSION - matching your WebGL shader functionality
// ================================================================================

export const pathTracerMain = Fn( ( [
	// Frame/Resolution
	fragCoord, resolution, frame, numRaysPerPixel, visMode,
	// Camera
	cameraWorldMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, cameraProjectionMatrix,
	// Textures
	bvhTex, bvhTexSize,
	triTex, triTexSize,
	matTex, matTexSize,
	envTex,
	// Settings / Uniforms
	hasMaterials, hasEnv, envIntensity, environmentMatrix,
	maxBounces,
	triangleCount,
	// Accumulation
	enableAccumulation, hasPreviousAccumulated, prevAccumTexture, accumulationAlpha, cameraIsMoving,
	// Adaptive Sampling
	useAdaptiveSampling, adaptiveSamplingTexture, adaptiveSamplingMax
] ) => {

	const screenPosition = fragCoord.div( resolution ).mul( 2.0 ).sub( 1.0 ).toVar( 'screenPosition' );

	const baseSeed = getDecorrelatedSeed( fragCoord, int( 0 ), frame ).toVar( 'baseSeed' );
	const samplesCount = int( numRaysPerPixel ).toVar( 'samplesCount' );

	// Output variables - initialized with defaults
	const outColor = vec4( 0.0, 0.0, 0.0, 1.0 ).toVar( 'outColor' );
	const outNormalDepth = vec4( 0.5, 0.5, 1.0, 1.0 ).toVar( 'outNormalDepth' );
	const outAlbedo = vec4( 0.0, 0.0, 0.0, 1.0 ).toVar( 'outAlbedo' );

	// Sample Loop
	// Loop( samplesCount, ( { i: loopRayIndex } ) => {

	const rayIndex = int( 0 );//loopRayIndex;
	const seed = baseSeed.add( uint( rayIndex ) ).toVar( 'seed' );
	const stratifiedJitter = getStratifiedSample( fragCoord, int( rayIndex ), samplesCount, seed, resolution, frame );
	const jitter = stratifiedJitter.sub( 0.5 ).mul( vec2( 2.0 ).div( resolution ) );
	const jitteredScreenPosition = screenPosition.add( jitter );


	const ray = generateRayFromCamera( jitteredScreenPosition, cameraWorldMatrix, cameraProjectionMatrixInverse );
	const rayOrigin = ray.get( 'origin' ).toVar( 'rayOrigin' );
	const rayDir = ray.get( 'direction' ).toVar( 'rayDir' );

	const radiance = vec3( 0.0 ).toVar( 'radiance' );

	// Test: Direct traversal without Loop
	const closestT = float( 1e20 ).toVar( 'closestT' );

	const traversalResult = traverseBVH(
		rayOrigin, rayDir, float( 1e-4 ), closestT,
		bvhTex, bvhTexSize, triTex, triTexSize
	).toVar( 'traversalResult' );

	const hitTriIndex = traversalResult.get( 'triangleIndex' ).toVar( 'hitTriIndex' );

	// Just use the value directly without If
	radiance.addAssign( vec3( float( hitTriIndex ).div( 100.0 ) ) );

	// Set output color from path tracing result
	outColor.assign( vec4( radiance.x, radiance.y, radiance.z, 1.0 ) );
	outNormalDepth.assign( vec4( 1 ) );
	outAlbedo.assign( vec4( 1 ) );

	// Single return at the end - no early returns inside If blocks
	return pathTracerOutputStruct( {
		gColor: outColor,
		gNormalDepth: outNormalDepth,
		gAlbedo: outAlbedo
	} );

} );
