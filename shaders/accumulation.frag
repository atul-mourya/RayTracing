precision highp float;

uniform vec2 resolution;
uniform sampler2D currentTexture;
uniform sampler2D previousTexture1;
uniform sampler2D previousTexture2;

void main() {
    vec4 currentColor = texture2D(currentTexture, gl_FragCoord.xy / resolution);
    vec4 previousColor1 = texture2D(previousTexture1, gl_FragCoord.xy / resolution);
    vec4 previousColor2 = texture2D(previousTexture2, gl_FragCoord.xy / resolution);

    gl_FragColor = (currentColor + previousColor1 + previousColor2) / 3.0;
}