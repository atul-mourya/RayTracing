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
uniform float sceneEnvironmentIntensity;

uniform bool visualizeBVH;
uniform int maxBVHDepth;

vec4 getDatafromDataTexture(sampler2D tex, vec2 texSize, int stride, int sampleIndex, int dataOffset) {
	int pixelIndex = stride * dataOffset + sampleIndex;
	int x = pixelIndex % int(texSize.x);
	int y = pixelIndex / int(texSize.x);
	return texelFetch(tex, ivec2(x, y), 0);
}

vec3 sampleAlbedoTexture(RayTracingMaterial material, vec2 uv) {
    int textureIndex = material.map;
    if (textureIndex >= 0) {
        return sRGBToLinear(texture(diffuseTextures, vec3(uv, float(textureIndex))).rgb);
    }
    return material.color;
}

struct BVHNode {
    vec3 boundsMin;
    int leftChild;
    vec3 boundsMax;
    int rightChild;
    vec2 triOffset;
    vec2 padding;
};

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

HitInfo CalculateRayCollision(Ray ray) {
    return traverseBVH(ray);
}

vec3 sampleGGX(vec3 N, float roughness, vec2 Xi) {
    float a = roughness * roughness;
    float phi = 2.0 * PI * Xi.x;
    float cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (a*a - 1.0) * Xi.y));
    float sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    
    vec3 H;
    H.x = sinTheta * cos(phi);
    H.y = sinTheta * sin(phi);
    H.z = cosTheta;
    
    vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangentX = normalize(cross(up, N));
    vec3 tangentY = cross(N, tangentX);
    
    return tangentX * H.x + tangentY * H.y + N * H.z;
}

vec3 fresnel(vec3 f0, float NoV, float roughness) {
    return f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - NoV, 5.0);
}

float luminance( vec3 color ) {

	// https://en.wikipedia.org/wiki/Relative_luminance
	return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

}

// Add these uniforms at the top of your shader
uniform vec3 directionalLightDirection;
uniform vec3 directionalLightColor;
uniform float directionalLightIntensity;

// Add these functions for BRDF calculations
float DistributionGGX(vec3 N, vec3 H, float roughness) {
    float a = roughness*roughness;
    float a2 = a*a;
    float NdotH = max(dot(N, H), 0.0);
    float NdotH2 = NdotH*NdotH;

    float nom   = a2;
    float denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = PI * denom * denom;

    return nom / denom;
}

float GeometrySchlickGGX(float NdotV, float roughness) {
    float r = (roughness + 1.0);
    float k = (r*r) / 8.0;

    float nom   = NdotV;
    float denom = NdotV * (1.0 - k) + k;

    return nom / denom;
}

float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
    float NdotV = max(dot(N, V), 0.0);
    float NdotL = max(dot(N, L), 0.0);
    float ggx2 = GeometrySchlickGGX(NdotV, roughness);
    float ggx1 = GeometrySchlickGGX(NdotL, roughness);

    return ggx1 * ggx2;
}

// Add this function to calculate direct lighting
vec3 calculateDirectLighting(HitInfo hitInfo, vec3 viewDirection) {
	if( directionalLightIntensity <= 0.0 ) return vec3(0.0);
    vec3 lightDir = normalize(-directionalLightDirection);
    float NdotL = max(dot(hitInfo.normal, lightDir), 0.0);
    
    // Check for shadows
    Ray shadowRay;
    shadowRay.origin = hitInfo.hitPoint + hitInfo.normal * 0.001; // Offset to avoid self-intersection
    shadowRay.direction = lightDir;
    HitInfo shadowHit = CalculateRayCollision(shadowRay);
    
    if (shadowHit.didHit) {
        return vec3(0.0); // Point is in shadow
    }
    
    // Calculate BRDF
    vec3 halfVector = normalize(lightDir + viewDirection);
    float NdotV = max(dot(hitInfo.normal, viewDirection), 0.0);
    
    vec3 F0 = mix(vec3(0.04), hitInfo.material.color, hitInfo.material.metalness);
    vec3 F = fresnel(F0, NdotV, hitInfo.material.roughness);
    
    float D = DistributionGGX(hitInfo.normal, halfVector, hitInfo.material.roughness);
    float G = GeometrySmith(hitInfo.normal, viewDirection, lightDir, hitInfo.material.roughness);
    
    vec3 numerator = D * G * F;
    float denominator = 4.0 * NdotV * NdotL + 0.0001;
    vec3 specular = numerator / denominator;
    
    vec3 kS = F;
    vec3 kD = vec3(1.0) - kS;
    kD *= 1.0 - hitInfo.material.metalness;
    
    vec3 diffuse = kD * hitInfo.material.color / PI;
    
    return (diffuse + specular) * directionalLightColor * directionalLightIntensity * NdotL;
}

// Modify your Trace function to include direct lighting
vec3 Trace(Ray ray, inout uint rngState) {
	vec3 incomingLight = vec3(0.0);
	vec3 rayColor = vec3(1.0);
	uint depth = 0u;

	for(int i = 0; i <= maxBounceCount; i ++) {
		HitInfo hitInfo = CalculateRayCollision(ray);

		depth ++;

		if(hitInfo.didHit) {
			// Calculate direct lighting from the directional light
			vec3 directLight = calculateDirectLighting(hitInfo, -ray.direction);
			incomingLight += directLight * rayColor;

			RayTracingMaterial material = hitInfo.material;
			vec3 albedo = sampleAlbedoTexture(material, hitInfo.uv);

            // Calculate emitted light
            vec3 emittedLight = material.emissive * material.emissiveIntensity;
            incomingLight += emittedLight * rayColor;

            // Handle transparent materials
            if (material.transmission > 0.0) {
                float iorRatio = dot(ray.direction, hitInfo.normal) < 0.0 ? 
                    (1.0 / material.ior) : material.ior;
                
                vec3 refractionDir = refract(ray.direction, hitInfo.normal, iorRatio);
				if (dot(refractionDir, refractionDir) == 0.0) { // Total internal reflection
					ray.direction = reflect(ray.direction, hitInfo.normal);
				} else {
					// Calculate Fresnel for transparent material
					float cosTheta = abs(dot(ray.direction, hitInfo.normal));
					float F0 = pow((1.0 - material.ior) / (1.0 + material.ior), 2.0);
					float fresnelFactor = F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
					
					// Probabilistically choose between reflection and refraction
					if (RandomValue(rngState) < fresnelFactor) { // Reflection
						ray.direction = reflect(ray.direction, hitInfo.normal); 
					} else { // Refraction
						ray.direction = refractionDir;
					}
				}
				// Apply transparency
				rayColor *= mix(vec3(1.0), albedo, 1.0 - material.transmission);
			
			} else {
				// Non-transparent material handling (previous code)
				vec2 Xi = vec2(RandomValue(rngState), RandomValue(rngState));
				vec3 H = sampleGGX(hitInfo.normal, material.roughness, Xi);
				vec3 newDir = reflect(ray.direction, H);

				// Calculate Fresnel effect (Schlick approximation)
				vec3 F0 = mix(vec3(0.04), albedo, material.metalness);
				float NoV = max(dot(hitInfo.normal, -ray.direction), 0.0);
				vec3 F = fresnel(F0, NoV, material.roughness);

				// Combine diffuse and specular contributions
				vec3 specularColor = F;
				vec3 diffuseColor = albedo * (1.0 - material.metalness) * (vec3(1.0) - F);

				// Probabilistically choose between diffuse and specular reflection
				float specularProb = luminance(specularColor);
				if (RandomValue(rngState) < specularProb) {
					rayColor *= specularColor / specularProb;
					ray.direction = newDir;
				} else {
					vec3 diffuseDir = normalize(hitInfo.normal + RandomDirection(rngState));
					ray.direction = diffuseDir;
					rayColor *= diffuseColor / (1.0 - specularProb);
				}
            }

			// russian roulette path termination
			// https://www.arnoldrenderer.com/research/physically_based_shader_design_in_arnold.pdf
			uint minBounces = 3u;
			float depthProb = float( depth < minBounces );
			float rrProb = luminance( rayColor );
			rrProb = sqrt( rrProb );
			rrProb = max( rrProb, depthProb );
			rrProb = min( rrProb, 1.0 );
			if ( RandomValue(rngState) > rrProb ) {

				break;

			}

			// perform sample clamping here to avoid bright pixels
			rayColor *= min(1.0 / rrProb, 20.0);

			// Prepare data for the next bounce
			ray.origin = hitInfo.hitPoint + ray.direction * 0.001; // Slight offset to prevent self-intersection

		} else {
            // If no hit, gather environment light
			// incomingLight += GetEnvironmentLight(ray) * rayColor;
			incomingLight += textureCube(sceneBackground, ray.direction).rgb * rayColor * sceneEnvironmentIntensity;
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

void main() {

	vec2 pixelSize = 1.0 / resolution;
    vec2 screenPosition = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;

    vec3 finalColor = vec3(0.0);
    uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

    if (visualizeBVH) {
        Ray ray = generateRayFromCamera(screenPosition);
        drawBVH(ray, finalColor);
    } else {
        vec3 totalIncomingLight = vec3(0.0);
        for(int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex++) {
            vec2 jitter = RandomPointInCircle(seed) * pixelSize;
            vec2 jitteredScreenPosition = screenPosition + jitter;
            
            Ray ray = generateRayFromCamera(jitteredScreenPosition);
            
            totalIncomingLight += Trace(ray, seed);
        }
        finalColor = totalIncomingLight / float(numRaysPerPixel);
    }

    gl_FragColor = vec4(finalColor, 1.0);
}