/**
 * Materials sub-API — material property updates and texture transforms.
 *
 * Access via `engine.materials`.
 *
 * @example
 * engine.materials.setProperty(0, 'roughness', 0.5);
 * engine.materials.refresh();
 */
export class MaterialsAPI {

	/** @param {import('../PathTracerApp.js').PathTracerApp} app */
	constructor( app ) {

		this._app = app;

	}

	/**
	 * Updates a single material property and triggers emissive rebuild if needed.
	 * @param {number} materialIndex
	 * @param {string} property
	 * @param {*} value
	 */
	setProperty( materialIndex, property, value ) {

		this._app.updateMaterialProperty( materialIndex, property, value );

	}

	/**
	 * Updates a material's texture transform (offset, repeat, rotation).
	 * @param {number} materialIndex
	 * @param {string} textureName
	 * @param {Object} transform
	 */
	setTextureTransform( materialIndex, textureName, transform ) {

		this._app.updateTextureTransform( materialIndex, textureName, transform );

	}

	/**
	 * Re-uploads all material data to the GPU.
	 */
	refresh() {

		this._app.refreshMaterial();

	}

	/**
	 * Replaces a material entirely.
	 * @param {number} materialIndex
	 * @param {import('three').Material} material
	 */
	replace( materialIndex, material ) {

		this._app.updateMaterial( materialIndex, material );

	}

	/**
	 * Full material rebuild (required after texture changes).
	 * @param {import('three').Scene} [scene]
	 */
	async rebuild( scene ) {

		await this._app.rebuildMaterials( scene );

	}

}
