import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { BrightnessContrastShader } from 'three/examples/jsm/shaders/BrightnessContrastShader.js';

// Custom shader for hue, saturation, and exposure
const ColorAdjustmentShader = {
	uniforms: {
		"tDiffuse": { value: null },
		"hue": { value: 0.0 },
		"saturation": { value: 0.0 },
		"exposure": { value: 0.0 }
	},
	vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
	fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float hue;
        uniform float saturation;
        uniform float exposure;
        varying vec2 vUv;

        // Function to convert RGB to HSL
        vec3 rgb2hsl(vec3 color) {
            float maxColor = max(max(color.r, color.g), color.b);
            float minColor = min(min(color.r, color.g), color.b);
            float delta = maxColor - minColor;
            
            float h = 0.0;
            float s = 0.0;
            float l = (maxColor + minColor) / 2.0;
            
            if (delta > 0.0) {
                s = l < 0.5 ? delta / (maxColor + minColor) : delta / (2.0 - maxColor - minColor);
                
                if (maxColor == color.r) {
                    h = (color.g - color.b) / delta + (color.g < color.b ? 6.0 : 0.0);
                } else if (maxColor == color.g) {
                    h = (color.b - color.r) / delta + 2.0;
                } else {
                    h = (color.r - color.g) / delta + 4.0;
                }
                h /= 6.0;
            }
            
            return vec3(h, s, l);
        }

        float hue2rgb(float p, float q, float t) {
            if (t < 0.0) t += 1.0;
            if (t > 1.0) t -= 1.0;
            if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
            if (t < 1.0/2.0) return q;
            if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
            return p;
        }
        
        // Function to convert HSL to RGB
        vec3 hsl2rgb(vec3 hsl) {
            float h = hsl.x;
            float s = hsl.y;
            float l = hsl.z;
            
            float r, g, b;
            
            if (s == 0.0) {
                r = g = b = l;
            } else {
                float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
                float p = 2.0 * l - q;
                
                r = hue2rgb(p, q, h + 1.0/3.0);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1.0/3.0);
            }
            
            return vec3(r, g, b);
        }

        void main() {
            vec4 texel = texture2D(tDiffuse, vUv);
            
            // Apply hue shift and saturation
            vec3 hslColor = rgb2hsl(texel.rgb);
            
            // Adjust hue (0-1 range)
            hslColor.x = fract(hslColor.x + hue / 360.0);
            
            // Adjust saturation (-1 to 1 range mapped to appropriate adjustment)
            if (saturation > 0.0) {
                hslColor.y = mix(hslColor.y, 1.0, saturation);
            } else {
                hslColor.y = mix(hslColor.y, 0.0, -saturation);
            }
            
            // Convert back to RGB
            vec3 rgbColor = hsl2rgb(hslColor);
            
            // Apply exposure
            rgbColor = rgbColor * pow(2.0, exposure);
            
            gl_FragColor = vec4(rgbColor, texel.a);
        }
    `
};

export class ImageProcessorComposer {

	constructor( inputCanvas, outputCanvas = null ) {

		if ( ! inputCanvas ) throw new Error( 'Input canvas is required' );

		this.inputCanvas = inputCanvas;
		this.outputCanvas = outputCanvas || document.createElement( 'canvas' );

		this.width = inputCanvas.width;
		this.height = inputCanvas.height;

		this.outputCanvas.width = this.width;
		this.outputCanvas.height = this.height;

		this.renderer = new THREE.WebGLRenderer( {
			canvas: this.outputCanvas,
			preserveDrawingBuffer: true,
		} );
		this.renderer.setSize( this.width, this.height, false );

		this.scene = new THREE.Scene();
		this.camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		// Create quad with input image
		const geometry = new THREE.PlaneGeometry( 2, 2 );
		const texture = new THREE.CanvasTexture( inputCanvas );
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;

		const material = new THREE.MeshBasicMaterial( { map: texture } );
		this.quad = new THREE.Mesh( geometry, material );
		this.scene.add( this.quad );

		// Composer setup
		this.composer = new EffectComposer( this.renderer );
		this.renderPass = new RenderPass( this.scene, this.camera );
		this.composer.addPass( this.renderPass );

		// Add brightness/contrast pass
		this.brightnessContrastPass = new ShaderPass( BrightnessContrastShader );
		this.brightnessContrastPass.uniforms[ 'brightness' ].value = 0;
		this.brightnessContrastPass.uniforms[ 'contrast' ].value = 0;
		this.composer.addPass( this.brightnessContrastPass );

		// Add color adjustment pass
		this.colorAdjustmentPass = new ShaderPass( ColorAdjustmentShader );
		this.colorAdjustmentPass.uniforms[ 'hue' ].value = 0;
		this.colorAdjustmentPass.uniforms[ 'saturation' ].value = 0;
		this.colorAdjustmentPass.uniforms[ 'exposure' ].value = 0;
		this.composer.addPass( this.colorAdjustmentPass );

        window.imangeProcessor = this; // For debugging purposes

	}

	updateTexture() {

		if ( this.quad && this.quad.material && this.quad.material.map ) {

			this.quad.material.map.needsUpdate = true;

		}

	}

	setParameters( params = {} ) {

		// Set brightness/contrast
		if ( params.brightness !== undefined ) {

			this.brightnessContrastPass.uniforms[ 'brightness' ].value = params.brightness / 100;

		}

		if ( params.contrast !== undefined ) {

			this.brightnessContrastPass.uniforms[ 'contrast' ].value = params.contrast / 100;

		}

		// Set hue/saturation/exposure
		if ( params.hue !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'hue' ].value = params.hue;

		}

		if ( params.saturation !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'saturation' ].value = params.saturation / 100;

		}

		if ( params.exposure !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'exposure' ].value = params.exposure / 100;

		}

	}

	render() {

		this.updateTexture();
		this.composer.render();
		return this.outputCanvas;

	}

	dispose() {

		this.renderer.dispose();
		this.composer.passes.forEach( p => p.dispose?.() );
		this.composer = null;

	}

}
