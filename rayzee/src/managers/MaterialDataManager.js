/**
 * MaterialDataManager.js
 * Manages material storage buffers, property read/write, texture arrays,
 * and feature scanning for the path tracing pipeline.
 *
 * Storage buffer nodes are created once and never replaced — only .value
 * is mutated to preserve TSL shader graph references after compilation.
 */

import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { storage } from 'three/tsl';
import { MATERIAL_DATA_LAYOUT as M, TRIANGLE_DATA_LAYOUT as T } from '../EngineDefaults.js';

const PIXELS_PER_MATERIAL = M.SLOTS_PER_MATERIAL;
// Per-triangle float offsets used by _patchTriangleSideForMaterial / _patchTriangleBlockerForMaterial.
const TRI_MAT_IDX_OFFSET = T.UV_C_MAT_OFFSET + 2; // uvData2.z in shader
const TRI_SIDE_OFFSET = T.NORMAL_C_OFFSET + 3; // normalCData.w in shader
const TRI_BLOCKER_OFFSET = T.NORMAL_A_OFFSET + 3; // nA.w in shader (opaque-blocker fast path)

// Material properties that affect the shadow-ray opaque-blocker flag.
const BLOCKER_PROPS = new Set( [ 'transmission', 'transparent', 'opacity', 'alphaMode' ] );

export class MaterialDataManager {

	/**
	 * @param {Object} sdfs - SceneProcessor instance (for geometryExtractor & sceneFeatures)
	 */
	constructor( sdfs ) {

		this.sdfs = sdfs;

		// Material storage buffer
		this.materialStorageAttr = null;
		this.materialStorageNode = null;
		this.materialCount = 0;

		// Material texture arrays
		this.albedoMaps = null;
		this.emissiveMaps = null;
		this.normalMaps = null;
		this.bumpMaps = null;
		this.roughnessMaps = null;
		this.metalnessMaps = null;
		this.displacementMaps = null;

		// Compiled features cache (for change detection)
		this.compiledFeatures = null;

		/**
		 * Optional callbacks set by the owning stage.
		 * @type {{ onReset?: Function, onFeaturesChanged?: Function, getTriangleData?: Function, onTriangleDataChanged?: Function }}
		 */
		this.callbacks = {};

	}

	// ===== STORAGE BUFFER MANAGEMENT =====

	/**
	 * Sets material data from raw Float32Array via storage buffer.
	 * @param {Float32Array} matImageData
	 */
	setMaterialData( matImageData ) {

		if ( ! matImageData ) return;

		const vec4Count = matImageData.length / 4;

		if ( this.materialStorageNode ) {

			this.materialStorageAttr = new StorageInstancedBufferAttribute( matImageData, 4 );
			this.materialStorageNode.value = this.materialStorageAttr;
			this.materialStorageNode.bufferCount = vec4Count;

		} else {

			this.materialStorageAttr = new StorageInstancedBufferAttribute( matImageData, 4 );
			this.materialStorageNode = storage( this.materialStorageAttr, 'vec4', vec4Count ).toReadOnly();

		}

		this.materialCount = Math.floor( vec4Count / PIXELS_PER_MATERIAL );
		console.log( `MaterialDataManager: ${this.materialCount} materials (storage buffer)` );

	}

	/**
	 * Get the material storage attribute (for dependent stages).
	 * @returns {StorageInstancedBufferAttribute|null}
	 */
	getStorageAttr() {

		return this.materialStorageAttr;

	}

	/**
	 * Get the material storage node (for shader graph).
	 * @returns {import('three/tsl').StorageNode|null}
	 */
	getStorageNode() {

		return this.materialStorageNode;

	}

	// ===== TEXTURE ARRAYS =====

	/**
	 * Bulk-assign material texture array references.
	 * @param {Object} textures
	 */
	setMaterialTextures( textures ) {

		if ( textures.albedoMaps ) this.albedoMaps = textures.albedoMaps;
		if ( textures.emissiveMaps ) this.emissiveMaps = textures.emissiveMaps;
		if ( textures.normalMaps ) this.normalMaps = textures.normalMaps;
		if ( textures.bumpMaps ) this.bumpMaps = textures.bumpMaps;
		if ( textures.roughnessMaps ) this.roughnessMaps = textures.roughnessMaps;
		if ( textures.metalnessMaps ) this.metalnessMaps = textures.metalnessMaps;
		if ( textures.displacementMaps ) this.displacementMaps = textures.displacementMaps;

	}

	/**
	 * Load texture arrays from sdfs.
	 */
	loadTexturesFromSdfs() {

		this.albedoMaps = this.sdfs.albedoTextures;
		this.emissiveMaps = this.sdfs.emissiveTextures;
		this.normalMaps = this.sdfs.normalTextures;
		this.bumpMaps = this.sdfs.bumpTextures;
		this.roughnessMaps = this.sdfs.roughnessTextures;
		this.metalnessMaps = this.sdfs.metalnessTextures;
		this.displacementMaps = this.sdfs.displacementTextures;

	}

	/**
	 * Get all texture arrays.
	 * @returns {Object}
	 */
	getTextureArrays() {

		return {
			albedoMaps: this.albedoMaps,
			emissiveMaps: this.emissiveMaps,
			normalMaps: this.normalMaps,
			bumpMaps: this.bumpMaps,
			roughnessMaps: this.roughnessMaps,
			metalnessMaps: this.metalnessMaps,
			displacementMaps: this.displacementMaps,
		};

	}

	// ===== MATERIAL PROPERTY UPDATES =====

	/**
	 * Update a single material property in the storage buffer.
	 * @param {number} materialIndex
	 * @param {string} property
	 * @param {*} value
	 */
	updateMaterialProperty( materialIndex, property, value ) {

		if ( ! this.materialStorageAttr ) {

			console.warn( 'Material storage buffer not available' );
			return;

		}

		const data = this.materialStorageAttr.array;
		const stride = materialIndex * M.FLOATS_PER_MATERIAL;

		switch ( property ) {

			case 'color':
				if ( value.r !== undefined ) {

					data[ stride + M.COLOR ] = value.r;
					data[ stride + M.COLOR + 1 ] = value.g;
					data[ stride + M.COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.COLOR ] = value[ 0 ];
					data[ stride + M.COLOR + 1 ] = value[ 1 ];
					data[ stride + M.COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'metalness': data[ stride + M.METALNESS ] = value; break;
			case 'emissive':
				if ( value.r !== undefined ) {

					data[ stride + M.EMISSIVE ] = value.r;
					data[ stride + M.EMISSIVE + 1 ] = value.g;
					data[ stride + M.EMISSIVE + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.EMISSIVE ] = value[ 0 ];
					data[ stride + M.EMISSIVE + 1 ] = value[ 1 ];
					data[ stride + M.EMISSIVE + 2 ] = value[ 2 ];

				}

				break;
			case 'roughness': data[ stride + M.ROUGHNESS ] = value; break;
			case 'ior': data[ stride + M.IOR ] = value; break;
			case 'transmission': data[ stride + M.TRANSMISSION ] = value; break;
			case 'thickness': data[ stride + M.THICKNESS ] = value; break;
			case 'emissiveIntensity': data[ stride + M.EMISSIVE_INTENSITY ] = value; break;
			case 'attenuationColor':
				if ( value.r !== undefined ) {

					data[ stride + M.ATTENUATION_COLOR ] = value.r;
					data[ stride + M.ATTENUATION_COLOR + 1 ] = value.g;
					data[ stride + M.ATTENUATION_COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.ATTENUATION_COLOR ] = value[ 0 ];
					data[ stride + M.ATTENUATION_COLOR + 1 ] = value[ 1 ];
					data[ stride + M.ATTENUATION_COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'attenuationDistance': data[ stride + M.ATTENUATION_DISTANCE ] = value; break;
			case 'dispersion': data[ stride + M.DISPERSION ] = value; break;
			case 'sheen': data[ stride + M.SHEEN ] = value; break;
			case 'sheenRoughness': data[ stride + M.SHEEN_ROUGHNESS ] = value; break;
			case 'sheenColor':
				if ( value.r !== undefined ) {

					data[ stride + M.SHEEN_COLOR ] = value.r;
					data[ stride + M.SHEEN_COLOR + 1 ] = value.g;
					data[ stride + M.SHEEN_COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.SHEEN_COLOR ] = value[ 0 ];
					data[ stride + M.SHEEN_COLOR + 1 ] = value[ 1 ];
					data[ stride + M.SHEEN_COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'specularIntensity': data[ stride + M.SPECULAR_INTENSITY ] = value; break;
			case 'specularColor':
				if ( value.r !== undefined ) {

					data[ stride + M.SPECULAR_COLOR ] = value.r;
					data[ stride + M.SPECULAR_COLOR + 1 ] = value.g;
					data[ stride + M.SPECULAR_COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.SPECULAR_COLOR ] = value[ 0 ];
					data[ stride + M.SPECULAR_COLOR + 1 ] = value[ 1 ];
					data[ stride + M.SPECULAR_COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'iridescence': data[ stride + M.IRIDESCENCE ] = value; break;
			case 'iridescenceIOR': data[ stride + M.IRIDESCENCE_IOR ] = value; break;
			case 'iridescenceThicknessRange':
				if ( Array.isArray( value ) ) {

					data[ stride + M.IRIDESCENCE_THICKNESS_RANGE ] = value[ 0 ];
					data[ stride + M.IRIDESCENCE_THICKNESS_RANGE + 1 ] = value[ 1 ];

				}

				break;
			case 'clearcoat': data[ stride + M.CLEARCOAT ] = value; break;
			case 'clearcoatRoughness': data[ stride + M.CLEARCOAT_ROUGHNESS ] = value; break;
			case 'opacity': data[ stride + M.OPACITY ] = value; break;
			case 'side': data[ stride + M.SIDE ] = value;
				// Side is also mirrored into per-triangle data (NORMAL_C.w) so BVH
				// traversal can do side culling without reading the material buffer.
				this._patchTriangleSideForMaterial( materialIndex, value );
				break;
			case 'transparent': data[ stride + M.TRANSPARENT ] = value; break;
			case 'alphaTest': data[ stride + M.ALPHA_TEST ] = value; break;
			case 'alphaMode': data[ stride + M.ALPHA_MODE ] = value; break;
			case 'depthWrite': data[ stride + M.DEPTH_WRITE ] = value; break;
			case 'normalScale':
				if ( value.x !== undefined ) {

					data[ stride + M.NORMAL_SCALE ] = value.x;
					data[ stride + M.NORMAL_SCALE + 1 ] = value.y;

				} else if ( typeof value === 'number' ) {

					data[ stride + M.NORMAL_SCALE ] = value;
					data[ stride + M.NORMAL_SCALE + 1 ] = value;

				}

				break;
			case 'bumpScale': data[ stride + M.BUMP_SCALE ] = value; break;
			case 'displacementScale': data[ stride + M.DISPLACEMENT_SCALE ] = value; break;
			default:
				console.warn( `Unknown material property: ${property}` );
				return;

		}

		this.materialStorageAttr.needsUpdate = true;

		// Recompute triangle-data opaque-blocker flag when any input to it changes.
		if ( BLOCKER_PROPS.has( property ) ) {

			this._recomputeOpaqueBlockerForMaterial( materialIndex );

		}

		const featureProperties = [ 'transmission', 'clearcoat', 'sheen', 'iridescence', 'dispersion', 'transparent', 'opacity', 'alphaTest' ];
		if ( featureProperties.includes( property ) ) {

			const featuresChanged = this.rescanMaterialFeatures();
			if ( featuresChanged ) {

				this._notifyFeaturesChanged();

			}

		}

		this._notifyReset();

	}

	/**
	 * Bulk-load an entire material object's data into the storage buffer.
	 * @param {number} materialIndex
	 * @param {Object} materialData
	 */
	updateMaterialDataFromObject( materialIndex, materialData ) {

		if ( ! this.materialStorageAttr ) {

			console.warn( 'Material storage buffer not available' );
			return;

		}

		const data = this.materialStorageAttr.array;
		const stride = materialIndex * M.FLOATS_PER_MATERIAL;

		if ( materialData.color ) {

			data[ stride + M.COLOR ] = materialData.color.r ?? materialData.color[ 0 ] ?? 1;
			data[ stride + M.COLOR + 1 ] = materialData.color.g ?? materialData.color[ 1 ] ?? 1;
			data[ stride + M.COLOR + 2 ] = materialData.color.b ?? materialData.color[ 2 ] ?? 1;

		}

		data[ stride + M.METALNESS ] = materialData.metalness ?? 0;

		if ( materialData.emissive ) {

			data[ stride + M.EMISSIVE ] = materialData.emissive.r ?? materialData.emissive[ 0 ] ?? 0;
			data[ stride + M.EMISSIVE + 1 ] = materialData.emissive.g ?? materialData.emissive[ 1 ] ?? 0;
			data[ stride + M.EMISSIVE + 2 ] = materialData.emissive.b ?? materialData.emissive[ 2 ] ?? 0;

		}

		data[ stride + M.ROUGHNESS ] = materialData.roughness ?? 1;
		data[ stride + M.IOR ] = materialData.ior ?? 1.5;
		data[ stride + M.TRANSMISSION ] = materialData.transmission ?? 0;
		data[ stride + M.THICKNESS ] = materialData.thickness ?? 0.1;
		data[ stride + M.EMISSIVE_INTENSITY ] = materialData.emissiveIntensity ?? 1;

		if ( materialData.attenuationColor ) {

			data[ stride + M.ATTENUATION_COLOR ] = materialData.attenuationColor.r ?? materialData.attenuationColor[ 0 ] ?? 1;
			data[ stride + M.ATTENUATION_COLOR + 1 ] = materialData.attenuationColor.g ?? materialData.attenuationColor[ 1 ] ?? 1;
			data[ stride + M.ATTENUATION_COLOR + 2 ] = materialData.attenuationColor.b ?? materialData.attenuationColor[ 2 ] ?? 1;

		}

		data[ stride + M.ATTENUATION_DISTANCE ] = materialData.attenuationDistance ?? Infinity;
		data[ stride + M.DISPERSION ] = materialData.dispersion ?? 0;
		data[ stride + M.VISIBLE ] = 1; // Reserved slot (per-mesh visibility handled at BLAS-pointer level)
		data[ stride + M.SHEEN ] = materialData.sheen ?? 0;
		data[ stride + M.SHEEN_ROUGHNESS ] = materialData.sheenRoughness ?? 1;

		if ( materialData.sheenColor ) {

			data[ stride + M.SHEEN_COLOR ] = materialData.sheenColor.r ?? materialData.sheenColor[ 0 ] ?? 0;
			data[ stride + M.SHEEN_COLOR + 1 ] = materialData.sheenColor.g ?? materialData.sheenColor[ 1 ] ?? 0;
			data[ stride + M.SHEEN_COLOR + 2 ] = materialData.sheenColor.b ?? materialData.sheenColor[ 2 ] ?? 0;

		}

		data[ stride + M.SPECULAR_INTENSITY ] = materialData.specularIntensity ?? 1;

		if ( materialData.specularColor ) {

			data[ stride + M.SPECULAR_COLOR ] = materialData.specularColor.r ?? materialData.specularColor[ 0 ] ?? 1;
			data[ stride + M.SPECULAR_COLOR + 1 ] = materialData.specularColor.g ?? materialData.specularColor[ 1 ] ?? 1;
			data[ stride + M.SPECULAR_COLOR + 2 ] = materialData.specularColor.b ?? materialData.specularColor[ 2 ] ?? 1;

		}

		data[ stride + M.IRIDESCENCE ] = materialData.iridescence ?? 0;
		data[ stride + M.IRIDESCENCE_IOR ] = materialData.iridescenceIOR ?? 1.3;

		if ( materialData.iridescenceThicknessRange ) {

			data[ stride + M.IRIDESCENCE_THICKNESS_RANGE ] = materialData.iridescenceThicknessRange[ 0 ] ?? 100;
			data[ stride + M.IRIDESCENCE_THICKNESS_RANGE + 1 ] = materialData.iridescenceThicknessRange[ 1 ] ?? 400;

		}

		data[ stride + M.ALBEDO_MAP_INDEX ] = materialData.map ?? - 1;
		data[ stride + M.NORMAL_MAP_INDEX ] = materialData.normalMap ?? - 1;
		data[ stride + M.ROUGHNESS_MAP_INDEX ] = materialData.roughnessMap ?? - 1;
		data[ stride + M.METALNESS_MAP_INDEX ] = materialData.metalnessMap ?? - 1;
		data[ stride + M.EMISSIVE_MAP_INDEX ] = materialData.emissiveMap ?? - 1;
		data[ stride + M.BUMP_MAP_INDEX ] = materialData.bumpMap ?? - 1;

		data[ stride + M.CLEARCOAT ] = materialData.clearcoat ?? 0;
		data[ stride + M.CLEARCOAT_ROUGHNESS ] = materialData.clearcoatRoughness ?? 0;
		data[ stride + M.OPACITY ] = materialData.opacity ?? 1;
		data[ stride + M.SIDE ] = materialData.side ?? 0;
		// Mirror side into per-triangle data so BVH traversal avoids a material-buffer read.
		this._patchTriangleSideForMaterial( materialIndex, materialData.side ?? 0 );
		// Recompute shadow-ray opaque-blocker flag (reads alphaMode/transparent/transmission/opacity from buffer).
		this._recomputeOpaqueBlockerForMaterial( materialIndex );
		data[ stride + M.TRANSPARENT ] = materialData.transparent ?? 0;
		data[ stride + M.ALPHA_TEST ] = materialData.alphaTest ?? 0;
		data[ stride + M.ALPHA_MODE ] = materialData.alphaMode ?? 0;
		data[ stride + M.DEPTH_WRITE ] = materialData.depthWrite ?? 1;
		data[ stride + M.NORMAL_SCALE ] = materialData.normalScale?.x ?? ( typeof materialData.normalScale === 'number' ? materialData.normalScale : 1 );
		data[ stride + M.NORMAL_SCALE + 1 ] = materialData.normalScale?.y ?? ( typeof materialData.normalScale === 'number' ? materialData.normalScale : 1 );
		data[ stride + M.BUMP_SCALE ] = materialData.bumpScale ?? 1;
		data[ stride + M.DISPLACEMENT_SCALE ] = materialData.displacementScale ?? 1;
		data[ stride + M.DISPLACEMENT_MAP_INDEX ] = materialData.displacementMap ?? - 1;

		// Texture transformation matrices (9 floats each, identity if missing)
		const identity = [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ];
		const transformEntries = [
			{ key: 'mapMatrix', offset: M.ALBEDO_TRANSFORM },
			{ key: 'normalMapMatrices', offset: M.NORMAL_TRANSFORM },
			{ key: 'roughnessMapMatrices', offset: M.ROUGHNESS_TRANSFORM },
			{ key: 'metalnessMapMatrices', offset: M.METALNESS_TRANSFORM },
			{ key: 'emissiveMapMatrices', offset: M.EMISSIVE_TRANSFORM },
			{ key: 'bumpMapMatrices', offset: M.BUMP_TRANSFORM },
			{ key: 'displacementMapMatrices', offset: M.DISPLACEMENT_TRANSFORM }
		];

		for ( const { key, offset } of transformEntries ) {

			const matrix = materialData[ key ] ?? identity;
			for ( let i = 0; i < 9; i ++ ) {

				if ( stride + offset + i < data.length ) {

					data[ stride + offset + i ] = matrix[ i ];

				}

			}

		}

		this.materialStorageAttr.needsUpdate = true;

		const featuresChanged = this.rescanMaterialFeatures();
		if ( featuresChanged ) {

			this._notifyFeaturesChanged();

		}

		this._notifyReset();

	}

	/**
	 * Convenience wrapper: convert a Three.js Material to data and update storage.
	 * @param {number} materialIndex
	 * @param {import('three').Material} material
	 */
	updateMaterial( materialIndex, material ) {

		const completeMaterialData = this.sdfs.geometryExtractor.createMaterialObject( material );
		this.updateMaterialDataFromObject( materialIndex, completeMaterialData );

	}

	/**
	 * Update texture transform matrix for a material's texture slot.
	 * @param {number} materialIndex
	 * @param {string} textureName
	 * @param {Array<number>} transformMatrix - 9-element matrix
	 */
	updateTextureTransform( materialIndex, textureName, transformMatrix ) {

		if ( ! this.materialStorageAttr ) {

			console.warn( 'Material storage buffer not available' );
			return;

		}

		const data = this.materialStorageAttr.array;
		const stride = materialIndex * M.FLOATS_PER_MATERIAL;

		const transformOffsets = {
			'map': M.ALBEDO_TRANSFORM,
			'normalMap': M.NORMAL_TRANSFORM,
			'roughnessMap': M.ROUGHNESS_TRANSFORM,
			'metalnessMap': M.METALNESS_TRANSFORM,
			'emissiveMap': M.EMISSIVE_TRANSFORM,
			'bumpMap': M.BUMP_TRANSFORM,
			'displacementMap': M.DISPLACEMENT_TRANSFORM
		};

		const offset = transformOffsets[ textureName ];
		if ( offset === undefined ) {

			console.warn( `Unknown texture name for transform update: ${textureName}` );
			return;

		}

		for ( let i = 0; i < 9; i ++ ) {

			if ( stride + offset + i < data.length ) {

				data[ stride + offset + i ] = transformMatrix[ i ];

			}

		}

		this.materialStorageAttr.needsUpdate = true;
		this._notifyReset();

	}

	// ===== FEATURE SCANNING =====

	/**
	 * Scan all materials to detect which advanced features are in use.
	 * @returns {boolean} True if features changed
	 */
	rescanMaterialFeatures() {

		if ( ! this.materialStorageAttr?.array ) {

			console.warn( '[MaterialDataManager] Material storage buffer not available for feature scanning' );
			return false;

		}

		const data = this.materialStorageAttr.array;
		const materialCount = this.sdfs.materialCount || 1;

		const newFeatures = {
			hasClearcoat: false,
			hasTransmission: false,
			hasDispersion: false,
			hasIridescence: false,
			hasSheen: false,
			hasTransparency: false,
			hasMultiLobeMaterials: false,
			hasMRTOutputs: true
		};

		for ( let i = 0; i < materialCount; i ++ ) {

			const stride = i * M.FLOATS_PER_MATERIAL;

			const transmission = data[ stride + M.TRANSMISSION ];
			const dispersion = data[ stride + M.DISPERSION ];
			const sheen = data[ stride + M.SHEEN ];
			const iridescence = data[ stride + M.IRIDESCENCE ];
			const clearcoat = data[ stride + M.CLEARCOAT ];
			const opacity = data[ stride + M.OPACITY ];
			const transparent = data[ stride + M.TRANSPARENT ];
			const alphaTest = data[ stride + M.ALPHA_TEST ];

			if ( clearcoat > 0 ) newFeatures.hasClearcoat = true;
			if ( transmission > 0 ) newFeatures.hasTransmission = true;
			if ( dispersion > 0 ) newFeatures.hasDispersion = true;
			if ( iridescence > 0 ) newFeatures.hasIridescence = true;
			if ( sheen > 0 ) newFeatures.hasSheen = true;
			if ( transparent > 0 || opacity < 1.0 || alphaTest > 0 ) newFeatures.hasTransparency = true;

			const featureCount = [
				clearcoat > 0,
				transmission > 0,
				iridescence > 0,
				sheen > 0
			].filter( Boolean ).length;

			if ( featureCount >= 2 ) {

				newFeatures.hasMultiLobeMaterials = true;

			}

		}

		const oldFeaturesJSON = JSON.stringify( this.sdfs.sceneFeatures );
		const newFeaturesJSON = JSON.stringify( newFeatures );
		const changed = oldFeaturesJSON !== newFeaturesJSON;

		if ( changed ) {

			this.sdfs.sceneFeatures = newFeatures;

		}

		return changed;

	}

	/**
	 * Inject shader preprocessor defines based on detected features.
	 */
	injectMaterialFeatureDefines() {

		const features = this.sdfs.sceneFeatures;

		if ( ! features ) {

			console.warn( '[MaterialDataManager] No sceneFeatures detected, skipping define injection' );
			return;

		}

		const featuresJSON = JSON.stringify( features );
		const featuresChanged = ! this.compiledFeatures || this.compiledFeatures !== featuresJSON;

		if ( ! featuresChanged ) {

			return;

		}

		// For TSL, we can't inject defines into the shader at runtime
		// Instead, we would need to conditionally generate the shader
		// For now, log the features for debugging
		console.log( '[MaterialDataManager] Material features:', features );

		this.compiledFeatures = featuresJSON;

	}

	// ===== PRIVATE CALLBACKS =====

	/** @private */
	_notifyReset() {

		if ( this.callbacks.onReset ) {

			this.callbacks.onReset();

		}

	}

	/** @private */
	_notifyFeaturesChanged() {

		this.injectMaterialFeatureDefines();

	}

	/**
	 * Rewrite the per-triangle `side` flag (NORMAL_C.w) for every triangle whose
	 * materialIndex matches. Linear over triangles because there's no reverse
	 * index — side edits are a rare UI action so the scan cost is acceptable.
	 * @private
	 */
	/**
	 * Re-derive the shadow-ray opaque-blocker flag for a material from its
	 * current buffer values and patch NORMAL_A.w on every matching triangle.
	 * Kept in sync with the blocker definition in GeometryExtractor.
	 * @private
	 */
	_recomputeOpaqueBlockerForMaterial( materialIndex ) {

		const matBuf = this.materialStorageAttr?.array;
		if ( ! matBuf ) return;

		const matStride = materialIndex * M.FLOATS_PER_MATERIAL;
		const alphaMode = matBuf[ matStride + M.ALPHA_MODE ] | 0;
		const transparent = matBuf[ matStride + M.TRANSPARENT ] | 0;
		const transmission = matBuf[ matStride + M.TRANSMISSION ] || 0;
		const opacity = matBuf[ matStride + M.OPACITY ] ?? 1;
		const isOpaqueBlocker = ( alphaMode === 0 && transparent === 0 && transmission === 0 && opacity >= 1 ) ? 1.0 : 0.0;

		this._patchTriangleFlagForMaterial( materialIndex, TRI_BLOCKER_OFFSET, isOpaqueBlocker );

	}

	/**
	 * Generic helper: patch a single per-triangle float at `triOffset` for every
	 * triangle whose materialIndex matches, then fire onTriangleDataChanged.
	 * @private
	 */
	_patchTriangleFlagForMaterial( materialIndex, triOffset, value ) {

		const triInfo = this.callbacks.getTriangleData?.();
		const triData = triInfo?.array;
		const triCount = triInfo?.count | 0;
		if ( ! triData || triCount === 0 ) return;

		const stride = T.FLOATS_PER_TRIANGLE;
		let patched = 0;
		for ( let i = 0; i < triCount; i ++ ) {

			const base = i * stride;
			if ( triData[ base + TRI_MAT_IDX_OFFSET ] === materialIndex ) {

				triData[ base + triOffset ] = value;
				patched ++;

			}

		}

		if ( patched > 0 && this.callbacks.onTriangleDataChanged ) {

			this.callbacks.onTriangleDataChanged();

		}

	}

	_patchTriangleSideForMaterial( materialIndex, sideValue ) {

		this._patchTriangleFlagForMaterial( materialIndex, TRI_SIDE_OFFSET, sideValue );

	}

	// ===== DISPOSAL =====

	dispose() {

		this.materialStorageAttr = null;
		this.materialStorageNode = null;
		this.materialCount = 0;
		this.albedoMaps = null;
		this.emissiveMaps = null;
		this.normalMaps = null;
		this.bumpMaps = null;
		this.roughnessMaps = null;
		this.metalnessMaps = null;
		this.displacementMaps = null;
		this.compiledFeatures = null;

	}

}
