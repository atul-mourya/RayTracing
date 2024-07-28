varying vec3 vUv;

void main() {
    vUv = position;

    vec4 modelViewPosition = modelViewMatrix * vec4(position, 1.0f);
    gl_Position = projectionMatrix * modelViewPosition;
}