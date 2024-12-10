import { Color } from "three";
import BVHBuilder from './BVHBuilder.js';
import TextureCreator from './TextureCreator.js';
import GeometryExtractor from './GeometryExtractor.js';
import { updateLoading } from '../Processor/utils.js';
export default class TriangleSDF {

	constructor() {

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
		this.cameras = [];

		this.geometryExtractor = null;
		this.bvhBuilder = null;
		this.textureCreator = null;

	}

	async buildBVH( object ) {

		this.geometryExtractor = new GeometryExtractor();
		this.bvhBuilder = new BVHBuilder();
		this.textureCreator = new TextureCreator();
		this.textureCreator.useWorkers = false;

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
		this.cameras = extractedData.cameras;

		let time = performance.now();
		try {

			updateLoading( { status: "Building BVH...", progress: 60 } );
			this.bvhRoot = await this.bvhBuilder.build( this.triangles );

		} catch ( error ) {

			console.error( 'Error building BVH:', error );
			throw error;

		}

		console.log( 'BVH build time:', performance.now() - time );

		time = performance.now();
		updateLoading( { status: "Processing Textures...", progress: 80 } );
		await this.createTextures();
		console.log( 'Texture creation time:', performance.now() - time );
		this.spheres = this.createSpheres();

		this.resetArrays();
		this.geometryExtractor.resetArrays();

		return Promise.resolve( this );

	}

	async createTextures() {

		const params = {
			materials: this.materials,
			triangles: this.triangles,
			maps: this.maps,
			normalMaps: this.normalMaps,
			bumpMaps: this.bumpMaps,
			roughnessMaps: this.roughnessMaps,
			metalnessMaps: this.metalnessMaps,
			emissiveMaps: this.emissiveMaps,
			bvhRoot: this.bvhRoot
		};

		try {

			const textures = await this.textureCreator.createAllTextures( params );

			this.materialTexture = textures.materialTexture;
			this.triangleTexture = textures.triangleTexture;
			this.albedoTextures = textures.albedoTexture;
			this.normalTextures = textures.normalTexture;
			this.bumpTextures = textures.bumpTexture;
			this.roughnessTextures = textures.roughnessTexture;
			this.metalnessTextures = textures.metalnessTexture;
			this.emissiveTextures = textures.emissiveTexture;
			this.bvhTexture = textures.bvhTexture;

		} catch ( error ) {

			console.error( 'Error in parallel texture creation:', error );
			throw error;

		}

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

		const textures = [
			'materialTexture',
			'triangleTexture',
			'albedoTextures',
			'normalTextures',
			'bumpTextures',
			'roughnessTextures',
			'metalnessTextures',
			'emissiveTextures',
			'bvhTexture'
		];

		textures.forEach( textureName => {

			if ( this[ textureName ] ) {

				this[ textureName ].dispose();
				this[ textureName ] = null;

			}

		} );

		this.resetArrays();
		this.spheres = [];

	}

}
