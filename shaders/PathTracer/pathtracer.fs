precision highp float;

const float PI = 3.14159f;

uniform uint frame;
uniform vec2 resolution;
uniform vec3 cameraPos;
uniform vec3 cameraDir;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform int maxBounceCount;
uniform int numRaysPerPixel;

struct Ray {
	vec3 origin;
	vec3 dir;
};

struct RayTracingMaterial {
	vec3 color;
	vec3 emissive;
	float emissiveIntensity;
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
	int firstTriangleIndex;
	int numTriangles;
	RayTracingMaterial material;
	vec3 boundsMin;
	vec3 boundsMax;
};

uniform Sphere spheres[ MAX_SPHERE_COUNT ];

uniform sampler2D triangleTexture;
uniform vec2 triangleTexSize;
uniform sampler2D meshInfoTexture;
uniform vec2 meshInfoTexSize;

int count;

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
	float invDet = 1.0f / determinant;

    // Calculate distance to triangle & barycentric coordinates of intersection point
	float dst = dot(ao, normalVector) * invDet;
	float u = dot(edgeAC, dao) * invDet;
	float v = - dot(edgeAB, dao) * invDet;
	float w = 1.0f - u - v;

    // Initialize hit info
	HitInfo hitInfo;
	hitInfo.didHit = determinant >= 1E-6f && dst >= 0.0f && u >= 0.0f && v >= 0.0f && w >= 0.0f;
	hitInfo.hitPoint = ray.origin + ray.dir * dst;
	hitInfo.normal = normalize(tri.normalA * w + tri.normalB * u + tri.normalC * v);
	hitInfo.dst = dst;
	hitInfo.material = tri.material;
	return hitInfo;
}

HitInfo RaySphere(Ray ray, Sphere sphere) {
	HitInfo hitInfo;
	hitInfo.didHit = false;

	vec3 oc = ray.origin - sphere.position;
	float a = dot(ray.dir, ray.dir);
	float b = 2.0f * dot(oc, ray.dir);
	float c = dot(oc, oc) - sphere.radius * sphere.radius;
	float discriminant = b * b - 4.0f * a * c;

	if(discriminant > 0.0f) {
		float t = (- b - sqrt(discriminant)) / (2.0f * a);
		if(t > 0.0f) {
			hitInfo.didHit = true;
			hitInfo.dst = t;
			hitInfo.hitPoint = ray.origin + t * ray.dir;
			hitInfo.normal = normalize(hitInfo.hitPoint - sphere.position);
			hitInfo.material = sphere.material;
		}
	}

	return hitInfo;
}

vec4 getTriangleVertex(sampler2D tex, vec2 texSize, int triangleIndex, int vertexIndex) {
	float trianglePerRow = texSize.x / 3.0;
    float row = floor(float(triangleIndex) / trianglePerRow);
    float col = float(triangleIndex) - row * trianglePerRow;
    vec2 uv = vec2((col * 3.0 + float(vertexIndex)) / texSize.x, row / texSize.y);
    return texture(tex, uv);
}

MeshInfo getMeshInfo(int index) {
	vec2 uv = vec2(float(index) + 0.5f, 0.5f) / meshInfoTexSize;
	vec4 info1 = texture(meshInfoTexture, uv);
	vec4 info2 = texture(meshInfoTexture, uv + vec2(1.0f / meshInfoTexSize.x, 0.0f));
	vec4 info3 = texture(meshInfoTexture, uv + vec2(2.0f / meshInfoTexSize.x, 0.0f));
	vec4 info4 = texture(meshInfoTexture, uv + vec2(3.0f / meshInfoTexSize.x, 0.0f));
	vec4 info5 = texture(meshInfoTexture, uv + vec2(4.0f / meshInfoTexSize.x, 0.0f));

	MeshInfo meshInfo;
	meshInfo.firstTriangleIndex = int(info1.x);
	meshInfo.numTriangles = int(info1.y);
	meshInfo.material.color = info2.rgb;
	meshInfo.material.emissive = info3.rgb;
	meshInfo.material.emissiveIntensity = info3.a;
	meshInfo.boundsMin = info4.rgb;
	meshInfo.boundsMax = info5.rgb;

	return meshInfo;
}

HitInfo RayIntersectsBox(Ray ray, vec3 minBB, vec3 maxBB) {
	HitInfo hitInfo;
	hitInfo.didHit = false;

	vec3 invDir = 1.0 / ray.dir;
	vec3 tMin = (minBB - ray.origin) * invDir;
	vec3 tMax = (maxBB - ray.origin) * invDir;
	vec3 t1 = min(tMin, tMax);
	vec3 t2 = max(tMin, tMax);
	float tNear = max(max(t1.x, t1.y), t1.z);
	float tFar = min(min(t2.x, t2.y), t2.z);

	if (tNear <= tFar && tFar > 0.0) {
		hitInfo.didHit = true;
		hitInfo.dst = tNear;
		hitInfo.hitPoint = ray.origin + tNear * ray.dir;
		hitInfo.normal = vec3(0.0); // Box normals can be calculated as needed
	}

	return hitInfo;
}

HitInfo CalculateRayCollision(Ray ray) {
	HitInfo closestHit;
	closestHit.didHit = false;
	closestHit.dst = 1e20f; // A large value

	for(int i = 0; i < MAX_SPHERE_COUNT; i ++) {
		HitInfo hitInfo = RaySphere(ray, spheres[ i ]);
		if(hitInfo.didHit && hitInfo.dst < closestHit.dst) {
			closestHit = hitInfo;
		}
	}

	for(int meshIndex = 0; meshIndex < MAX_MESH_COUNT; meshIndex ++) {
		
		MeshInfo meshInfo = getMeshInfo(meshIndex);

		HitInfo boxHit = RayIntersectsBox(ray, meshInfo.boundsMin, meshInfo.boundsMax);
		if (!boxHit.didHit) {
			continue;
		}

		for(int i = 0; i < meshInfo.numTriangles; i ++) {

			vec4 v0 = getTriangleVertex(triangleTexture, triangleTexSize, i, 0);
			vec4 v1 = getTriangleVertex(triangleTexture, triangleTexSize, i, 1);
			vec4 v2 = getTriangleVertex(triangleTexture, triangleTexSize, i, 2);

			vec3 n = vec3(v0.w, v1.w, v2.w);

			Triangle tri;
			tri.posA = v0.xyz;
			tri.posB = v1.xyz;
			tri.posC = v2.xyz;
			tri.normalA = n;
			tri.normalB = n;
			tri.normalC = n;
			tri.material = meshInfo.material;

			HitInfo hitInfo = RayTriangle(ray, tri);
			if(hitInfo.didHit && hitInfo.dst < closestHit.dst) {
				closestHit = hitInfo;
			}
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

// Lerp function (linear interpolation)
vec3 lerp(vec3 a, vec3 b, float t) {
	return a + t * (b - a);
}

// Simple background environment lighting
vec3 GetEnvironmentLight(Ray ray) {
			// Sky colors
	const vec3 SkyColourHorizon = vec3(0.13f, 0.49f, 0.97f);  // Light blue
	const vec3 SkyColourZenith = vec3(0.529f, 0.808f, 0.922f);   // Darker blue

	// Sun properties
	float sunAzimuth = 2.0f * PI - PI / 4.0f;  // Angle around the horizon (0 to 2π)
	float sunElevation = - PI / 4.0f;  // Angle above the horizon (-π/2 to π/2)
	const float SunFocus = 512.0f;
	const float SunIntensity = 100.0f;

	// Ground color
	const vec3 GroundColour = vec3(0.53f, 0.6f, 0.62f);  // Dark grey

	// Calculate sun direction from angles
	vec3 SunLightDirection = vec3(cos(sunElevation) * sin(sunAzimuth), sin(sunElevation), cos(sunElevation) * cos(sunAzimuth));

	float skyGradientT = pow(smoothstep(0.0f, 0.4f, ray.dir.y), 0.35f);
	vec3 skyGradient = lerp(SkyColourHorizon, SkyColourZenith, skyGradientT);

	// Calculate sun contribution
	float sunDot = max(0.0f, dot(ray.dir, - SunLightDirection));
	float sun = pow(sunDot, SunFocus) * SunIntensity;

	// Combine ground, sky, and sun
	float groundToSkyT = smoothstep(- 0.01f, 0.0f, ray.dir.y);
	float sunMask = (groundToSkyT >= 1.0f) ? 1.0f : 0.0f;
	return lerp(GroundColour, skyGradient, groundToSkyT) + sun * sunMask;
}

// Trace the path of a ray of light (in reverse) as it travels from the camera,
// reflects off objects in the scene, and ends up (hopefully) at a light source.
vec3 Trace(Ray ray, inout uint rngState) {

	vec3 incomingLight = vec3(0.0f);
	vec3 rayColor = vec3(1.0f);

	for(int i = 0; i <= maxBounceCount; i ++) {

		HitInfo hitInfo = CalculateRayCollision(ray);

		if(hitInfo.didHit) {

			vec3 randomDir = normalize(hitInfo.normal + RandomDirection(rngState));
			randomDir = randomDir * sign(dot(hitInfo.normal, randomDir));
			RayTracingMaterial material = hitInfo.material;

			vec3 emittedLight = material.emissive * material.emissiveIntensity;
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
	vec2 ndc = (gl_FragCoord.xy / resolution) * 2.0f - 1.0f;

	Ray ray = generateRay(ndc);
	uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

	vec3 totalIncomingLight = vec3(0.0f);
	for(int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex ++) {
		totalIncomingLight += Trace(ray, seed);
	}
	vec3 pixColor = totalIncomingLight / float(numRaysPerPixel);
	gl_FragColor = vec4(pixColor, 1.0f);
	

	// vec4 pixColor = vec4(0.0, 0.0, 0.0, 1.0);

	// // Debugging the RayIntersectsBox function with a known box
	// for(int meshIndex = 0; meshIndex < MAX_MESH_COUNT; meshIndex ++) {
		
	// 	MeshInfo meshInfo = getMeshInfo(meshIndex);
	// 	HitInfo boxHit = RayIntersectsBox(ray, meshInfo.boundsMin, meshInfo.boundsMax);
		
	// 	// Output the direction of the ray for debugging
	// 	vec3 rayDir = ray.dir * 0.5 + 0.5; // Normalize to [0, 1] range for color display

	// 	// Debugging output
	// 	if (boxHit.didHit) {
	// 		pixColor += vec4(rayDir, 1.0); // Show ray direction if box hit
	// 	} else {
	// 		pixColor += vec4(0.0, 0.0, 0.0, 1.0); // Black if no box hit
	// 	}
	// }

	// gl_FragColor = pixColor;

}