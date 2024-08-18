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
uniform sampler2DArray diffuseTextures;
uniform sampler2D triangleTexture;
uniform vec2 triangleTexSize;
uniform sampler2D bvhTexture;
uniform vec2 bvhTexSize;
uniform sampler2D materialTexture;
uniform vec2 materialTexSize;
uniform samplerCube sceneBackground;

vec4 getDatafromDataTexture(sampler2D tex, vec2 texSize, int stride, int sampleIndex, int dataOffset) {
	int pixelIndex = stride * dataOffset + sampleIndex;
	int x = pixelIndex % int(texSize.x);
	int y = pixelIndex / int(texSize.x);
	return texelFetch(tex, ivec2(x, y), 0);
}

vec3 sampleAlbedoTexture(RayTracingMaterial material, vec2 uv) {
    int textureIndex = material.map;
    if (textureIndex >= 0) {
        return linearTosRGB(texture(diffuseTextures, vec3(uv, float(textureIndex))).rgb);
    }
    return material.color;
}

struct BVHNode {
    vec3 boundsMin;
    float leftChild;
    vec3 boundsMax;
    float rightChild;
    vec2 triOffset;
    vec2 padding;
};

BVHNode getBVHNode(int index) {
    vec4 data1 = getDatafromDataTexture(bvhTexture, bvhTexSize, index, 0, 4);
    vec4 data2 = getDatafromDataTexture(bvhTexture, bvhTexSize, index, 1, 4);
    vec4 data3 = getDatafromDataTexture(bvhTexture, bvhTexSize, index, 2, 4);

    BVHNode node;
    node.boundsMin = data1.xyz;
    node.leftChild = data1.w;
    node.boundsMax = data2.xyz;
    node.rightChild = data2.w;
    node.triOffset = data3.xy;
    return node;
}

RayTracingMaterial getMaterial(int materialIndex) {
    vec4 data1 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 0, 4);
    vec4 data2 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 1, 4);
    vec4 data3 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 2, 4);
    vec4 data4 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 3, 4);

    RayTracingMaterial material;
    material.color = data1.rgb;
    material.map = int(data1.a);
    material.emissive = data2.rgb;
    material.emissiveIntensity = data2.a;
    material.roughness = data3.x;
    material.metalness = data3.y;

    return material;
}

Triangle getTriangle(int triangleIndex) {
	vec4 s0 = getDatafromDataTexture(triangleTexture, triangleTexSize, triangleIndex, 0, 6);
	vec4 s1 = getDatafromDataTexture(triangleTexture, triangleTexSize, triangleIndex, 1, 6);
	vec4 s2 = getDatafromDataTexture(triangleTexture, triangleTexSize, triangleIndex, 2, 6);
	vec4 s3 = getDatafromDataTexture(triangleTexture, triangleTexSize, triangleIndex, 3, 6);
	vec4 s4 = getDatafromDataTexture(triangleTexture, triangleTexSize, triangleIndex, 4, 6);
	vec4 s5 = getDatafromDataTexture(triangleTexture, triangleTexSize, triangleIndex, 5, 6);

	Triangle tri;
	tri.posA = s0.xyz;
	tri.posB = s1.xyz;
	tri.posC = s2.xyz;
	tri.normal = normalize(vec3(s0.w, s1.w, s2.w));
	tri.uvA = s3.xy;
	tri.uvB = s4.xy;
	tri.uvC = s5.xy;
    
	tri.materialIndex = int(s5.z);

    return tri;
}

HitInfo traverseBVH(Ray ray) {
    HitInfo closestHit;
    closestHit.didHit = false;
    closestHit.dst = 1e20;

    int stack[64];
    int stackSize = 0;
    stack[stackSize++] = 0; // Root node

    while (stackSize > 0) {
        int nodeIndex = stack[--stackSize];
        BVHNode node = getBVHNode(nodeIndex);

        if (RayBoundingBoxDst(ray, node.boundsMin, node.boundsMax) < closestHit.dst) {
            
			if (node.leftChild < 0.0) { // Leaf node
				for (int i = 0; i < int(node.triOffset.y); i++) {
					int triIndex = int(node.triOffset.x) + i;
					Triangle tri = getTriangle(triIndex);
					HitInfo hit = RayTriangle(ray, tri);
					if (hit.didHit && hit.dst < closestHit.dst) {
						closestHit = hit;
						closestHit.material = getMaterial(tri.materialIndex);
					}
				}
			} else {
				stack[stackSize++] = int(node.rightChild);
				stack[stackSize++] = int(node.leftChild);
			}

		}
    }

    return closestHit;
}

HitInfo CalculateRayCollision(Ray ray) {
    return traverseBVH(ray);
}

vec3 Trace(Ray ray, inout uint rngState) {
	vec3 incomingLight = vec3(0.0);
	vec3 rayColor = vec3(1.0);

	for(int i = 0; i <= maxBounceCount; i ++) {
		HitInfo hitInfo = CalculateRayCollision(ray);

		if(hitInfo.didHit) {
			RayTracingMaterial material = hitInfo.material;

			vec3 albedo = sampleAlbedoTexture(material, hitInfo.uv);

            // Calculate emitted light
            vec3 emittedLight = material.emissive * material.emissiveIntensity;
            incomingLight += emittedLight * rayColor;

            // Calculate new ray direction based on material properties
			vec3 diffuseDir = normalize(hitInfo.normal + RandomDirection(rngState));
			vec3 specularDir = reflect(ray.direction, hitInfo.normal);
            
            // Interpolate between diffuse and specular based on roughness
            vec3 newDir = normalize(mix(specularDir, diffuseDir, material.roughness * material.roughness));

            // Calculate Fresnel effect (Schlick approximation)
            vec3 F0 = mix(vec3(0.04), albedo, material.metalness);
            float cosTheta = max(dot(hitInfo.normal, -ray.direction), 0.0);
            vec3 fresnel = F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);

            // Combine diffuse and specular contributions
            vec3 specularColor = fresnel;
            vec3 diffuseColor = albedo * (1.0 - material.metalness) * (vec3(1.0) - fresnel);

            // Update ray color
            rayColor *= (diffuseColor + specularColor);

            // Prepare data for the next bounce
			ray.origin = hitInfo.hitPoint + hitInfo.normal * 0.001; // Slight offset to prevent self-intersection
			ray.direction = newDir;

			// Random early exit if ray colour is nearly 0 (can't contribute much to final result)
			float p = max(rayColor.r, max(rayColor.g, rayColor.b));
			if (RandomValue(rngState) >= p) {
				break;
			}
			rayColor *= 1.0 / p; 

		} else {
            // If no hit, gather environment light
			// incomingLight += GetEnvironmentLight(ray) * rayColor;
			incomingLight += textureCube(sceneBackground, ray.direction).rgb * rayColor;
			break;
		}
	}
	return incomingLight;
}

vec3 getColorForDepth(int depth) {
    vec3 colors[6] = vec3[](
        vec3(1.0, 0.0, 0.0),  // Red
        vec3(0.0, 1.0, 0.0),  // Green
        vec3(0.0, 0.0, 1.0),  // Blue
        vec3(1.0, 1.0, 0.0),  // Yellow
        vec3(1.0, 0.0, 1.0),  // Magenta
        vec3(0.0, 1.0, 1.0)   // Cyan
    );
    return colors[depth % 6];
}

void visualizeBVH(Ray ray, inout vec3 color, int maxDepth) {
    int stack[64];
    int depthStack[64];
    int stackSize = 0;
    
    stack[stackSize] = 0;  // Root node
    depthStack[stackSize] = 0;
    stackSize++;

    while (stackSize > 0) {
        stackSize--;
        int nodeIndex = stack[stackSize];
        int depth = depthStack[stackSize];

        if (depth > maxDepth) continue;

        BVHNode node = getBVHNode(nodeIndex);
        
        float tMin, tMax;
        if (intersectAABB(ray, node.boundsMin, node.boundsMax, tMin, tMax)) {
            vec3 nodeColor = getColorForDepth(depth);
            float alpha = 0.1 * float(maxDepth - depth) / float(maxDepth);
            color = mix(color, nodeColor, alpha);

            if (node.leftChild < 0.0) {  // Leaf node
                // Visualize leaf nodes differently if desired
            } else {
                stack[stackSize] = int(node.rightChild);
                depthStack[stackSize] = depth + 1;
                stackSize++;

                stack[stackSize] = int(node.leftChild);
                depthStack[stackSize] = depth + 1;
                stackSize++;
            }
        }
    }
}

void main() {

	// vec2 screenPosition = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;
    // Ray ray = generateRayFromCamera(screenPosition);

    // vec3 color = vec3(0.0);
    // visualizeBVH(ray, color, 20);  // Visualize up to 20 levels deep

    // gl_FragColor = vec4(color, 1.0);

    vec2 pixelSize = 1.0 / resolution;
    vec2 screenPosition = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;
    
    uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

    vec3 totalIncomingLight = vec3(0.0);
    for(int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex++) {

        vec2 jitter = RandomPointInCircle(seed) * pixelSize;
        vec2 jitteredScreenPosition = screenPosition + jitter;
        
        Ray ray = generateRayFromCamera(jitteredScreenPosition);
        
        totalIncomingLight += Trace(ray, seed);
    }
    vec3 pixColor = totalIncomingLight / float(numRaysPerPixel);
    gl_FragColor = vec4(pixColor, 1.0);
}