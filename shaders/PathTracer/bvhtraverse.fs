
uniform sampler2D triangleTexture;
uniform vec2 triangleTexSize;

uniform sampler2D materialTexture;
uniform vec2 materialTexSize;

uniform sampler2D bvhTexture;
uniform vec2 bvhTexSize;

uniform bool visualizeBVH;
uniform int maxBVHDepth;

struct BVHNode {
    vec3 boundsMin;
    int leftChild;
    vec3 boundsMax;
    int rightChild;
    vec2 triOffset;
    vec2 padding;
};

vec4 getDatafromDataTexture(sampler2D tex, vec2 texSize, int stride, int sampleIndex, int dataOffset) {
	int pixelIndex = stride * dataOffset + sampleIndex;
	int x = pixelIndex % int(texSize.x);
	int y = pixelIndex / int(texSize.x);
	return texelFetch(tex, ivec2(x, y), 0);
}

BVHNode getBVHNode(int index) {
    vec4 data1 = getDatafromDataTexture(bvhTexture, bvhTexSize, index, 0, 4);
    vec4 data2 = getDatafromDataTexture(bvhTexture, bvhTexSize, index, 1, 4);
    vec4 data3 = getDatafromDataTexture(bvhTexture, bvhTexSize, index, 2, 4);

    BVHNode node;
    node.boundsMin = data1.xyz;
    node.leftChild = int(data1.w);
    node.boundsMax = data2.xyz;
    node.rightChild = int(data2.w);
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
    material.roughness = data3.r;
    material.metalness = data3.g;
    material.ior = data3.b;
    material.transmission = data3.a;

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

    int stack[32];
    int stackSize = 0;
    stack[stackSize++] = 0; // Root node

    while (stackSize > 0) {
        int nodeIndex = stack[--stackSize];
        BVHNode node = getBVHNode(nodeIndex);

		if (node.leftChild < 0) { // Leaf node
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

			int childAIndex = node.leftChild;
			int childBIndex = node.rightChild;

			BVHNode childA = getBVHNode(childAIndex);
			BVHNode childB = getBVHNode(childBIndex);

			float dstA = RayBoundingBoxDst(ray, childA.boundsMin, childA.boundsMax);
			float dstB = RayBoundingBoxDst(ray, childB.boundsMin, childB.boundsMax);

			bool isNearestA = dstA < dstB;
			
			float dstNear = isNearestA ? dstA : dstB;
			float dstFar = isNearestA ? dstB : dstA;

			int childIndexNear = isNearestA ? childAIndex : childBIndex;
			int childIndexFar = isNearestA ? childBIndex : childAIndex;

			// we want closest child to be looked at first, so it should be pushed last
			if (dstFar < closestHit.dst) stack[stackSize++] = childIndexFar;
			if (dstNear < closestHit.dst) stack[stackSize++] = childIndexNear;
			
		}

    }

    return closestHit;
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

void drawBVH(Ray ray, inout vec3 color) {
    int stack[32];
    int depthStack[32];
    int stackSize = 0;
    
    stack[stackSize] = 0;  // Root node
    depthStack[stackSize] = 0;
    stackSize++;

    while (stackSize > 0) {
        stackSize--;
        int nodeIndex = stack[stackSize];
        int depth = depthStack[stackSize];

        if (depth > maxBVHDepth) continue;

        BVHNode node = getBVHNode(nodeIndex);
        
        float tMin, tMax;
        if (intersectAABB(ray, node.boundsMin, node.boundsMax, tMin, tMax)) {
            vec3 nodeColor = getColorForDepth(depth);
            float alpha = 0.1 * float(maxBVHDepth - depth) / float(maxBVHDepth);
            color = mix(color, nodeColor, alpha);

            if (node.leftChild >= 0) {  // Not a leaf node
                stack[stackSize] = node.rightChild;
                depthStack[stackSize] = depth + 1;
                stackSize++;

                stack[stackSize] = node.leftChild;
                depthStack[stackSize] = depth + 1;
                stackSize++;
            }
        }
    }
}