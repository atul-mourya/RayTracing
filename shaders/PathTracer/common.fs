const float PI = 3.14159f;


// Lerp function (linear interpolation)
vec3 lerp(vec3 a, vec3 b, float t) {
	return a + t * (b - a);
}
