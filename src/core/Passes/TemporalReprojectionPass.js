import { ShaderMaterial, WebGLRenderTarget, NearestFilter, RGBAFormat, FloatType, Matrix4, Vector2, Vector3 } from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export class TemporalReprojectionPass extends Pass {

	constructor( scene, camera, width, height ) {

		super();

		this.scene = scene;
		this.camera = camera;
		this.width = width;
		this.height = height;

		this.renderTargetA = new WebGLRenderTarget( width, height, {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			format: RGBAFormat,
			type: FloatType
		} );
		this.renderTargetB = this.renderTargetA.clone();
		this.currentRenderTarget = this.renderTargetA;
		this.previousRenderTarget = this.renderTargetB;

		this.frameCount = 0;
		this.previousCameraPosition = new Vector3();
		this.previousCameraRotation = new Vector3();

		this.material = new ShaderMaterial( {
			uniforms: {
				tCurrent: { value: null },
				tPrevious: { value: null },
				resolution: { value: new Vector2( width, height ) },
				blendFactor: { value: 0.9 },
				previousViewProjectionMatrix: { value: new Matrix4() },
				currentViewProjectionMatrix: { value: new Matrix4() },
				cameraMovement: { value: new Vector2( 0, 0 ) },
				neighborhoodClampIntensity: { value: 0.5 }
			},
			vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
			fragmentShader: `
                uniform sampler2D tCurrent;
                uniform sampler2D tPrevious;
                uniform vec2 resolution;
                uniform float blendFactor;
                uniform mat4 previousViewProjectionMatrix;
                uniform mat4 currentViewProjectionMatrix;
                uniform vec2 cameraMovement;
                uniform float neighborhoodClampIntensity;
                varying vec2 vUv;

                vec2 getMotionVector(vec2 uv) {
                    vec4 ndc = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
                    vec4 worldPos = inverse(currentViewProjectionMatrix) * ndc;
                    worldPos /= worldPos.w;
                    vec4 previousNdc = previousViewProjectionMatrix * worldPos;
                    previousNdc /= previousNdc.w;
                    vec2 previousUv = previousNdc.xy * 0.5 + 0.5;
                    return previousUv - uv;
                }

                void getRGBNeighborhood(sampler2D tex, vec2 uv, vec2 texelSize, out vec3 minColor, out vec3 maxColor) {
                    minColor = vec3(1.0);
                    maxColor = vec3(0.0);
                    
                    for(int x = -1; x <= 1; x++) {
                        for(int y = -1; y <= 1; y++) {
                            vec2 offset = vec2(float(x), float(y)) * texelSize;
                            vec3 neighborColor = texture2D(tex, uv + offset).rgb;
                            minColor = min(minColor, neighborColor);
                            maxColor = max(maxColor, neighborColor);
                        }
                    }
                }

                void main() {
                    vec2 texelSize = 1.0 / resolution;
                    vec2 motionVector = getMotionVector(vUv);
                    
                    vec4 currentColor = texture2D(tCurrent, vUv);
                    vec2 reprojectedUv = vUv + motionVector;
                    
                    bool inScreen = reprojectedUv.x >= 0.0 && reprojectedUv.x <= 1.0 && 
                                    reprojectedUv.y >= 0.0 && reprojectedUv.y <= 1.0;
                    
                    vec4 previousColor = inScreen ? texture2D(tPrevious, reprojectedUv) : currentColor;
                    
                    // Neighborhood clamping
                    vec3 minColor, maxColor;
                    getRGBNeighborhood(tCurrent, vUv, texelSize, minColor, maxColor);
                    previousColor.rgb = clamp(previousColor.rgb, minColor, maxColor);
                    
                    // Adaptive blend factor based on motion
                    float motionLength = length(motionVector);
                    float adaptiveBlendFactor = mix(blendFactor, 0.0, smoothstep(0.0, 0.1, motionLength));
                    
                    // Disocclusion detection
                    float colorDifference = distance(currentColor.rgb, previousColor.rgb);
                    float disocclusionFactor = smoothstep(0.1, 0.5, colorDifference);
                    adaptiveBlendFactor *= (1.0 - disocclusionFactor);
                    
                    // Final blending
                    vec3 finalColor = mix(currentColor.rgb, previousColor.rgb, adaptiveBlendFactor);
                    
                    // Apply neighborhood clamping to final result
                    finalColor = mix(finalColor, clamp(finalColor, minColor, maxColor), neighborhoodClampIntensity);
                    
                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `
		} );

		this.fsQuad = new FullScreenQuad( this.material );

	}

	render( renderer, writeBuffer, readBuffer ) {

		if ( ! this.enabled ) return;

		this.material.uniforms.tCurrent.value = readBuffer.texture;
		this.material.uniforms.tPrevious.value = this.previousRenderTarget.texture;

		this.updateMatrices();
		this.updateCameraMovement();

		renderer.setRenderTarget( this.currentRenderTarget );
		this.fsQuad.render( renderer );

		this.copyToWriteBuffer( renderer, writeBuffer );

		[ this.currentRenderTarget, this.previousRenderTarget ] = [ this.previousRenderTarget, this.currentRenderTarget ];

		this.frameCount ++;

	}

	updateMatrices() {

		const viewProjectionMatrix = new Matrix4().multiplyMatrices(
			this.camera.projectionMatrix,
			this.camera.matrixWorldInverse
		);

		this.material.uniforms.previousViewProjectionMatrix.value.copy( this.material.uniforms.currentViewProjectionMatrix.value );
		this.material.uniforms.currentViewProjectionMatrix.value.copy( viewProjectionMatrix );

	}

	updateCameraMovement() {

		const currentPosition = this.camera.position;
		const currentRotation = new Vector3().setFromEuler( this.camera.rotation );

		const positionDelta = new Vector3().subVectors( currentPosition, this.previousCameraPosition );
		const rotationDelta = new Vector3().subVectors( currentRotation, this.previousCameraRotation );

		const movementMagnitude = positionDelta.length() + rotationDelta.length() * 0.1;
		this.material.uniforms.cameraMovement.value.set( movementMagnitude, 0 );

		this.previousCameraPosition.copy( currentPosition );
		this.previousCameraRotation.copy( currentRotation );

	}

	copyToWriteBuffer( renderer, writeBuffer ) {

		if ( writeBuffer === null ) {

			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );

		} else {

			renderer.setRenderTarget( writeBuffer );
			this.fsQuad.render( renderer );

		}

	}

	setSize( width, height ) {

		this.width = width;
		this.height = height;
		this.renderTargetA.setSize( width, height );
		this.renderTargetB.setSize( width, height );
		this.material.uniforms.resolution.value.set( width, height );

	}

	dispose() {

		this.renderTargetA.dispose();
		this.renderTargetB.dispose();
		this.material.dispose();
		this.fsQuad.dispose();

	}

}
