import { Color } from "three";
import BVHBuilder from './BVHBuilder.js';
import TextureCreator from './TextureCreator.js';
import GeometryExtractor from './GeometryExtractor.js';
export default class TriangleSDF {

	constructor( object ) {

		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.directionalLights = [];
		this.spheres = [];

		this.geometryExtractor = new GeometryExtractor();
		this.bvhBuilder = new BVHBuilder();
		this.textureCreator = new TextureCreator();

		this.extractGeometryData( object );
		this.buildBVH();
		this.createTextures();
		this.spheres = this.createSpheres();

		this.resetArrays();
		this.geometryExtractor.resetArrays();

	}

	extractGeometryData( object ) {

		const extractedData = this.geometryExtractor.extract( object );
		this.triangles = extractedData.triangles;
		this.materials = extractedData.materials;
		this.maps = extractedData.maps;
		this.normalMaps = extractedData.normalMaps;
		this.bumpMaps = extractedData.bumpMaps;
		this.roughnessMaps = extractedData.roughnessMaps;
		this.metalnessMaps = extractedData.metalnessMaps;
		this.emissiveMaps = extractedData.emissiveMaps;
		this.directionalLights = extractedData.directionalLights;

	}

	buildBVH() {

		this.bvhRoot = this.bvhBuilder.build( this.triangles );

	}

	createTextures() {

		this.materialTexture = this.textureCreator.createMaterialDataTexture( this.materials );
		this.triangleTexture = this.textureCreator.createTriangleDataTexture( this.triangles );
		this.albedoTextures = this.textureCreator.createTexturesToDataTexture( this.maps );
		this.normalTextures = this.textureCreator.createTexturesToDataTexture( this.normalMaps );
		this.bumpTextures = this.textureCreator.createTexturesToDataTexture( this.bumpMaps );
		this.roughnessTextures = this.textureCreator.createTexturesToDataTexture( this.roughnessMaps );
		this.metalnessTextures = this.textureCreator.createTexturesToDataTexture( this.metalnessMaps );
		this.emissiveTextures = this.textureCreator.createTexturesToDataTexture( this.emissiveMaps );
		this.bvhTexture = this.textureCreator.createBVHDataTexture( this.bvhRoot );

	}


	createSpheres() {

		let white = new Color( 0xffffff );
		let black = new Color( 0x000000 );
		return [
			// { position: new Vector3( - 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( - 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

			// { position: new Vector3( 0, 2, 0 ), radius: 1, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

		];

	}

	resetArrays() {

		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		// this.directionalLights = [];
		// this.spheres = [];

	}

	dispose() {

		this.materialTexture.dispose();
		this.triangleTexture.dispose();
		this.diffuseTextures.dispose();
		this.bvhTexture.dispose();
		this.resetArrays();
		this.spheres = [];

	}

}
