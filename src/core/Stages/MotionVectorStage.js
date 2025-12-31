import {
	ShaderMaterial,
	WebGLRenderTarget,
	Vector2,
	Matrix4,
	FloatType,
	RGBAFormat,
	NearestFilter,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PipelineStage, StageExecutionMode } from '../Pipeline/PipelineStage.js';

/**
 * MotionVectorStage - Dedicated motion vector computation
 *
 * Computes per-pixel motion vectors for temporal effects like:
 * - Temporal denoising (ASVGF)
 * - Motion blur (post-process)
 * - Temporal anti-aliasing (TAA)
 *
 * Execution: ALWAYS - Motion vectors needed every frame for temporal effects
 *
 * Outputs:
 * - Screen-space motion vectors (2D displacement in UV space)
 * - World-space velocity vectors (3D velocity for motion blur)
 *
 * Events emitted:
 * - motionvector:computed - When motion vectors are ready
 *
 * Textures published to context:
 * - motionVector:screenSpace - Screen-space motion (xy=motion, z=depth, w=validity)
 * - motionVector:worldSpace - World-space velocity (xyz=velocity, w=validity)
 *
 * Textures read from context:
 * - pathtracer:normalDepth - For depth-based world position reconstruction
 */
export class MotionVectorStage extends PipelineStage {

	constructor( options = {} ) {

		super( 'MotionVector', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = options.renderer || null;
		this.camera = options.camera || null;
		this.width = options.width || 1920;
		this.height = options.height || 1080;

		// Camera matrices for motion vector calculation
		this.prevViewMatrix = new Matrix4();
		this.prevProjectionMatrix = new Matrix4();
		this.prevViewProjectionMatrix = new Matrix4();
		this.currentViewMatrix = new Matrix4();
		this.currentProjectionMatrix = new Matrix4();
		this.currentViewProjectionMatrix = new Matrix4();

		// First frame flag
		this.isFirstFrame = true;
		this.frameCount = 0;
		this.matricesInitialized = false;

		// Initialize render targets
		this.initRenderTargets();

		// Initialize materials
		this.initMaterials();

		// Create fullscreen quads
		this.screenSpaceQuad = new FullScreenQuad( this.screenSpaceMaterial );
		this.worldSpaceQuad = new FullScreenQuad( this.worldSpaceMaterial );

	}

	initRenderTargets() {

		const targetOptions = {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			format: RGBAFormat,
			type: FloatType,
			depthBuffer: false,
			stencilBuffer: false
		};

		// Screen-space motion vectors: xy=motion, z=depth, w=validity
		this.screenSpaceTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.screenSpaceTarget.texture.name = 'MotionVector_ScreenSpace';

		// Previous frame's normal/depth for validation
		this.prevNormalDepthTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.prevNormalDepthTarget.texture.name = 'MotionVector_PrevNormalDepth';

		// World-space velocity: xyz=velocity, w=validity
		this.worldSpaceTarget = new WebGLRenderTarget( this.width, this.height, targetOptions );
		this.worldSpaceTarget.texture.name = 'MotionVector_WorldSpace';

	}

	initMaterials() {

		// Screen-space motion vector shader
		// Uses same pattern as ASVGF's working motion calculation
		this.screenSpaceMaterial = new ShaderMaterial( {
			uniforms: {
				tNormalDepth: { value: null },
				tPrevNormalDepth: { value: null },
				currentViewProjectionMatrix: { value: new Matrix4() },
				prevViewProjectionMatrix: { value: new Matrix4() },
				resolution: { value: new Vector2( this.width, this.height ) }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tNormalDepth;
				uniform sampler2D tPrevNormalDepth;
				uniform mat4 currentViewProjectionMatrix;
				uniform mat4 prevViewProjectionMatrix;
				uniform vec2 resolution;

				varying vec2 vUv;

				vec3 getWorldPosition(vec2 uv, float depth, mat4 invViewProjMatrix) {
					vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
					vec4 worldPos = invViewProjMatrix * clipPos;
					return worldPos.xyz / worldPos.w;
				}

				void main() {
					vec4 normalDepth = texture2D(tNormalDepth, vUv);
					float depth = normalDepth.a;

					if (depth >= 1.0) {
						// Sky/background - no motion
						gl_FragColor = vec4(0.0, 0.0, depth, 1.0);
						return;
					}

					// Reconstruct world position
					mat4 invCurrentVP = inverse(currentViewProjectionMatrix);
					vec3 worldPos = getWorldPosition(vUv, depth, invCurrentVP);

					// Project to previous frame
					vec4 prevClipPos = prevViewProjectionMatrix * vec4(worldPos, 1.0);
					vec2 prevScreenPos = (prevClipPos.xy / prevClipPos.w) * 0.5 + 0.5;

					// Calculate motion vector
					vec2 motion = vUv - prevScreenPos;

					// Validate motion vector
					if (prevScreenPos.x < 0.0 || prevScreenPos.x > 1.0 ||
						prevScreenPos.y < 0.0 || prevScreenPos.y > 1.0) {
						// Outside screen bounds
						motion = vec2(1000.0); // Invalid motion marker
					}

					gl_FragColor = vec4(motion, depth, 1.0);
				}
			`
		} );

		// World-space velocity shader (for motion blur)
		this.worldSpaceMaterial = new ShaderMaterial( {
			uniforms: {
				tNormalDepth: { value: null },
				currentViewProjectionMatrix: { value: new Matrix4() },
				prevViewProjectionMatrix: { value: new Matrix4() },
				currentViewMatrixInverse: { value: new Matrix4() },
				prevViewMatrixInverse: { value: new Matrix4() },
				resolution: { value: new Vector2( this.width, this.height ) },
				isFirstFrame: { value: true },
				deltaTime: { value: 1.0 / 60.0 }, // Assume 60fps, can be updated
				velocityScale: { value: 1.0 }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tNormalDepth;
				uniform mat4 currentViewProjectionMatrix;
				uniform mat4 prevViewProjectionMatrix;
				uniform mat4 currentViewMatrixInverse;
				uniform mat4 prevViewMatrixInverse;
				uniform vec2 resolution;
				uniform bool isFirstFrame;
				uniform float deltaTime;
				uniform float velocityScale;

				varying vec2 vUv;

				vec3 getWorldPosition(vec2 uv, float depth, mat4 invViewProjMatrix) {
					vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
					vec4 worldPos = invViewProjMatrix * clipPos;
					return worldPos.xyz / worldPos.w;
				}

				void main() {
					vec4 normalDepth = texture2D(tNormalDepth, vUv);
					float depth = normalDepth.a;

					// First frame or sky: no velocity
					if (isFirstFrame || depth >= 1.0) {
						gl_FragColor = vec4(0.0, 0.0, 0.0, depth >= 1.0 ? 1.0 : 0.0);
						return;
					}

					// Get current world position
					mat4 invCurrentVP = inverse(currentViewProjectionMatrix);
					vec3 currentWorldPos = getWorldPosition(vUv, depth, invCurrentVP);

					// Project to previous frame and get previous world position
					vec4 prevClipPos = prevViewProjectionMatrix * vec4(currentWorldPos, 1.0);
					vec2 prevScreenPos = (prevClipPos.xy / prevClipPos.w) * 0.5 + 0.5;

					// Check bounds
					if (prevScreenPos.x < 0.0 || prevScreenPos.x > 1.0 ||
						prevScreenPos.y < 0.0 || prevScreenPos.y > 1.0) {
						gl_FragColor = vec4(0.0, 0.0, 0.0, 0.5); // Partial validity
						return;
					}

					// Calculate world-space velocity
					// For static geometry, velocity comes from camera motion
					// Get previous frame's world position at the reprojected UV
					vec3 prevWorldPos = getWorldPosition(prevScreenPos, depth, inverse(prevViewProjectionMatrix));

					// World-space displacement
					vec3 worldVelocity = (currentWorldPos - prevWorldPos) / deltaTime;

					// Scale velocity for visualization/effect strength
					worldVelocity *= velocityScale;

					// Output: xyz=velocity, w=validity
					gl_FragColor = vec4(worldVelocity, 1.0);
				}
			`
		} );

		// Copy material for storing previous frame data
		this.copyMaterial = new ShaderMaterial( {
			uniforms: {
				tDiffuse: { value: null }
			},
			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = vec4( position, 1.0 );
				}
			`,
			fragmentShader: /* glsl */`
				uniform sampler2D tDiffuse;
				varying vec2 vUv;
				void main() {
					gl_FragColor = texture2D( tDiffuse, vUv );
				}
			`
		} );
		this.copyQuad = new FullScreenQuad( this.copyMaterial );

	}

	/**
	 * Update camera matrices for motion vector calculation
	 * Must be called before render each frame
	 */
	updateCameraMatrices( camera ) {

		// Store previous matrices (copy current to prev before updating current)
		if ( this.matricesInitialized ) {

			this.prevViewMatrix.copy( this.currentViewMatrix );
			this.prevProjectionMatrix.copy( this.currentProjectionMatrix );
			this.prevViewProjectionMatrix.copy( this.currentViewProjectionMatrix );

		} else {

			// First frame: initialize prev to current camera state
			this.prevViewMatrix.copy( camera.matrixWorldInverse );
			this.prevProjectionMatrix.copy( camera.projectionMatrix );
			this.prevViewProjectionMatrix.multiplyMatrices(
				camera.projectionMatrix,
				camera.matrixWorldInverse
			);
			this.matricesInitialized = true;

		}

		// Update current matrices - clone to create new objects (like ASVGF does)
		this.currentViewMatrix = camera.matrixWorldInverse.clone();
		this.currentProjectionMatrix = camera.projectionMatrix.clone();
		this.currentViewProjectionMatrix = new Matrix4();
		this.currentViewProjectionMatrix.multiplyMatrices(
			this.currentProjectionMatrix,
			this.currentViewMatrix
		);

	}

	/**
	 * Setup event listeners
	 */
	setupEventListeners() {

		// Listen for pipeline reset
		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

		// Listen for camera changes
		this.on( 'camera:moved', () => {

			// Camera moved - motion vectors will naturally reflect this
			// No special handling needed

		} );

	}

	/**
	 * Reset motion vector state
	 * NOTE: We intentionally do NOT reset matricesInitialized here!
	 * Motion vectors need to track camera movement across pipeline resets.
	 * When camera moves, pipeline resets, but we still want to detect
	 * that motion by comparing current matrices to previous.
	 */
	reset() {

		// Only reset frame counter
		// Keep matricesInitialized = true so we continue tracking motion!
		// Keep isFirstFrame = false if matrices are already initialized
		// (we have valid previous matrices to compare against)
		if ( ! this.matricesInitialized ) {

			this.isFirstFrame = true;

		}

		this.frameCount = 0;

		// Clear render targets
		if ( this.renderer ) {

			const currentRT = this.renderer.getRenderTarget();

			this.renderer.setRenderTarget( this.screenSpaceTarget );
			this.renderer.clear();

			this.renderer.setRenderTarget( this.worldSpaceTarget );
			this.renderer.clear();

			this.renderer.setRenderTarget( this.prevNormalDepthTarget );
			this.renderer.clear();

			this.renderer.setRenderTarget( currentRT );

		}

	}

	/**
	 * Full reset including matrix state (for scene changes)
	 */
	fullReset() {

		this.matricesInitialized = false;
		this.reset();

	}

	/**
	 * Set render size
	 */
	setSize( width, height ) {

		this.width = width;
		this.height = height;

		// Resize render targets
		this.screenSpaceTarget.setSize( width, height );
		this.worldSpaceTarget.setSize( width, height );
		this.prevNormalDepthTarget.setSize( width, height );

		// Update resolution uniforms
		const resolution = new Vector2( width, height );
		if ( this.screenSpaceMaterial.uniforms.resolution ) {

			this.screenSpaceMaterial.uniforms.resolution.value.copy( resolution );

		}

		if ( this.worldSpaceMaterial.uniforms.resolution ) {

			this.worldSpaceMaterial.uniforms.resolution.value.copy( resolution );

		}

		// Reset on resize
		this.reset();

	}

	/**
	 * Main render method
	 */
	render( context, writeBuffer ) {

		if ( ! this.enabled ) return;

		const renderer = this.renderer || context.renderer;
		if ( ! renderer ) {

			this.warn( 'No renderer available' );
			return;

		}

		// Get normalDepth texture from PathTracer
		const normalDepthTexture = context.getTexture( 'pathtracer:normalDepth' );
		if ( ! normalDepthTexture ) {

			// PathTracer hasn't run yet, skip
			return;

		}

		// Update camera matrices
		if ( this.camera ) {

			// Ensure camera matrices are fully up to date
			// 1. updateMatrix() computes local matrix from position/quaternion/scale
			// 2. updateMatrixWorld() propagates to world matrix
			// 3. Manually compute matrixWorldInverse
			this.camera.updateMatrix();
			this.camera.updateMatrixWorld( true );
			this.camera.matrixWorldInverse.copy( this.camera.matrixWorld ).invert();
			this.updateCameraMatrices( this.camera );

		}

		// Increment frame count
		this.frameCount ++;

		// Compute screen-space motion vectors
		this.renderScreenSpaceMotion( renderer, normalDepthTexture );

		// Compute world-space velocity (optional, for motion blur)
		this.renderWorldSpaceVelocity( renderer, normalDepthTexture );

		// Store current normalDepth for next frame
		this.storeNormalDepth( renderer, normalDepthTexture );

		// Publish textures to context
		this.publishTextures( context );

		// Emit completion event
		this.emit( 'motionvector:computed', {
			frame: this.frameCount,
			isFirstFrame: this.isFirstFrame
		} );

		// No longer first frame after this
		this.isFirstFrame = false;

	}

	renderScreenSpaceMotion( renderer, normalDepthTexture ) {

		// Update uniforms
		const material = this.screenSpaceMaterial;
		material.uniforms.tNormalDepth.value = normalDepthTexture;
		material.uniforms.tPrevNormalDepth.value = this.prevNormalDepthTarget.texture;
		material.uniforms.currentViewProjectionMatrix.value.copy( this.currentViewProjectionMatrix );
		material.uniforms.prevViewProjectionMatrix.value.copy( this.prevViewProjectionMatrix );

		// Render to screen-space motion target
		const currentRT = renderer.getRenderTarget();
		renderer.setRenderTarget( this.screenSpaceTarget );
		this.screenSpaceQuad.render( renderer );
		renderer.setRenderTarget( currentRT );

	}

	renderWorldSpaceVelocity( renderer, normalDepthTexture ) {

		const material = this.worldSpaceMaterial;

		// Update uniforms
		material.uniforms.tNormalDepth.value = normalDepthTexture;
		material.uniforms.currentViewProjectionMatrix.value.copy( this.currentViewProjectionMatrix );
		material.uniforms.prevViewProjectionMatrix.value.copy( this.prevViewProjectionMatrix );

		// Compute inverse view matrices for world-space calculations
		const currentViewInverse = new Matrix4().copy( this.currentViewMatrix ).invert();
		const prevViewInverse = new Matrix4().copy( this.prevViewMatrix ).invert();

		material.uniforms.currentViewMatrixInverse.value.copy( currentViewInverse );
		material.uniforms.prevViewMatrixInverse.value.copy( prevViewInverse );
		material.uniforms.isFirstFrame.value = this.isFirstFrame;

		// Render
		const currentRT = renderer.getRenderTarget();
		renderer.setRenderTarget( this.worldSpaceTarget );
		this.worldSpaceQuad.render( renderer );
		renderer.setRenderTarget( currentRT );

	}

	storeNormalDepth( renderer, normalDepthTexture ) {

		// Copy current normalDepth to previous for next frame
		this.copyMaterial.uniforms.tDiffuse.value = normalDepthTexture;

		const currentRT = renderer.getRenderTarget();
		renderer.setRenderTarget( this.prevNormalDepthTarget );
		this.copyQuad.render( renderer );
		renderer.setRenderTarget( currentRT );

	}

	publishTextures( context ) {

		// Publish screen-space motion vectors
		context.setTexture( 'motionVector:screenSpace', this.screenSpaceTarget.texture );

		// Publish world-space velocity
		context.setTexture( 'motionVector:worldSpace', this.worldSpaceTarget.texture );

		// Also publish with legacy naming for backward compatibility with ASVGF
		context.setTexture( 'motionVector:motion', this.screenSpaceTarget.texture );

	}

	/**
	 * Get screen-space motion texture directly
	 */
	getScreenSpaceTexture() {

		return this.screenSpaceTarget.texture;

	}

	/**
	 * Get world-space velocity texture directly
	 */
	getWorldSpaceTexture() {

		return this.worldSpaceTarget.texture;

	}

	/**
	 * Set velocity scale for world-space motion blur
	 */
	setVelocityScale( scale ) {

		this.worldSpaceMaterial.uniforms.velocityScale.value = scale;

	}

	/**
	 * Set delta time for velocity calculation
	 */
	setDeltaTime( dt ) {

		this.worldSpaceMaterial.uniforms.deltaTime.value = dt;

	}

	/**
	 * Dispose resources
	 */
	dispose() {

		// Dispose render targets
		this.screenSpaceTarget.dispose();
		this.worldSpaceTarget.dispose();
		this.prevNormalDepthTarget.dispose();

		// Dispose materials
		this.screenSpaceMaterial.dispose();
		this.worldSpaceMaterial.dispose();
		this.copyMaterial.dispose();

		// Dispose quads
		this.screenSpaceQuad.dispose();
		this.worldSpaceQuad.dispose();
		this.copyQuad.dispose();

	}

}
