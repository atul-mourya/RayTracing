const float PI = 3.14159f;
const float EPSILON = 0.001;


// Lerp function (linear interpolation)
vec3 lerp(vec3 a, vec3 b, float t) {
	return a + t * (b - a);
}

float inverseLerp(float v, float minValue, float maxValue) {
  return (v - minValue) / (maxValue - minValue);
}

float remap(float v, float inMin, float inMax, float outMin, float outMax) {
  float t = inverseLerp(v, inMin, inMax);
  return mix(outMin, outMax, t);
}

vec3 sRGBToLinear(vec3 srgbColor) {
    return pow(srgbColor, vec3(2.2));
}

vec3 linearTosRGB(vec3 value ) {
  vec3 lt = vec3(lessThanEqual(value.rgb, vec3(0.0031308)));
  
  vec3 v1 = value * 12.92;
  vec3 v2 = pow(value.xyz, vec3(0.41666)) * 1.055 - vec3(0.055);

	return mix(v2, v1, lt);
}