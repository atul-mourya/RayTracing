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
import { TEXTURE_CONSTANTS } from '../../Constants.js';

const PIXELS_PER_MATERIAL = 27;

export class MaterialDataManager {

	/**
	 * @param {Object} sdfs - TriangleSDF instance (for geometryExtractor & sceneFeatures)
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
		 * @type {{ onReset?: Function, onFeaturesChanged?: Function }}
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
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const stride = materialIndex * dataLengthPerMaterial;

		switch ( property ) {

			case 'color':
				if ( value.r !== undefined ) {

					data[ stride + 0 ] = value.r;
					data[ stride + 1 ] = value.g;
					data[ stride + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 0 ] = value[ 0 ];
					data[ stride + 1 ] = value[ 1 ];
					data[ stride + 2 ] = value[ 2 ];

				}

				break;
			case 'metalness': data[ stride + 3 ] = value; break;
			case 'emissive':
				if ( value.r !== undefined ) {

					data[ stride + 4 ] = value.r;
					data[ stride + 5 ] = value.g;
					data[ stride + 6 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 4 ] = value[ 0 ];
					data[ stride + 5 ] = value[ 1 ];
					data[ stride + 6 ] = value[ 2 ];

				}

				break;
			case 'roughness': data[ stride + 7 ] = value; break;
			case 'ior': data[ stride + 8 ] = value; break;
			case 'transmission': data[ stride + 9 ] = value; break;
			case 'thickness': data[ stride + 10 ] = value; break;
			case 'emissiveIntensity': data[ stride + 11 ] = value; break;
			case 'attenuationColor':
				if ( value.r !== undefined ) {

					data[ stride + 12 ] = value.r;
					data[ stride + 13 ] = value.g;
					data[ stride + 14 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 12 ] = value[ 0 ];
					data[ stride + 13 ] = value[ 1 ];
					data[ stride + 14 ] = value[ 2 ];

				}

				break;
			case 'attenuationDistance': data[ stride + 15 ] = value; break;
			case 'dispersion': data[ stride + 16 ] = value; break;
			case 'visible': data[ stride + 17 ] = value; break;
			case 'sheen': data[ stride + 18 ] = value; break;
			case 'sheenRoughness': data[ stride + 19 ] = value; break;
			case 'sheenColor':
				if ( value.r !== undefined ) {

					data[ stride + 20 ] = value.r;
					data[ stride + 21 ] = value.g;
					data[ stride + 22 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 20 ] = value[ 0 ];
					data[ stride + 21 ] = value[ 1 ];
					data[ stride + 22 ] = value[ 2 ];

				}

				break;
			case 'specularIntensity': data[ stride + 24 ] = value; break;
			case 'specularColor':
				if ( value.r !== undefined ) {

					data[ stride + 25 ] = value.r;
					data[ stride + 26 ] = value.g;
					data[ stride + 27 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + 25 ] = value[ 0 ];
					data[ stride + 26 ] = value[ 1 ];
					data[ stride + 27 ] = value[ 2 ];

				}

				break;
			case 'iridescence': data[ stride + 28 ] = value; break;
			case 'iridescenceIOR': data[ stride + 29 ] = value; break;
			case 'iridescenceThicknessRange':
				if ( Array.isArray( value ) ) {

					data[ stride + 30 ] = value[ 0 ];
					data[ stride + 31 ] = value[ 1 ];

				}

				break;
			case 'clearcoat': data[ stride + 38 ] = value; break;
			case 'clearcoatRoughness': data[ stride + 39 ] = value; break;
			case 'opacity': data[ stride + 40 ] = value; break;
			case 'side': data[ stride + 41 ] = value; break;
			case 'transparent': data[ stride + 42 ] = value; break;
			case 'alphaTest': data[ stride + 43 ] = value; break;
			case 'alphaMode': data[ stride + 44 ] = value; break;
			case 'depthWrite': data[ stride + 45 ] = value; break;
			case 'normalScale':
				if ( value.x !== undefined ) {

					data[ stride + 46 ] = value.x;
					data[ stride + 47 ] = value.y;

				} else if ( typeof value === 'number' ) {

					data[ stride + 46 ] = value;
					data[ stride + 47 ] = value;

				}

				break;
			case 'bumpScale': data[ stride + 48 ] = value; break;
			case 'displacementScale': data[ stride + 49 ] = value; break;
			default:
				console.warn( `Unknown material property: ${property}` );
				return;

		}

		this.materialStorageAttr.needsUpdate = true;

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
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const stride = materialIndex * dataLengthPerMaterial;

		if ( materialData.color ) {

			data[ stride + 0 ] = materialData.color.r ?? materialData.color[ 0 ] ?? 1;
			data[ stride + 1 ] = materialData.color.g ?? materialData.color[ 1 ] ?? 1;
			data[ stride + 2 ] = materialData.color.b ?? materialData.color[ 2 ] ?? 1;

		}

		data[ stride + 3 ] = materialData.metalness ?? 0;

		if ( materialData.emissive ) {

			data[ stride + 4 ] = materialData.emissive.r ?? materialData.emissive[ 0 ] ?? 0;
			data[ stride + 5 ] = materialData.emissive.g ?? materialData.emissive[ 1 ] ?? 0;
			data[ stride + 6 ] = materialData.emissive.b ?? materialData.emissive[ 2 ] ?? 0;

		}

		data[ stride + 7 ] = materialData.roughness ?? 1;
		data[ stride + 8 ] = materialData.ior ?? 1.5;
		data[ stride + 9 ] = materialData.transmission ?? 0;
		data[ stride + 10 ] = materialData.thickness ?? 0.1;
		data[ stride + 11 ] = materialData.emissiveIntensity ?? 1;

		if ( materialData.attenuationColor ) {

			data[ stride + 12 ] = materialData.attenuationColor.r ?? materialData.attenuationColor[ 0 ] ?? 1;
			data[ stride + 13 ] = materialData.attenuationColor.g ?? materialData.attenuationColor[ 1 ] ?? 1;
			data[ stride + 14 ] = materialData.attenuationColor.b ?? materialData.attenuationColor[ 2 ] ?? 1;

		}

		data[ stride + 15 ] = materialData.attenuationDistance ?? Infinity;
		data[ stride + 16 ] = materialData.dispersion ?? 0;
		data[ stride + 17 ] = materialData.visible ?? 1;
		data[ stride + 18 ] = materialData.sheen ?? 0;
		data[ stride + 19 ] = materialData.sheenRoughness ?? 1;

		if ( materialData.sheenColor ) {

			data[ stride + 20 ] = materialData.sheenColor.r ?? materialData.sheenColor[ 0 ] ?? 0;
			data[ stride + 21 ] = materialData.sheenColor.g ?? materialData.sheenColor[ 1 ] ?? 0;
			data[ stride + 22 ] = materialData.sheenColor.b ?? materialData.sheenColor[ 2 ] ?? 0;

		}

		data[ stride + 24 ] = materialData.specularIntensity ?? 1;

		if ( materialData.specularColor ) {

			data[ stride + 25 ] = materialData.specularColor.r ?? materialData.specularColor[ 0 ] ?? 1;
			data[ stride + 26 ] = materialData.specularColor.g ?? materialData.specularColor[ 1 ] ?? 1;
			data[ stride + 27 ] = materialData.specularColor.b ?? materialData.specularColor[ 2 ] ?? 1;

		}

		data[ stride + 28 ] = materialData.iridescence ?? 0;
		data[ stride + 29 ] = materialData.iridescenceIOR ?? 1.3;

		if ( materialData.iridescenceThicknessRange ) {

			data[ stride + 30 ] = materialData.iridescenceThicknessRange[ 0 ] ?? 100;
			data[ stride + 31 ] = materialData.iridescenceThicknessRange[ 1 ] ?? 400;

		}

		data[ stride + 32 ] = materialData.map ?? - 1;
		data[ stride + 33 ] = materialData.normalMap ?? - 1;
		data[ stride + 34 ] = materialData.roughnessMap ?? - 1;
		data[ stride + 35 ] = materialData.metalnessMap ?? - 1;
		data[ stride + 36 ] = materialData.emissiveMap ?? - 1;
		data[ stride + 37 ] = materialData.bumpMap ?? - 1;

		data[ stride + 38 ] = materialData.clearcoat ?? 0;
		data[ stride + 39 ] = materialData.clearcoatRoughness ?? 0;
		data[ stride + 40 ] = materialData.opacity ?? 1;
		data[ stride + 41 ] = materialData.side ?? 0;
		data[ stride + 42 ] = materialData.transparent ?? 0;
		data[ stride + 43 ] = materialData.alphaTest ?? 0;
		data[ stride + 44 ] = materialData.alphaMode ?? 0;
		data[ stride + 45 ] = materialData.depthWrite ?? 1;
		data[ stride + 46 ] = materialData.normalScale?.x ?? ( typeof materialData.normalScale === 'number' ? materialData.normalScale : 1 );
		data[ stride + 47 ] = materialData.normalScale?.y ?? ( typeof materialData.normalScale === 'number' ? materialData.normalScale : 1 );
		data[ stride + 48 ] = materialData.bumpScale ?? 1;
		data[ stride + 49 ] = materialData.displacementScale ?? 1;
		data[ stride + 50 ] = materialData.displacementMap ?? - 1;

		// Texture transformation matrices (9 floats each, identity if missing)
		const identity = [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ];
		const transformEntries = [
			{ key: 'mapMatrix', offset: 52 },
			{ key: 'normalMapMatrices', offset: 60 },
			{ key: 'roughnessMapMatrices', offset: 68 },
			{ key: 'metalnessMapMatrices', offset: 76 },
			{ key: 'emissiveMapMatrices', offset: 84 },
			{ key: 'bumpMapMatrices', offset: 92 },
			{ key: 'displacementMapMatrices', offset: 100 }
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

		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const data = this.materialStorageAttr.array;
		const stride = materialIndex * dataLengthPerMaterial;

		const transformOffsets = {
			'map': 52,
			'normalMap': 60,
			'roughnessMap': 68,
			'metalnessMap': 76,
			'emissiveMap': 84,
			'bumpMap': 92,
			'displacementMap': 100
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
		const pixelsRequired = TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL;
		const dataInEachPixel = TEXTURE_CONSTANTS.RGBA_COMPONENTS;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
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

			const stride = i * dataLengthPerMaterial;

			const transmission = data[ stride + 9 ];
			const dispersion = data[ stride + 16 ];
			const sheen = data[ stride + 18 ];
			const iridescence = data[ stride + 28 ];
			const clearcoat = data[ stride + 38 ];
			const opacity = data[ stride + 40 ];
			const transparent = data[ stride + 42 ];
			const alphaTest = data[ stride + 43 ];

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
