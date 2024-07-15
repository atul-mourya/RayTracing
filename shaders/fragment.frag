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

struct Triangle {
	vec3 posA, posB, posC;
	vec3 normalA, normalB, normalC;
	RayTracingMaterial material;
};

struct MeshInfo {
	uint firstTriangleIndex;
	uint numTriangles;
	RayTracingMaterial material;
	vec3 boundsMin;
	vec3 boundsMax;
};

const float PI = 3.14159;

uniform vec2 resolution;
uniform vec3 cameraPos;
uniform vec3 cameraDir;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform uint frame;

uniform int numSpheres;
uniform Sphere spheres[ 4 ];

uniform int numTriangles;
uniform Triangle triangles[ 1 ];
// uniform MeshInfo meshes[ 1 ];

Ray generateRay(vec2 uv) {
	Ray ray;
	ray.origin = cameraPos;
	ray.dir = normalize(cameraDir + uv.x * cameraRight + uv.y * cameraUp);
	return ray;
}

// Calculate the intersection of a ray with a triangle using Möller-Trumbore algorithm
// Thanks to https://stackoverflow.com/a/42752998
HitInfo RayTriangle(Ray ray, Triangle tri) {
	vec3 edgeAB = tri.posB - tri.posA;
	vec3 edgeAC = tri.posC - tri.posA;
	vec3 normalVector = cross(edgeAB, edgeAC);
	vec3 ao = ray.origin - tri.posA;
	vec3 dao = cross(ao, ray.dir);

	float determinant = - dot(ray.dir, normalVector);
	float invDet = 1.0 / determinant;

	// Calculate dst to triangle & barycentric coordinates of intersection point
	float dst = dot(ao, normalVector) * invDet;
	float u = dot(edgeAC, dao) * invDet;
	float v = - dot(edgeAB, dao) * invDet;
	float w = 1.0 - u - v;

	// Initialize hit info
	HitInfo hitInfo;
	hitInfo.didHit = determinant >= 1E-6 && dst >= 0.0 && u >= 0.0 && v >= 0.0 && w >= 0.0;
	hitInfo.hitPoint = ray.origin + ray.dir * dst;
	hitInfo.normal = normalize(tri.normalA * w + tri.normalB * u + tri.normalC * w); 
	hitInfo.dst = dst;
	hitInfo.material = tri.material;
	return hitInfo;
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

	for(int i = 0; i < numTriangles; i ++) {
		HitInfo hitInfo = RayTriangle(ray, triangles[ i ]);
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


// Lerp function (linear interpolation)
vec3 lerp(vec3 a, vec3 b, float t) {
	return a + t * (b - a);
}

// Simple background environment lighting
vec3 GetEnvironmentLight(Ray ray) {
    // Sky colors
    const vec3 SkyColourHorizon = vec3(0.13, 0.49, 0.97);  // Light blue
    const vec3 SkyColourZenith = vec3(0.529, 0.808, 0.922);   // Darker blue

    // Sun properties
    float sunAzimuth = 2.0 * PI - PI / 4.0;  // Angle around the horizon (0 to 2π)
    float sunElevation = - PI / 4.0;  // Angle above the horizon (-π/2 to π/2)
    const float SunFocus = 512.0;
    const float SunIntensity = 100.0;

    // Ground color
    const vec3 GroundColour = vec3(0.53, 0.6, 0.62);  // Dark grey

    // Calculate sun direction from angles
    vec3 SunLightDirection = vec3(
        cos(sunElevation) * sin(sunAzimuth),
        sin(sunElevation),
        cos(sunElevation) * cos(sunAzimuth)
    );

    float skyGradientT = pow(smoothstep(0.0, 0.4, ray.dir.y), 0.35);
    vec3 skyGradient = lerp(SkyColourHorizon, SkyColourZenith, skyGradientT);
    
    // Calculate sun contribution
    float sunDot = max(0.0, dot(ray.dir, -SunLightDirection));
    float sun = pow(sunDot, SunFocus) * SunIntensity;
    
    // Combine ground, sky, and sun
    float groundToSkyT = smoothstep(-0.01, 0.0, ray.dir.y);
    float sunMask = (groundToSkyT >= 1.0) ? 1.0 : 0.0;
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
	vec2 ndc = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;

	Ray ray = generateRay(ndc);
	uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

	vec3 totalIncomingLight = vec3(0.0);
	for(int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex ++) {
		totalIncomingLight += Trace(ray, seed);
	}
	vec3 pixColor = totalIncomingLight / float(numRaysPerPixel);
	gl_FragColor = vec4(pixColor, 1.0);

}