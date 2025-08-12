import { Color } from 'three';

/**
 * Service class for handling material operations
 */
export class MaterialService {

	/**
	 * Create a complete material object with defaults from API data
	 * @param {Object} apiMaterialInfo - Material data from API
	 * @returns {Object} Complete material object with all PBR properties
	 */
	static createCompleteMaterialFromAPI( apiMaterialInfo ) {

		// Default values matching GeometryExtractor's getPhysicalDefaults
		const defaults = {
			color: [ 1, 1, 1 ], // white
			emissive: [ 0, 0, 0 ], // black
			emissiveIntensity: 1.0,
			roughness: 1.0,
			metalness: 0.0,
			ior: 1.5,
			opacity: 1.0,
			transmission: 0.0,
			thickness: 0.1,
			attenuationColor: [ 1, 1, 1 ], // white
			attenuationDistance: Infinity,
			dispersion: 0.0,
			sheen: 0.0,
			sheenRoughness: 1.0,
			sheenColor: [ 0, 0, 0 ], // black
			specularIntensity: 1.0,
			specularColor: [ 1, 1, 1 ], // white
			clearcoat: 0.0,
			clearcoatRoughness: 0.0,
			iridescence: 0.0,
			iridescenceIOR: 1.3,
			iridescenceThicknessRange: [ 100, 400 ],
			visible: 1,
			transparent: 0,
			alphaTest: 0.0,
			side: 0 // FrontSide
		};

		// Create complete material by merging API data with defaults
		const completeMaterial = { ...defaults };

		// Apply API properties if they exist
		if ( apiMaterialInfo.color ) completeMaterial.color = apiMaterialInfo.color;
		if ( typeof apiMaterialInfo.metalness === 'number' ) completeMaterial.metalness = apiMaterialInfo.metalness;
		if ( typeof apiMaterialInfo.roughness === 'number' ) completeMaterial.roughness = Math.max( 0.05, apiMaterialInfo.roughness );
		if ( typeof apiMaterialInfo.ior === 'number' ) completeMaterial.ior = apiMaterialInfo.ior;
		if ( typeof apiMaterialInfo.transmission === 'number' ) completeMaterial.transmission = apiMaterialInfo.transmission;

		// Handle density -> attenuationDistance conversion
		if ( typeof apiMaterialInfo.density === 'number' && apiMaterialInfo.density > 0 ) {

			completeMaterial.attenuationDistance = 1000 / apiMaterialInfo.density;

		}

		// Handle transmission materials - set appropriate properties
		if ( completeMaterial.transmission > 0 ) {

			completeMaterial.transparent = 1;
			completeMaterial.side = 2; // DoubleSide for transmissive materials

			// For transmissive materials, use color as attenuation color
			if ( completeMaterial.color ) {

				completeMaterial.attenuationColor = [ ...completeMaterial.color ];

			}

		}

		// Handle thin film properties
		if ( typeof apiMaterialInfo.thinFilmThickness === 'number' ) {

			completeMaterial.iridescence = 1.0;
			completeMaterial.iridescenceThicknessRange = [ apiMaterialInfo.thinFilmThickness, apiMaterialInfo.thinFilmThickness ];

			if ( typeof apiMaterialInfo.thinFilmIor === 'number' ) {

				completeMaterial.iridescenceIOR = apiMaterialInfo.thinFilmIor;

			}

		}

		return completeMaterial;

	}

	/**
	 * Apply material information to a Three.js material object
	 * @param {Object} materialInfo - Material information from API
	 * @param {Object} threeMaterial - Three.js material object to modify
	 */
	static applyMaterialToObject( materialInfo, threeMaterial ) {

		if ( ! threeMaterial ) {

			console.error( "Invalid material object provided" );
			return;

		}

		// Helper function to ensure property exists and set it
		const ensureAndSet = ( obj, prop, value ) => {

			if ( ! ( prop in obj ) ) {

				// Create the property if it doesn't exist
				obj[ prop ] = value;

			} else {

				obj[ prop ] = value;

			}

		};

		// Helper function for color properties
		const ensureAndSetColor = ( obj, prop, colorArray ) => {

			if ( Array.isArray( colorArray ) && colorArray.length >= 3 ) {

				if ( ! ( prop in obj ) ) {

					// Create Color object if property doesn't exist
					obj[ prop ] = new Color();

				}

				if ( obj[ prop ] && obj[ prop ].setRGB ) {

					obj[ prop ].setRGB( colorArray[ 0 ], colorArray[ 1 ], colorArray[ 2 ] );

				}

			}

		};

		// Create complete material with defaults first
		const completeMaterial = this.createCompleteMaterialFromAPI( materialInfo );

		// Ensure and set all material properties to create a complete PBR material
		// Base colors
		ensureAndSetColor( threeMaterial, 'color', completeMaterial.color );
		ensureAndSetColor( threeMaterial, 'emissive', completeMaterial.emissive );
		ensureAndSetColor( threeMaterial, 'attenuationColor', completeMaterial.attenuationColor );
		ensureAndSetColor( threeMaterial, 'specularColor', completeMaterial.specularColor );
		ensureAndSetColor( threeMaterial, 'sheenColor', completeMaterial.sheenColor );

		// Basic material properties
		ensureAndSet( threeMaterial, 'emissiveIntensity', completeMaterial.emissiveIntensity );
		ensureAndSet( threeMaterial, 'roughness', completeMaterial.roughness );
		ensureAndSet( threeMaterial, 'metalness', completeMaterial.metalness );
		ensureAndSet( threeMaterial, 'ior', completeMaterial.ior );
		ensureAndSet( threeMaterial, 'opacity', completeMaterial.opacity );

		// Transmission properties
		ensureAndSet( threeMaterial, 'transmission', completeMaterial.transmission );
		ensureAndSet( threeMaterial, 'thickness', completeMaterial.thickness );
		ensureAndSet( threeMaterial, 'attenuationDistance', completeMaterial.attenuationDistance );

		// Advanced properties
		ensureAndSet( threeMaterial, 'dispersion', completeMaterial.dispersion );
		ensureAndSet( threeMaterial, 'sheen', completeMaterial.sheen );
		ensureAndSet( threeMaterial, 'sheenRoughness', completeMaterial.sheenRoughness );
		ensureAndSet( threeMaterial, 'specularIntensity', completeMaterial.specularIntensity );
		ensureAndSet( threeMaterial, 'clearcoat', completeMaterial.clearcoat );
		ensureAndSet( threeMaterial, 'clearcoatRoughness', completeMaterial.clearcoatRoughness );

		// Iridescence properties
		ensureAndSet( threeMaterial, 'iridescence', completeMaterial.iridescence );
		ensureAndSet( threeMaterial, 'iridescenceIOR', completeMaterial.iridescenceIOR );
		ensureAndSet( threeMaterial, 'iridescenceThicknessRange', completeMaterial.iridescenceThicknessRange );

		// Rendering properties
		ensureAndSet( threeMaterial, 'transparent', completeMaterial.transparent > 0 );
		ensureAndSet( threeMaterial, 'alphaTest', completeMaterial.alphaTest );
		ensureAndSet( threeMaterial, 'visible', completeMaterial.visible > 0 );

		// Handle side property (convert number to Three.js constants)
		const sideMap = { 0: 0, 1: 1, 2: 2 }; // FrontSide, BackSide, DoubleSide
		ensureAndSet( threeMaterial, 'side', sideMap[ completeMaterial.side ] !== undefined ? sideMap[ completeMaterial.side ] : 0 );

		// Ensure needsUpdate exists and set it
		ensureAndSet( threeMaterial, 'needsUpdate', true );

	}

	/**
	 * Update path tracer with new material properties
	 * @param {Object} selectedObject - The selected object to update
	 */
	static updatePathTracerMaterial( selectedObject ) {

		if ( ! window.pathTracerApp || ! ( selectedObject && selectedObject.material ) ) {

			console.warn( 'PathTracer app or selected object material not available' );
			return;

		}

		// Check if the material index exists
		if ( selectedObject.userData && selectedObject.userData.materialIndex === undefined ) {

			console.warn( 'Material index not found on selected object, using default index 0' );

		}

		const objMaterialIndex = selectedObject.userData && selectedObject.userData.materialIndex !== undefined
			? selectedObject.userData.materialIndex
			: 0;

		// For API materials, we need to use the complete material update (updateMaterial)
		// because API materials only have partial properties
		if ( window.pathTracerApp && window.pathTracerApp.pathTracingPass && window.pathTracerApp.pathTracingPass.updateMaterial ) {

			// Use updateMaterial for complete material reconstruction from API data
			window.pathTracerApp.pathTracingPass.updateMaterial(
				objMaterialIndex,
				selectedObject.material
			);

		} else if ( window.pathTracerApp && window.pathTracerApp.pathTracingPass && window.pathTracerApp.pathTracingPass.rebuildMaterialDataTexture ) {

			// Legacy fallback
			window.pathTracerApp.pathTracingPass.rebuildMaterialDataTexture(
				objMaterialIndex,
				selectedObject.material
			);

		} else {

			console.warn( 'PathTracer material update function not found' );

		}

		// Reset renderer to apply changes
		if ( window.pathTracerApp && window.pathTracerApp.reset ) {

			window.pathTracerApp.reset();

		}

	}

}
