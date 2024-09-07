import { Vector3, Vector2, Color } from "three";
import BVHBuilder from './BVHBuilder.js';
import TextureCreator from './TextureCreator.js';
import GeometryExtractor from './GeometryExtractor.js';
export default class TriangleSDF {

	constructor( object ) {

		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.directionalLights = [];
		this.spheres = [];

		this.geometryExtractor = new GeometryExtractor();
		this.bvhBuilder = new BVHBuilder();
		this.textureCreator = new TextureCreator();

		this.extractGeometryData( object );
		this.buildBVH();
		this.createTextures();
		this.spheres = this.createSpheres();
		// this.triangles = []; // Clear the original triangle array as we've rebuilt it in the BVH

	}

	extractGeometryData( object ) {

		const extractedData = this.geometryExtractor.extract( object );
		this.triangles = extractedData.triangles;
		this.materials = extractedData.materials;
		this.maps = extractedData.maps;
		this.directionalLights = extractedData.directionalLights;

	}

	buildBVH() {

		this.bvhRoot = this.bvhBuilder.build( this.triangles );

	}

	createTextures() {

		this.materialTexture = this.textureCreator.createMaterialDataTexture( this.materials );
		this.triangleTexture = this.textureCreator.createTriangleDataTexture( this.triangles );
		this.diffuseTextures = this.textureCreator.createAlbedoDataTexture( this.maps );
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

	dispose() {

		this.triangles = [];
		this.materials = [];
		this.maps = [];
		this.materialTexture.dispose();
		this.triangleTexture.dispose();
		this.diffuseTextures.dispose();
		this.bvhTexture.dispose();
		this.spheres = [];

	}

}
