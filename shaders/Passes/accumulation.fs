precision highp float;

uniform float iteration;

uniform sampler2D tDiffuse1;
uniform sampler2D tDiffuse2;

varying vec2 vUv;

void main( ) {

	vec4 texel1 = texture2D( tDiffuse1, vUv );
	vec4 texel2 = texture2D( tDiffuse2, vUv );

	float weight = 1.0 / iteration;
	gl_FragColor = texel1 * ( 1.0 - weight ) + texel2 * weight;
}