precision highp float;

struct Ray {
	vec3 origin;
	vec3 dir;
};

struct RayTracingMaterial {
	vec3 color;
	vec3 emissionColor;
	float emissionStrength;
};

struct Sphere {
	vec3 position;
	float radius;
	RayTracingMaterial material;
};

struct HitInfo {
	bool didHit;
	float dst;
	vec3 hitPoint;
	vec3 normal;
	RayTracingMaterial material;
};

uniform vec2 resolution;
uniform vec3 cameraPos;
uniform vec3 cameraDir;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform int numSpheres;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform uint frame;
uniform Sphere spheres[ 4 ];

Ray generateRay(vec2 uv) {
	Ray ray;
	ray.origin = cameraPos;
	vec3 rayDir = normalize(cameraDir + uv.x * cameraRight + uv.y * cameraUp);
	ray.dir = rayDir;
	return ray;
}

HitInfo RaySphere(Ray ray, Sphere sphere) {
	HitInfo hitInfo;
	hitInfo.didHit = false;

	vec3 oc = ray.origin - sphere.position;
	float a = dot(ray.dir, ray.dir);
	float b = 2.0 * dot(oc, ray.dir);
	float c = dot(oc, oc) - sphere.radius * sphere.radius;
	float discriminant = b * b - 4.0 * a * c;

	if(discriminant > 0.0) {
		float t = (- b - sqrt(discriminant)) / (2.0 * a);
		if(t > 0.0) {
			hitInfo.didHit = true;
			hitInfo.dst = t;
			hitInfo.hitPoint = ray.origin + t * ray.dir;
			hitInfo.normal = normalize(hitInfo.hitPoint - sphere.position);
			hitInfo.material = sphere.material;
		}
	}

	return hitInfo;
}

HitInfo CalculateRayCollision(Ray ray) {
	HitInfo closestHit;
	closestHit.didHit = false;
	closestHit.dst = 1e20; // A large value

	for(int i = 0; i < numSpheres; i ++) {
		HitInfo hitInfo = RaySphere(ray, spheres[ i ]);
		if(hitInfo.didHit && hitInfo.dst < closestHit.dst) {
			closestHit = hitInfo;
		}
	}

	return closestHit;
}

uint pcg_hash(uint state) {
	state = state * 747796405u + 2891336453u;
	uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
	word = (word >> 22u) ^ word;
	return word;
}

float RandomValue(inout uint state) {
	state = pcg_hash(state);
	return float(state) / 4294967296.0;
}

// Random value in normal distribution (with mean=0 and sd=1)
float RandomValueNormalDistribution(inout uint state) {
	// Thanks to https://stackoverflow.com/a/6178290
	float theta = 2.0 * 3.1415926 * RandomValue(state);
	float rho = sqrt(- 2.0 * log(RandomValue(state)));
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

// Sky colors
const vec3 SkyColourHorizon = vec3(0.13, 0.49, 0.97);  // Light blue
const vec3 SkyColourZenith = vec3(0.529,0.808,0.922);   // Darker blue

// Sun properties
const vec3 SunLightDirection = normalize(vec3(0.5, 0.8, 0.3));  // Angled sunlight
const float SunFocus = 0.3;  // Sharpness of the sun disc
const float SunIntensity = 1.0;  // Brightness of the sun

// Ground color
const vec3 GroundColour = vec3(0.53, 0.6, 0.62);  // Dark grey

// Lerp function (linear interpolation)
vec3 lerp(vec3 a, vec3 b, float t) {
    return a + t * (b - a);
}

// Simple background environment lighting
vec3 GetEnvironmentLight (Ray ray) {
	float skyGradientT = pow(smoothstep(0.0, 0.4, ray.dir.y), 0.35);
	vec3 skyGradient = lerp(SkyColourHorizon, SkyColourZenith, skyGradientT);
	float sun = pow(max(0.0, dot(ray.dir, -SunLightDirection)), SunFocus) * SunIntensity;
	// Combine ground, sky, and sun
	float groundToSkyT = smoothstep(-0.01, 0.0, ray.dir.y);
	float sunMask = float(groundToSkyT >= 1.0);
	return lerp(GroundColour, skyGradient, groundToSkyT) + sun * sunMask;
}

// Trace the path of a ray of light (in reverse) as it travels from the camera,
// reflects off objects in the scene, and ends up (hopefully) at a light source.
vec3 Trace(Ray ray, inout uint rngState) {

	vec3 incomingLight = vec3(0.0);
	vec3 rayColor = vec3(1.0);

	for(int i = 0; i <= maxBounceCount; i ++) {

		HitInfo hitInfo = CalculateRayCollision(ray);

		if(hitInfo.didHit) {

			vec3 randomDir = normalize(hitInfo.normal + RandomDirection(rngState));
			randomDir = randomDir * sign(dot(hitInfo.normal, randomDir));
			RayTracingMaterial material = hitInfo.material;

			vec3 emittedLight = material.emissionColor * material.emissionStrength;
			incomingLight += emittedLight * rayColor;
			rayColor *= material.color;

			// arrange data for next bounce
			ray.origin = hitInfo.hitPoint;
			ray.dir = randomDir;

		} else {
			incomingLight = GetEnvironmentLight(ray) * rayColor;
			break;
		}

	}
	return incomingLight;
}

void main() {
      // Calculate normalized device coordinates (NDC)
	vec2 ndc = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;

      // Generate ray
	Ray ray = generateRay(ndc);
	uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

	vec3 totalIncomingLight = vec3(0.0);
	for( int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex++ ) {
		totalIncomingLight += Trace(ray, seed);
	}
	vec3 pixColor = totalIncomingLight / float(numRaysPerPixel);
	gl_FragColor = vec4(pixColor, 1.0);

}