self.onmessage = function ( e ) {

	const { materials, DEFAULT_TEXTURE_MATRIX } = e.data;

	try {

		const pixelsRequired = 23;
		const dataInEachPixel = 4;
		const dataLengthPerMaterial = pixelsRequired * dataInEachPixel;
		const totalMaterials = materials.length;
		const totalPixels = pixelsRequired * totalMaterials;

		// Calculate dimensions
		let bestWidth = 4;
		let bestHeight = Math.ceil( totalPixels / 4 );
		let minWaste = bestWidth * bestHeight - totalPixels;

		const maxWidth = Math.ceil( Math.sqrt( totalPixels ) );
		for ( let w = 8; w <= maxWidth; w *= 2 ) {

			const h = Math.ceil( totalPixels / w );
			const waste = w * h - totalPixels;

			if ( waste < minWaste ) {

				bestWidth = w;
				bestHeight = h;
				minWaste = waste;

			}

		}

		bestHeight = Math.pow( 2, Math.ceil( Math.log2( bestHeight ) ) );
		const size = bestWidth * bestHeight * dataInEachPixel;
		const data = new Float32Array( size );

		// Process materials
		for ( let i = 0; i < totalMaterials; i ++ ) {

			const mat = materials[ i ];
			const stride = i * dataLengthPerMaterial;

			const mapMatrix = mat.mapMatrix ?? DEFAULT_TEXTURE_MATRIX;
			const normalMapMatrices = mat.normalMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const roughnessMapMatrices = mat.roughnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const metalnessMapMatrices = mat.metalnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const emissiveMapMatrices = mat.emissiveMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const bumpMapMatrices = mat.bumpMapMatrices ?? DEFAULT_TEXTURE_MATRIX;

			const materialData = [
				mat.color.r, 				mat.color.g, 				mat.color.b, 				mat.metalness,				// pixel 1 - Base color and metalness
				mat.emissive.r, 			mat.emissive.g, 			mat.emissive.b, 			mat.roughness,				// pixel 2 - Emissive and roughness
				mat.ior, 					mat.transmission, 			mat.thickness, 				mat.emissiveIntensity,		// pixel 3 - IOR, transmission, thickness, and emissive intensity
				mat.attenuationColor.r, 	mat.attenuationColor.g, 	mat.attenuationColor.b, 	mat.attenuationDistance,	// pixel 4 - Attenuation color and distance
				mat.dispersion, 			mat.visible, 				mat.sheen, 					mat.sheenRoughness, 		// pixel 5 - Dispersion, sheen, sheen roughness
				mat.sheenColor.r, 			mat.sheenColor.g, 			mat.sheenColor.b, 			1,							// pixel 6 - Sheen color and tint
				mat.specularIntensity, 		mat.specularColor.r, 		mat.specularColor.g, 		mat.specularColor.b,		// pixel 7 - Specular intensity and color
				mat.iridescence, 			mat.iridescenceIOR, 		mat.iridescenceThicknessRange[ 0 ], mat.iridescenceThicknessRange[ 1 ], // pixel 8 - Iridescence properties
				mat.map, 					mat.normalMap, 				mat.roughnessMap, 			mat.metalnessMap,			// pixel 9 - Map indices and properties
				mat.emissiveMap, 			mat.bumpMap, 				mat.clearcoat, 				mat.clearcoatRoughness,		// pixel 10 - More map indices and properties
				mat.opacity, 				mat.side, 					mat.transparent, 			mat.alphaTest,				// pixel 11 - Opacity, side, transparency, and alpha test
				mat.alphaMode, 				mat.depthWrite, 			mat.normalScale?.x ?? 1, 	mat.normalScale?.y ?? 1,	// pixel 12 - Opacity, side, and normal scale
				mapMatrix[ 0 ], 			mapMatrix[ 1 ], 			mapMatrix[ 2 ], 			mapMatrix[ 3 ],				// pixel 13 - Map matrices - 1
				mapMatrix[ 4 ], 			mapMatrix[ 5 ], 			mapMatrix[ 6 ], 			1,							// pixel 14 - Map matrices - 2
				normalMapMatrices[ 0 ], 	normalMapMatrices[ 1 ], 	normalMapMatrices[ 2 ], 	normalMapMatrices[ 3 ],		// pixel 15 - Normal matrices - 1
				normalMapMatrices[ 4 ], 	normalMapMatrices[ 5 ], 	normalMapMatrices[ 6 ], 	1,							// pixel 16 - Normal matrices - 2
				roughnessMapMatrices[ 0 ], 	roughnessMapMatrices[ 1 ], 	roughnessMapMatrices[ 2 ], 	roughnessMapMatrices[ 3 ],	// pixel 17 - Roughness matrices - 1
				roughnessMapMatrices[ 4 ], 	roughnessMapMatrices[ 5 ], 	roughnessMapMatrices[ 6 ], 	1,							// pixel 18 - Roughness matrices - 2
				metalnessMapMatrices[ 0 ], 	metalnessMapMatrices[ 1 ], 	metalnessMapMatrices[ 2 ], 	metalnessMapMatrices[ 3 ], 	// pixel 19 - Metalness matrices - 1
				metalnessMapMatrices[ 4 ], 	metalnessMapMatrices[ 5 ], 	metalnessMapMatrices[ 6 ], 	1,							// pixel 20 - Metalness matrices - 2
				emissiveMapMatrices[ 0 ], 	emissiveMapMatrices[ 1 ], 	emissiveMapMatrices[ 2 ], 	emissiveMapMatrices[ 3 ],	// pixel 21 - Emissive matrices - 1
				emissiveMapMatrices[ 4 ], 	emissiveMapMatrices[ 5 ], 	emissiveMapMatrices[ 6 ], 	1,							// pixel 22 - Emissive matrices - 2
				bumpMapMatrices[ 0 ], 		bumpMapMatrices[ 1 ], 		bumpMapMatrices[ 2 ], 		bumpMapMatrices[ 3 ],		// pixel 23 - Bump map matrices - 1
				bumpMapMatrices[ 4 ], 		bumpMapMatrices[ 5 ],	 	bumpMapMatrices[ 6 ], 		1,							// pixel 24 - Bump map matrices - 2
			];

			data.set( materialData, stride );

		}

		self.postMessage( { data: data.buffer, width: bestWidth, height: bestHeight }, [ data.buffer ] );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
