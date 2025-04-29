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
		"exposure": { value: 0.0 },
		"gamma": { value: 2.2 }
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
        uniform float gamma;
        varying vec2 vUv;

		// Function to decode from gamma space to linear space
		vec3 gammaToLinear(vec3 color) {
			return pow(color, vec3(2.2));
		}

		// Function to encode from linear space to gamma space
		vec3 linearToGamma(vec3 color, float gamma) {
			return pow(color, vec3(1.0 / gamma));
		}

		// Desaturate using luminosity factors
		vec3 desaturated(vec3 color) {
			// sRGB colorspace luminosity factor
			vec3 luma = vec3(0.2126, 0.7152, 0.0722);
			float luminance = dot(color, luma);
			return vec3(luminance);
		}

		// Apply saturation by mixing original color with desaturated version
		vec3 applyColorSaturation(vec3 color, float value) {
			vec3 gray = desaturated(color);
			return mix(gray, color, 1.0 + value);
		}

		// Function to convert RGB to HSL (for hue only)
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
			
			// Decode from gamma space to linear space
			vec3 linearColor = gammaToLinear(texel.rgb);
			
			// Apply saturation using luminosity-based approach
			vec3 colorWithSaturation = applyColorSaturation(linearColor, saturation);
			
			// Apply hue shift (still using HSL but only for hue)
			if (abs(hue) > 0.01) {
				vec3 hslColor = rgb2hsl(colorWithSaturation);
				hslColor.x = fract(hslColor.x + hue / 360.0);
				// Keep original saturation and luminance, only change hue
				colorWithSaturation = hsl2rgb(hslColor);
			}
			
			// Apply exposure
			vec3 colorWithExposure = colorWithSaturation * pow(2.0, exposure);
			
			// Encode back to gamma space using the gamma value
			vec3 finalColor = linearToGamma(colorWithExposure, gamma);
			
			gl_FragColor = vec4(finalColor, texel.a);
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
		this.colorAdjustmentPass.uniforms[ 'gamma' ].value = 2.2;
		this.composer.addPass( this.colorAdjustmentPass );

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

		if ( params.gamma !== undefined ) {

			this.colorAdjustmentPass.uniforms[ 'gamma' ].value = params.gamma;

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
