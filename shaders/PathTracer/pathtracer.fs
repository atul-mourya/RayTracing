precision highp float;

#include common.fs
#include struct.fs
#include random.fs
#include rayintersection.fs
#include environment.fs


uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform sampler2D triangleTexture;
uniform vec2 triangleTexSize;
uniform sampler2D meshInfoTexture;
uniform vec2 meshInfoTexSize;
uniform Sphere spheres[ MAX_SPHERE_COUNT ];


vec4 getTriangleVertex(sampler2D tex, vec2 texSize, int triangleIndex, int vertexIndex) {
    float trianglesPerRow = texSize.x / 3.0;
    float row = floor(float(triangleIndex) / trianglesPerRow);
    float col = mod(float(triangleIndex), trianglesPerRow);
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

			int triangleIndex = meshInfo.firstTriangleIndex + i;
			vec4 v0 = getTriangleVertex(triangleTexture, triangleTexSize, triangleIndex, 0);
			vec4 v1 = getTriangleVertex(triangleTexture, triangleTexSize, triangleIndex, 1);
			vec4 v2 = getTriangleVertex(triangleTexture, triangleTexSize, triangleIndex, 2);

			vec3 n = normalize(vec3(v0.w, v1.w, v2.w));

			Triangle tri;
			tri.posA = v0.xyz;
			tri.posB = v1.xyz;
			tri.posC = v2.xyz;
			tri.normal = n;
			tri.material = meshInfo.material;

			HitInfo hitInfo = RayTriangle(ray, tri);
			if(hitInfo.didHit && hitInfo.dst < closestHit.dst) {
				closestHit = hitInfo;
			}
		}
	}

	return closestHit;
}


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
			ray.direction = randomDir;

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
	

	// // Debugging the RayIntersectsBox function with a known box
	// for(int meshIndex = 0; meshIndex < MAX_MESH_COUNT; meshIndex ++) {
		
	// 	MeshInfo meshInfo = getMeshInfo(meshIndex);
	// 	HitInfo boxHit = RayIntersectsBox(ray, meshInfo.boundsMin, meshInfo.boundsMax);
		
	// 	// Output the direction of the ray for debugging
	// 	vec3 rayDir = ray.direction * 0.5 + 0.5; // Normalize to [0, 1] range for color display

	// 	// Debugging output
	// 	if (boxHit.didHit) {
	// 		gl_FragColor += vec4(rayDir, 1.0); // Show ray direction if box hit
	// 	} else {
	// 		gl_FragColor += vec4(0.0, 0.0, 0.0, 1.0); // Black if no box hit
	// 	}
	// }

	// Debugging the RayIntersectsBox function with a known box
	// for(int meshIndex = 0; meshIndex < MAX_MESH_COUNT; meshIndex ++) {
	// 	HitInfo closestHit;
	// 	closestHit.didHit = false;
	// 	closestHit.dst = 1e20f; // A large value
	// 	MeshInfo meshInfo = getMeshInfo(meshIndex);
	// 	for(int i = 0; i < 10; i ++) {

	// 		int triangleIndex = meshInfo.firstTriangleIndex + i;
	// 		vec4 v0 = getTriangleVertex(triangleTexture, triangleTexSize, triangleIndex, 0);
	// 		vec4 v1 = getTriangleVertex(triangleTexture, triangleTexSize, triangleIndex, 1);
	// 		vec4 v2 = getTriangleVertex(triangleTexture, triangleTexSize, triangleIndex, 2);

	// 		vec3 n = normalize(vec3(v0.w, v1.w, v2.w));

	// 		Triangle tri;
	// 		tri.posA = v0.xyz;
	// 		tri.posB = v1.xyz;
	// 		tri.posC = v2.xyz;
	// 		tri.normal = n;
	// 		tri.material = meshInfo.material;

	// 		HitInfo hitInfo = RayTriangle(ray, tri);
	// 		if(hitInfo.didHit && hitInfo.dst < closestHit.dst) {
	// 			gl_FragColor = vec4(n, 1.0);

	// 		}
	// 	}
	// }

}