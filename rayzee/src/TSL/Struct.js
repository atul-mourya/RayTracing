import { struct } from './patches.js';

export const Ray = struct( {
	origin: 'vec3',
	direction: 'vec3'
} );

export const RayTracingMaterial = struct( {
	color: 'vec4',
	emissive: 'vec3',
	emissiveIntensity: 'float',
	roughness: 'float',
	metalness: 'float',
	ior: 'float', // Index of refraction
	transmission: 'float', // 0 = opaque, 1 = fully transparent
	thickness: 'float',
	clearcoat: 'float',
	clearcoatRoughness: 'float',
	opacity: 'float',
	transparent: 'bool',
	attenuationColor: 'vec3',
	attenuationDistance: 'float',
	dispersion: 'float',
	sheen: 'float',
	sheenRoughness: 'float',
	sheenColor: 'vec3',
	specularIntensity: 'float',
	specularColor: 'vec3',
	alphaTest: 'float',
	alphaMode: 'int', // 0: OPAQUE, 1: MASK, 2: BLEND
	side: 'int',
	depthWrite: 'int',
	albedoMapIndex: 'int',
	emissiveMapIndex: 'int',
	normalMapIndex: 'int',
	bumpMapIndex: 'int',
	bumpScale: 'float',
	displacementScale: 'float',
	metalnessMapIndex: 'int',
	roughnessMapIndex: 'int',
	displacementMapIndex: 'int',
	normalScale: 'vec2',
	albedoTransform: 'mat3',
	emissiveTransform: 'mat3',
	normalTransform: 'mat3',
	bumpTransform: 'mat3',
	metalnessTransform: 'mat3',
	roughnessTransform: 'mat3',
	displacementTransform: 'mat3',
	iridescence: 'float',
	iridescenceIOR: 'float',
	iridescenceThicknessRange: 'vec2',
} );

// Lightweight material for shadow ray evaluation — only the fields needed
// by traceShadowRay (alpha, transmission, transparency, attenuation).
export const ShadowMaterial = struct( {
	color: 'vec4',
	ior: 'float',
	transmission: 'float',
	attenuationColor: 'vec3',
	attenuationDistance: 'float',
	albedoMapIndex: 'int',
	opacity: 'float',
	transparent: 'bool',
	alphaTest: 'float',
	alphaMode: 'int',
	albedoTransform: 'mat3',
} );

export const Sphere = struct( {
	position: 'vec3',
	radius: 'float',
	material: RayTracingMaterial,
} );

export const HitInfo = struct( {
	didHit: 'bool',
	dst: 'float',
	hitPoint: 'vec3',
	normal: 'vec3',
	uv: 'vec2',
	materialIndex: 'int',
	meshIndex: 'int',
	triangleIndex: 'int',
	boxTests: 'int',
	triTests: 'int',
} );

export const Triangle = struct( {
	posA: 'vec3',
	posB: 'vec3',
	posC: 'vec3',
	uvA: 'vec2',
	uvB: 'vec2',
	uvC: 'vec2',
	normalA: 'vec3',
	normalB: 'vec3',
	normalC: 'vec3',
	material: RayTracingMaterial,
	materialIndex: 'int',
	meshIndex: 'int',
} );

export const Pixel = struct( {
	color: 'vec4',
	samples: 'int',
} );

export const DirectionSample = struct( {
	direction: 'vec3',
	value: 'vec3',
	pdf: 'float',
} );

export const BRDFWeights = struct( {
	specular: 'float',
	diffuse: 'float',
	sheen: 'float',
	clearcoat: 'float',
	transmission: 'float',
	iridescence: 'float',
} );

export const ImportanceSamplingInfo = struct( {
	diffuseImportance: 'float',
	specularImportance: 'float',
	transmissionImportance: 'float',
	clearcoatImportance: 'float',
	envmapImportance: 'float',
} );

export const DotProducts = struct( {
	NoL: 'float', // Normal • Light
	NoV: 'float', // Normal • View
	NoH: 'float', // Normal • Half
	VoH: 'float', // View • Half
	LoH: 'float', // Light • Half
} );

export const MaterialSamples = struct( {
	albedo: 'vec4',
	emissive: 'vec3',
	metalness: 'float',
	roughness: 'float',
	normal: 'vec3',
	hasTextures: 'bool',
} );

export const MaterialClassification = struct( {
	isMetallic: 'bool', // metalness > 0.7
	isRough: 'bool', // roughness > 0.8
	isSmooth: 'bool', // roughness < 0.3
	isTransmissive: 'bool', // transmission > 0.5
	hasClearcoat: 'bool', // clearcoat > 0.5
	isEmissive: 'bool', // has emissive contribution
	complexityScore: 'float', // 0-1 score for material complexity
} );

export const UVCache = struct( {
	albedoUV: 'vec2',
	normalUV: 'vec2',
	metalnessUV: 'vec2',
	emissiveUV: 'vec2',
	bumpUV: 'vec2',
	roughnessUV: 'vec2',

	// Redundancy flags
	normalBumpSameUV: 'bool',
	metalRoughSameUV: 'bool',
	albedoEmissiveSameUV: 'bool',
	allSameUV: 'bool',
} );

// Material cache — precomputed BRDF terms for the current surface hit.
// Fields are split into two groups:
//   1. BRDF evaluation: F0, NoV, diffuseColor, isPurelyDiffuse, alpha, k, alpha2
//   2. BRDF weight calc: invRoughness, metalFactor, iorFactor, maxSheenColor
export const MaterialCache = struct( {
	F0: 'vec3', // Base reflectance
	NoV: 'float', // Normal dot View
	diffuseColor: 'vec3', // Precomputed diffuse color (only for isPurelyDiffuse fast path)
	isPurelyDiffuse: 'bool', // Optimized path flag
	alpha: 'float', // roughness squared
	k: 'float', // Geometry term constant
	alpha2: 'float', // roughness to the fourth power
	// BRDF weight calculation: precomputed shared values
	invRoughness: 'float', // 1.0 - roughness
	metalFactor: 'float', // 0.5 + 0.5 * metalness
	iorFactor: 'float', // min(2.0 / ior, 1.0)
	maxSheenColor: 'float', // max component of sheen color
} );

export const SamplingStrategyWeights = struct( {
	envWeight: 'float',
	specularWeight: 'float',
	diffuseWeight: 'float',
	transmissionWeight: 'float',
	clearcoatWeight: 'float',
	totalWeight: 'float',

	useEnv: 'bool',
	useSpecular: 'bool',
	useDiffuse: 'bool',
	useTransmission: 'bool',
	useClearcoat: 'bool',
} );

// IMPROVEMENT: Dynamic MIS strategy based on material properties
export const MISStrategy = struct( {
	brdfWeight: 'float',
	lightWeight: 'float',
	envWeight: 'float',
	useBRDFSampling: 'bool',
	useLightSampling: 'bool',
	useEnvSampling: 'bool',
} );

// IMPROVEMENT: Multi-layer MIS type aliases and extensions
// Use existing structs with clear naming for multi-lobe MIS
// #define MaterialWeights BRDFWeights
// #define SamplingResult DirectionSample

// Enhanced material weights for multi-lobe sampling
export const MultiLobeWeights = struct( {
	diffuse: 'float',
	specular: 'float',
	clearcoat: 'float',
	transmission: 'float',
	sheen: 'float',
	iridescence: 'float',
	totalWeight: 'float',
} );

// General rendering state (used across all rendering paths)
export const RenderState = struct( {
	traversals: 'int', // Remaining general bounces
	transmissiveTraversals: 'int', // Remaining transmission-specific bounces
	rayType: 'int', // Current ray type (RAY_TYPE_*)
	isPrimaryRay: 'bool', // True only for camera rays (bounceIndex == 0)
	actualBounceDepth: 'int', // True depth without manipulation
} );

export const pathTracerOutputStruct = struct( {
	gColor: 'vec4', // RGB + alpha
	gNormalDepth: 'vec4', // Normal(RGB) + depth(A)
	gAlbedo: 'vec4' // Albedo color + alpha
} );
