precision highp float;

uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform bool useBackground;
uniform int checkeredFrameInterval;
uniform sampler2D previousFrameTexture;
uniform int renderMode; // 0: Regular, 1: Checkered, 2: Tiled
uniform int tiles; // number of tiles


#include common.fs
#include struct.fs
#include random.fs
#include rayintersection.fs
#include environment.fs
#include bvhtraverse.fs
#include pbr.fs
#include lights.fs

uniform int visMode;
uniform float debugVisScale;
ivec2 stats; // num triangle tests, num bounding box tests

vec3 reduceFireflies(vec3 color, float maxValue) {
    float luminance = dot(color, vec3(0.299, 0.587, 0.114));
    if (luminance > maxValue) {
        color *= maxValue / luminance;
    }
    return color;
}

void handleTransparentMaterial(inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, inout uint rngState, inout vec3 rayColor, inout float alpha) {
    bool entering = dot(ray.direction, hitInfo.normal) < 0.0;
    float n1 = entering ? 1.0 : material.ior;
    float n2 = entering ? material.ior : 1.0;
    vec3 normal = entering ? hitInfo.normal : -hitInfo.normal;

    vec3 reflectDir = reflect(ray.direction, normal);
    vec3 refractDir = refract(ray.direction, normal, n1 / n2);

    float cosTheta = abs(dot(-ray.direction, normal));
    float r0 = pow((n1 - n2) / (n1 + n2), 2.0);
    float fresnel = r0 + (1.0 - r0) * pow(1.0 - cosTheta, 5.0);
    fresnel = mix(fresnel, 1.0, pow(1.0 - cosTheta, 3.0));

    vec3 glassColor = material.color.rgb;
    vec3 tintColor = mix(vec3(1.0), glassColor, 0.5);

    if (length(refractDir) < 0.001 || RandomValue(rngState) < fresnel) {
        ray.direction = reflectDir;
        rayColor *= mix(vec3(1.0), glassColor, 0.2);
    } else {
        ray.direction = refractDir;
        if (entering) {
            vec3 absorption = (vec3(1.0) - glassColor) * material.thickness * 0.5;
            rayColor *= exp(-absorption * hitInfo.dst);
        }
        rayColor *= tintColor;
    }

    alpha *= (1.0 - material.transmission) * material.color.a;
    ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
}

void handleSpecularReflection(inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec4 blueNoise, inout vec3 rayColor, vec3 specularColor, float specularProb) {
    rayColor *= specularColor / specularProb;
    if (material.roughness < 0.001) { // Perfect mirror reflection for very low roughness
        ray.direction = reflect(ray.direction, hitInfo.normal);
    } else {
        vec2 Xi = blueNoise.xy;
        vec3 V = -ray.direction;
        vec3 H = ImportanceSampleGGX(hitInfo.normal, material.roughness, Xi);
        ray.direction = reflect(-V, H);
    }
}

void handleDiffuseReflection(inout Ray ray, HitInfo hitInfo, inout uint rngState, inout vec3 rayColor, vec3 diffuseColor, float specularProb) {
    vec3 diffuseDir = RandomHemiSphereDirection(hitInfo.normal, rngState);
    // Alternatively: vec3 diffuseDir = BlueNoiseRandomHemisphereDirection(hitInfo.normal, gl_FragCoord.xy, sampleIndex, i);
    ray.direction = diffuseDir;
    rayColor *= diffuseColor / (1.0 - specularProb);
}

void handleClearCoat(inout Ray ray, HitInfo hitInfo, RayTracingMaterial material, vec4 blueNoise, inout vec3 rayColor, inout uint rngState) {
	vec3 N = hitInfo.normal;
    vec3 V = -ray.direction;

    // Sample microfacet normal for clear coat layer
    vec2 Xi = blueNoise.xy;
    vec3 H = ImportanceSampleGGX(N, material.clearCoatRoughness, Xi);
    vec3 L = reflect(-V, H);

    float NoL = max(dot(N, L), 0.0);
    float NoH = max(dot(N, H), 0.0);
    float NoV = max(dot(N, V), 0.0);
    float VoH = max(dot(V, H), 0.0);

    // Fresnel term for clear coat (approximate with 0.04 as F0)
    float F = fresnelSchlick(VoH, 0.04);

    // Specular BRDF for clear coat
    float D = DistributionGGX(N, H, material.clearCoatRoughness);
    float G = GeometrySmith(N, V, L, material.clearCoatRoughness);
    vec3 specular = vec3(D * G * F / (4.0 * NoV * NoL + 0.001));

    // Decide whether to reflect off the clear coat or continue to the base layer
    if (RandomValue(rngState) < material.clearCoat * F) {
        ray.direction = L;
        rayColor *= specular * NoL / (material.clearCoat * F);
    } else {
        // Calculate base specular color
        vec3 F0 = mix(vec3(0.04), material.color.rgb, material.metalness);
        vec3 specularColor = fresnel(F0, NoV, material.roughness);
        vec3 diffuseColor = material.color.rgb * (1.0 - material.metalness) * (vec3(1.0) - specularColor);

        float specularProb = clamp(luminance(specularColor) * material.metalness, 0.1, 0.9);
        if (RandomValue(rngState) < specularProb) {
            handleSpecularReflection(ray, hitInfo, material, blueNoise, rayColor, specularColor, specularProb);
        } else {
            handleDiffuseReflection(ray, hitInfo, rngState, rayColor, diffuseColor, specularProb);
        }
        // Attenuate base layer contribution
        rayColor *= 1.0 - material.clearCoat * F;
    }
}

bool handleRussianRoulette(uint depth, vec3 rayColor, float randomValue) {
    uint minBounces = 3u;
    float depthProb = float(depth < minBounces);
    float rrProb = luminance(rayColor);
    rrProb = sqrt(rrProb);
    rrProb = max(rrProb, depthProb);
    rrProb = min(rrProb, 1.0);
    
    if (randomValue > rrProb) {
        return false;
    }
    
    rayColor *= min(1.0 / rrProb, 20.0);
    return true;
}

vec4 Trace(Ray ray, inout uint rngState, int sampleIndex, int pixelIndex) {
    vec3 incomingLight = vec3(0.0);
    vec3 rayColor = vec3(1.0);
    uint depth = 0u;
    float alpha = 1.0;

    for(int i = 0; i <= maxBounceCount; i++) {
        HitInfo hitInfo = traverseBVH(ray, stats);
        depth++;

        if(!hitInfo.didHit) {
            // Environment lighting
			if (! useBackground && i == 0 ) {
				// For primary rays (camera rays), return black
				incomingLight += vec3(0.0);
			} else {
				// For secondary rays (reflections, refractions), sample the environment normally
				vec3 envLight = sampleEnvironment(ray.direction) * rayColor;
				incomingLight += reduceFireflies(envLight, 5.0);
			}
			break;
            
        }

        RayTracingMaterial material = hitInfo.material;
        material.color = sampleAlbedoTexture(material, hitInfo.uv);
       
		// Handle alpha testing
        if (RandomValue(rngState) > material.color.a) {
            ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
            continue;
        }

		

		material.metalness = sampleMetalnessMap(material, hitInfo.uv);
        material.roughness = sampleRoughnessMap(material, hitInfo.uv);

        // Calculate tangent space and perturb normal
        vec3 tangent = normalize(cross(hitInfo.normal, vec3(0.0, 1.0, 0.0)));
        vec3 bitangent = normalize(cross(hitInfo.normal, tangent));
        hitInfo.normal = perturbNormal(hitInfo.normal, tangent, bitangent, hitInfo.uv, material);

        // Handle transparent materials
        if (material.transmission > 0.0) {
            handleTransparentMaterial(ray, hitInfo, material, rngState, rayColor, alpha);
            continue;
        }

        // Non-transparent material handling
        vec4 blueNoise = sampleBlueNoise(gl_FragCoord.xy + vec2(float(sampleIndex) * 13.37, float(sampleIndex) * 31.41 + float(i) * 71.71));

        // Calculate Fresnel effect and material colors
        float NoV = max(dot(hitInfo.normal, -ray.direction), 0.0);
        vec3 F0 = mix(vec3(0.04), material.color.rgb, material.metalness);

        vec3 specularColor = fresnel(F0, NoV, material.roughness);
        vec3 diffuseColor = material.color.rgb * (1.0 - material.metalness) * (vec3(1.0) - specularColor);

        // Handle clear coat
        if (material.clearCoat > 0.0) {
            handleClearCoat(ray, hitInfo, material, blueNoise, rayColor, rngState);
        } else {
            // Regular material handling (specular or diffuse)
            float specularProb = clamp(max(luminance(specularColor), material.metalness), 0.1, 0.9);
			if (RandomValue(rngState) < specularProb) {
				handleSpecularReflection(ray, hitInfo, material, blueNoise, rayColor, specularColor, specularProb);
			} else {
				handleDiffuseReflection(ray, hitInfo, rngState, rayColor, diffuseColor, specularProb);
			}
        }


        // Calculate direct lighting
        vec3 directLight = calculateDirectLighting(hitInfo, -ray.direction, stats);
        incomingLight += reduceFireflies(directLight * rayColor, 5.0);

		// Calculate emitted light
        vec3 emittedLight = material.emissive * material.emissiveIntensity;
		incomingLight += reduceFireflies(emittedLight * rayColor, 5.0);

		alpha *= material.color.a;

        // Russian roulette path termination
        if (!handleRussianRoulette(depth, rayColor, blueNoise.z)) {
			break;
		}

        // Prepare for next bounce
		ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
	}
	return vec4(incomingLight, alpha);
}

vec3 TraceDebugMode(vec3 rayOrigin, vec3 rayDir) {
    Ray ray;
    ray.origin = rayOrigin;
    ray.direction = rayDir;
    HitInfo hitInfo = traverseBVH(ray, stats);
    
    // Triangle test count vis
    if (visMode == 1) {
        float triVis = float(stats.x) / debugVisScale;
        return triVis < 1.0 ? vec3(triVis) : vec3(1.0, 0.0, 0.0);
    }
    // Box test count vis
    else if (visMode == 2) {
        float boxVis = float(stats.y) / debugVisScale;
        return boxVis < 1.0 ? vec3(boxVis) : vec3(1.0, 0.0, 0.0);
    }
    // Distance
    else if (visMode == 3) {
        return vec3(length(rayOrigin - hitInfo.hitPoint) / debugVisScale);
    }
    // Normal
    else if (visMode == 4) {
        if (!hitInfo.didHit) return vec3(0.0);
        return hitInfo.normal * 0.5 + 0.5;
    }
    return vec3(1.0, 0.0, 1.0); // Invalid test mode
}

bool shouldRenderPixel() {
    ivec2 pixelCoord = ivec2(gl_FragCoord.xy);
    
    if (renderMode == 0) { // Regular rendering

        return true;
    
	} else if (renderMode == 1) { // Checkered rendering

		int frameNumber = int(frame);
        int n = checkeredFrameInterval; // n x n blocks, n frame cycle
        
        // Calculate which block this pixel belongs to
        int blockX = pixelCoord.x / n;
        int blockY = pixelCoord.y / n;
        
        // Calculate position within the block
        int pixelXInBlock = pixelCoord.x % n;
        int pixelYInBlock = pixelCoord.y % n;
        
        // Determine which frame in the cycle we're on
        int cycleFrame = frameNumber % n;
        
        // Determine if this pixel should be rendered in this frame
        bool shouldRender = false;
        
        if ((blockX + blockY) % 2 == 0) {
            // "White" blocks
            shouldRender = (pixelXInBlock + pixelYInBlock) % n == cycleFrame;
        } else {
            // "Black" blocks
            shouldRender = (pixelXInBlock + pixelYInBlock + 1) % n == cycleFrame;
        }
        
        return shouldRender;

    } else if (renderMode == 2) { // Tiled rendering

        ivec2 tileCount = ivec2(resolution) / (ivec2(resolution) / tiles) ;
        ivec2 tileCoord = pixelCoord / (ivec2(resolution) / tiles);
        int totalTiles = tileCount.x * tileCount.y;
        int currentTile = int(frame) % totalTiles;
        
        int tileIndex = tileCoord.y * tileCount.x + tileCoord.x;
        return tileIndex == currentTile;

    }
    
    return true; // Default to rendering all pixels
}

vec4 getPreviousFrameColor(vec2 coord) {
	return texture2D(previousFrameTexture, coord / resolution);
}

void main() {

	vec2 pixelSize = 1.0 / resolution;
    vec2 screenPosition = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;

	vec4 finalColor = vec4(0.0, 0.0, 0.0, 1.0);
    uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;
	int pixelIndex = int(gl_FragCoord.y) * int(resolution.x) + int(gl_FragCoord.x);

	bool shouldRender = shouldRenderPixel();


    if (shouldRender) {
        if (visMode > 0) { // Debug mode
            Ray ray = generateRayFromCamera(screenPosition, seed);
            // finalColor = TraceDebugMode(ray.origin, ray.direction);
        } else {
            vec4 totalIncomingLight = vec4(0.0, 0.0, 0.0, 1.0);
            for(int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex++) {
                // Use blue noise for initial ray direction
                vec4 blueNoise = sampleBlueNoise(gl_FragCoord.xy + vec2(float(rayIndex) * 13.37, float(rayIndex) * 31.41));
                vec2 jitter = (blueNoise.xy - 0.5) * 2.0 * pixelSize;
                vec2 jitteredScreenPosition = screenPosition + jitter;

                Ray ray = generateRayFromCamera(jitteredScreenPosition, seed);

                totalIncomingLight += Trace(ray, seed, rayIndex, pixelIndex);
            }
            finalColor = totalIncomingLight / float(numRaysPerPixel);
        }
    } else {
        // For pixels that are not rendered in this frame, use the color from the previous frame
        finalColor = getPreviousFrameColor(gl_FragCoord.xy);
    }

    // finalColor.r = pow( finalColor.r, 1.0 / 2.2 );
    // finalColor.g = pow( finalColor.g, 1.0 / 2.2 );
    // finalColor.b = pow( finalColor.b, 1.0 / 2.2 );
    gl_FragColor = vec4(vec3(finalColor), 1.0);
}