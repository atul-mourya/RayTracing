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

vec4 getTriangleVertex(sampler2D tex, vec2 texSize, int triangleIndex, int vertexIndex) {
	int pixelIndex = triangleIndex * 3 + vertexIndex;
	int x = pixelIndex % int(texSize.x);
	int y = pixelIndex / int(texSize.x);
	return texelFetch(tex, ivec2(x, y), 0);
}

MeshInfo getMeshInfo(int index) {
	int pixelIndex = index * 5;
	int x = pixelIndex % int(meshInfoTexSize.x);
	int y = pixelIndex / int(meshInfoTexSize.x);

	MeshInfo info;
	vec4 data1 = texelFetch(meshInfoTexture, ivec2(x + 0, y), 0);
	vec4 data2 = texelFetch(meshInfoTexture, ivec2(x + 1, y), 0);
	vec4 data3 = texelFetch(meshInfoTexture, ivec2(x + 2, y), 0);
	vec4 data4 = texelFetch(meshInfoTexture, ivec2(x + 3, y), 0);
	vec4 data5 = texelFetch(meshInfoTexture, ivec2(x + 4, y), 0);

	info.firstTriangleIndex = int(data1.x);
	info.numTriangles = int(data1.y);
	info.material.color = data2.rgb;
	info.material.emissive = data3.rgb;
	info.material.emissiveIntensity = data3.a;
	info.boundsMin = data4.xyz;
	info.boundsMax = data5.xyz;

	return info;
}

HitInfo CalculateRayCollision(Ray ray) {
	HitInfo closestHit;
	closestHit.didHit = false;
	closestHit.dst = 1e20; // A large value

	for(int i = 0; i < MAX_SPHERE_COUNT; i ++) {
		HitInfo hitInfo = RaySphere(ray, spheres[ i ]);
		if(hitInfo.didHit && hitInfo.dst < closestHit.dst) {
			closestHit = hitInfo;
		}
	}

	for(int meshIndex = 0; meshIndex < MAX_MESH_COUNT; meshIndex ++) {

		MeshInfo meshInfo = getMeshInfo(meshIndex);
		if (!RayBoundingBox(ray, meshInfo.boundsMin, meshInfo.boundsMax)) {
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
	vec3 incomingLight = vec3(0.0);
	vec3 rayColor = vec3(1.0);


	for(int i = 0; i <= maxBounceCount; i ++) {
		HitInfo hitInfo = CalculateRayCollision(ray);

		if(hitInfo.didHit) {
			RayTracingMaterial material = hitInfo.material;

			// Figure out new ray position and direction
			float randomValue = RandomValue(rngState);
			float specularBounce = material.specularProbability >= randomValue ? randomValue : material.specularProbability;

			//Calculate diffuse and specular directions
			vec3 diffuseDir = normalize(hitInfo.normal + RandomDirection(rngState));
			vec3 specularDir = reflect(ray.direction, hitInfo.normal);
			ray.direction = normalize(lerp(diffuseDir, specularDir, material.roughness * specularBounce));

			vec3 emittedLight = material.emissive * material.emissiveIntensity;
			incomingLight += emittedLight * rayColor;
			rayColor *= lerp(material.color, material.specularColor, specularBounce);

            // Prepare data for the next bounce
			ray.origin = hitInfo.hitPoint;

			// Random early exit if ray colour is nearly 0 (can't contribute much to final result)
			float p = max(rayColor.r, max(rayColor.g, rayColor.b));
			if (RandomValue(rngState) >= p) {
				break;
			}
			rayColor *= 1.0 / p; 

		} else {
            // If no hit, gather environment light
			incomingLight += GetEnvironmentLight(ray) * rayColor;
			break;
		}
	}
	return incomingLight;
}

vec4 debugNormals( Ray ray ) {

	vec4 color = vec4(0.0);

	for(int meshIndex = 0; meshIndex < MAX_MESH_COUNT; meshIndex++) {
		HitInfo closestHit;
		closestHit.didHit = false;
		closestHit.dst = 1e20; // A large value
		MeshInfo meshInfo = getMeshInfo(meshIndex);
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
				color = vec4(n, 1.0);

			}
		}
	}

	return color;
}

vec4 debugBoundingBox( Ray ray ) {
	vec4 color = vec4(0.0);
	for(int meshIndex = 0; meshIndex < MAX_MESH_COUNT; meshIndex ++) {
		MeshInfo meshInfo = getMeshInfo(meshIndex);
		vec3 rayDir = ray.direction * 0.5 + 0.5; // Normalize to [0, 1] range for color display
		if (RayBoundingBox( ray, meshInfo.boundsMin, meshInfo.boundsMax)) {
			color += vec4(rayDir, 1.0); // Show ray direction if box hit
		}
	}
	return color;
}

void main() {
	vec2 screenPosition = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;
    
    Ray ray = generateRayFromCamera(screenPosition);
    uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

    vec3 totalIncomingLight = vec3(0.0);
    for(int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex ++) {
        totalIncomingLight += Trace(ray, seed);
    }
    vec3 pixColor = totalIncomingLight / float(numRaysPerPixel);
    gl_FragColor = vec4(pixColor, 1.0);

    // gl_FragColor = debugBoundingBox(ray);
    // gl_FragColor = debugNormals(ray);

}