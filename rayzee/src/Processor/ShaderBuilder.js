/**
 * ShaderBuilder.js — shared scene texture-node factory for the path tracer.
 *
 * Creates the texture/storage nodes the wavefront kernels read (environment, material map
 * arrays, previous-frame MRT, adaptive-sampling, gobo/IES) and configures the module-level
 * shadow/alpha/gobo/IES shader state. Nodes are created once and updated in-place via
 * .value mutation to preserve compiled shader-graph references.
 */

import { texture } from 'three/tsl';
import { TextureNode } from 'three/webgpu';
import { LinearFilter, DataArrayTexture } from 'three';
import { setShadowAlbedoMaps, setAlphaShadowsUniform } from '../TSL/LightsDirect.js';
import { setGoboMapsTexture, setIESProfilesTexture } from '../TSL/LightsCore.js';

export class ShaderBuilder {

	constructor() {

		// Previous-frame texture nodes (sample from MRT RenderTarget)
		this.prevColorTexNode = null;
		this.prevNormalDepthTexNode = null;
		this.prevAlbedoTexNode = null;

		// Adaptive sampling texture (updated per-frame from context)
		this.adaptiveSamplingTexNode = null;

		// Scene texture nodes cache (for in-place updates on model change)
		this._sceneTextureNodes = null;

	}

	updateSceneTextures( stage ) {

		const nodes = this._sceneTextureNodes;

		const env = stage.environment;
		const mat = stage.materialData;

		if ( env.environmentTexture && nodes.envTex ) {

			nodes.envTex.value = env.environmentTexture;

		}

		if ( mat.albedoMaps && nodes.albedoMapsTex ) nodes.albedoMapsTex.value = mat.albedoMaps;
		if ( mat.normalMaps && nodes.normalMapsTex ) nodes.normalMapsTex.value = mat.normalMaps;
		if ( mat.bumpMaps && nodes.bumpMapsTex ) nodes.bumpMapsTex.value = mat.bumpMaps;
		if ( mat.metalnessMaps && nodes.metalnessMapsTex ) nodes.metalnessMapsTex.value = mat.metalnessMaps;
		if ( mat.roughnessMaps && nodes.roughnessMapsTex ) nodes.roughnessMapsTex.value = mat.roughnessMaps;
		if ( mat.emissiveMaps && nodes.emissiveMapsTex ) nodes.emissiveMapsTex.value = mat.emissiveMaps;
		if ( mat.displacementMaps && nodes.displacementMapsTex ) nodes.displacementMapsTex.value = mat.displacementMaps;
		if ( stage.goboMaps && nodes.goboMapsTex ) nodes.goboMapsTex.value = stage.goboMaps;
		if ( stage.iesProfiles && nodes.iesProfilesTex ) nodes.iesProfilesTex.value = stage.iesProfiles;

		console.log( 'ShaderBuilder: Scene textures updated in-place' );

	}

	/**
	 * Swap the spot light gobo texture in-place. The TSL graph closes over the
	 * texture node, so we only need to update the underlying .value.
	 * @param {DataArrayTexture | null} tex
	 */
	updateGoboMaps( tex ) {

		const nodes = this._sceneTextureNodes;
		if ( ! nodes || ! nodes.goboMapsTex ) return;
		if ( tex ) nodes.goboMapsTex.value = tex;

	}

	/**
	 * Swap the spot light IES profile texture in-place.
	 * @param {DataArrayTexture | null} tex
	 */
	updateIESProfiles( tex ) {

		const nodes = this._sceneTextureNodes;
		if ( ! nodes || ! nodes.iesProfilesTex ) return;
		if ( tex ) nodes.iesProfilesTex.value = tex;

	}

	getSceneTextureNodes() {

		return this._sceneTextureNodes;

	}

	// Creates the shared scene texture nodes (env, material maps, prev-frame, adaptive, gobo, IES)
	// + configures the module-level shadow/alpha/gobo/IES shader state read by the wavefront kernels.
	// Call from setupMaterial before the kernels are built.
	createSceneTextureNodes( stage, storageTextures ) {

		const triStorage = stage.triangleStorageNode;
		const bvhStorage = stage.bvhStorageNode;
		const matStorage = stage.materialData.materialStorageNode;
		// Packed light buffer — [lightBVH | emissive triangles]. One node fed to both
		// TSL params; emissive reads offset by stage.emissiveVec4Offset.
		const lightBufferStorage = stage.lightStorageNode;

		// Set alpha-shadow uniform (module-level in LightsDirect.js, read at runtime)
		setAlphaShadowsUniform( stage.uniforms.get( 'enableAlphaShadows' ) );

		const envTex = texture( stage.environment.environmentTexture );

		// Adaptive sampling texture
		const adaptiveSamplingTex = new TextureNode();
		this.adaptiveSamplingTexNode = adaptiveSamplingTex;

		// Previous-frame texture nodes — initialized from readTarget textures
		const readTextures = storageTextures.getReadTextures();
		this.prevColorTexNode = texture( readTextures.color );
		this.prevNormalDepthTexNode = texture( readTextures.normalDepth );
		this.prevAlbedoTexNode = texture( readTextures.albedo );

		const createArrayPlaceholder = () => {

			const dummyTex = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
			dummyTex.minFilter = LinearFilter;
			dummyTex.magFilter = LinearFilter;
			dummyTex.generateMipmaps = false;
			dummyTex.needsUpdate = true;
			return texture( dummyTex );

		};

		const mat = stage.materialData;
		const albedoMapsTex = mat.albedoMaps ? texture( mat.albedoMaps ) : createArrayPlaceholder();
		const normalMapsTex = mat.normalMaps ? texture( mat.normalMaps ) : createArrayPlaceholder();
		const bumpMapsTex = mat.bumpMaps ? texture( mat.bumpMaps ) : createArrayPlaceholder();
		const metalnessMapsTex = mat.metalnessMaps ? texture( mat.metalnessMaps ) : createArrayPlaceholder();
		const roughnessMapsTex = mat.roughnessMaps ? texture( mat.roughnessMaps ) : createArrayPlaceholder();
		const emissiveMapsTex = mat.emissiveMaps ? texture( mat.emissiveMaps ) : createArrayPlaceholder();
		const displacementMapsTex = mat.displacementMaps ? texture( mat.displacementMaps ) : createArrayPlaceholder();

		// Spot light gobo array — placeholder until GoboManager populates it.
		const goboMapsTex = stage.goboMaps ? texture( stage.goboMaps ) : createArrayPlaceholder();
		setGoboMapsTexture( goboMapsTex );

		// Spot light IES profiles array — placeholder until IESManager populates it.
		const iesProfilesTex = stage.iesProfiles ? texture( stage.iesProfiles ) : createArrayPlaceholder();
		setIESProfilesTexture( iesProfilesTex );

		// Set albedo texture array for alpha-aware shadow rays (module-level in LightsDirect.js).
		// Always pass the texture node (real or placeholder) so alpha-cutout code is emitted
		// into the shader at graph construction time. Runtime albedoMapIndex >= 0 guards sampling.
		setShadowAlbedoMaps( albedoMapsTex );

		const result = {
			triStorage, bvhStorage, matStorage, lightBufferStorage,
			envTex, adaptiveSamplingTex,
			albedoMapsTex, normalMapsTex, bumpMapsTex,
			metalnessMapsTex, roughnessMapsTex, emissiveMapsTex, displacementMapsTex,
			goboMapsTex, iesProfilesTex,
		};

		this._sceneTextureNodes = result;
		return result;

	}

	dispose() {

		this.prevColorTexNode = null;
		this.prevNormalDepthTexNode = null;
		this.prevAlbedoTexNode = null;
		this.adaptiveSamplingTexNode = null;
		this._sceneTextureNodes = null;

	}

}
