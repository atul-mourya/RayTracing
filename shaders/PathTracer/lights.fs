uniform int numDirectionalLights;
uniform vec3 directionalLightDirections[MAX_DIRECTIONAL_LIGHTS];
uniform vec3 directionalLightColors[MAX_DIRECTIONAL_LIGHTS];
uniform float directionalLightIntensities[MAX_DIRECTIONAL_LIGHTS];

// Define a structure for directional lights
struct DirectionalLight {
    vec3 direction;
    vec3 color;
    float intensity;
};

// Function to get directional light data
DirectionalLight getDirectionalLight(int index) {
    DirectionalLight light;
    light.direction = directionalLightDirections[index];
    light.color = directionalLightColors[index];
    light.intensity = directionalLightIntensities[index];
    return light;
}