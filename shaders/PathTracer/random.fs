uint pcg_hash(uint state) {
	state = state * 747796405u + 2891336453u;
	uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
	word = (word >> 22u) ^ word;
	return word;
}

float RandomValue(inout uint state) {
	state = pcg_hash(state);
	return float(state) / 4294967296.0f;
}

// Random value in normal distribution (with mean=0 and sd=1)
float RandomValueNormalDistribution(inout uint state) {
	// Thanks to https://stackoverflow.com/a/6178290
	float theta = 2.0f * 3.1415926f * RandomValue(state);
	float rho = sqrt(- 2.0f * log(RandomValue(state)));
	return rho * cos(theta);
}

// Calculate a random direction.
// Note: there are many alternative methods for computing this,
// with varying trade-offs between speed and accuracy.
vec3 RandomDirection(inout uint state) {
	// Thanks to https://math.stackexchange.com/a/1585996
	float x = RandomValueNormalDistribution(state);
	float y = RandomValueNormalDistribution(state);
	float z = RandomValueNormalDistribution(state);
	return normalize(vec3(x, y, z));
}

vec3 RandomHemiSphereDirection(vec3 normal, inout uint rngState) {
	vec3 dir = RandomDirection(rngState);
	dir = dir * sign(dot(normal, dir));
	return dir;
}

vec2 RandomPointInCircle(inout uint rngState) {
    float angle = RandomValue(rngState) * 2.0 * PI;
    vec2 pointOnCircle = vec2(cos(angle), sin(angle));
    return pointOnCircle * sqrt(RandomValue(rngState));
}