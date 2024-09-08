precision highp float;

uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
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

// Modify your Trace function to include direct lighting
vec3 Trace(Ray ray, inout uint rngState) {
	vec3 incomingLight = vec3(0.0);
	vec3 rayColor = vec3(1.0);
	uint depth = 0u;

	for(int i = 0; i <= maxBounceCount; i ++) {
		HitInfo hitInfo = traverseBVH(ray, stats);

		depth ++;

		if(hitInfo.didHit) {
            RayTracingMaterial material = hitInfo.material;
            vec3 albedo = sampleAlbedoTexture(material, hitInfo.uv);

            // Handle transparent materials
            if (material.transmission > 0.0) {
                bool entering = dot(ray.direction, hitInfo.normal) < 0.0;
				float n1 = entering ? 1.0 : material.ior;
				float n2 = entering ? material.ior : 1.0;
				vec3 normal = entering ? hitInfo.normal : -hitInfo.normal;

				vec3 reflectDir = reflect(ray.direction, normal);
				vec3 refractDir = refract(ray.direction, normal, n1 / n2);

				float cosTheta = abs(dot(-ray.direction, normal));
				float r0 = pow((n1 - n2) / (n1 + n2), 2.0);
				float fresnel = r0 + (1.0 - r0) * pow(1.0 - cosTheta, 5.0);

				// Adjust Fresnel factor for more pronounced effect
				fresnel = mix(fresnel, 1.0, pow(1.0 - cosTheta, 3.0));

				vec3 glassColor = material.color.rgb;
				vec3 tintColor = mix(vec3(1.0), glassColor, 0.5); // Adjust the 0.5 to control tint strength

				if (length(refractDir) < 0.001 || RandomValue(rngState) < fresnel) {
					ray.direction = reflectDir;
					rayColor *= mix(vec3(1.0), glassColor, 0.2); // Slight color tint for reflections
				} else {
					ray.direction = refractDir;
					if (entering) {
						vec3 absorption = (vec3(1.0) - glassColor) * material.thickness * 0.5;
						rayColor *= exp(-absorption * hitInfo.dst);
					}
					rayColor *= tintColor;
				}

				ray.origin = hitInfo.hitPoint + ray.direction * 0.001;
				continue;
            }

			// Non-transparent material handling
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

			// Calculate direct lighting from the directional light
			vec3 directLight = calculateDirectLighting(hitInfo, -ray.direction, stats);
			incomingLight += reduceFireflies(directLight * rayColor, 5.0);

			// Calculate emitted light
            vec3 emittedLight = material.emissive * material.emissiveIntensity;
			incomingLight += reduceFireflies(emittedLight * rayColor, 5.0);

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
			
			vec3 envLight = sampleEnvironment(ray.direction) * rayColor;
			incomingLight += reduceFireflies(envLight, 5.0);
			break;
		}
	}
	return incomingLight;
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

vec3 getPreviousFrameColor(vec2 coord) {
    return texture2D(previousFrameTexture, coord / resolution).rgb;
}

void main() {

	vec2 pixelSize = 1.0 / resolution;
    vec2 screenPosition = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;

    vec3 finalColor = vec3(0.0);
    uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

	bool shouldRender = shouldRenderPixel();


    if (shouldRender) {
        if (visMode > 0) { // Debug mode
            Ray ray = generateRayFromCamera(screenPosition, seed);
            finalColor = TraceDebugMode(ray.origin, ray.direction);
        } else {
            vec3 totalIncomingLight = vec3(0.0);
            for(int rayIndex = 0; rayIndex < numRaysPerPixel; rayIndex++) {
                vec2 jitter = RandomPointInCircle(seed) * pixelSize;
                vec2 jitteredScreenPosition = screenPosition + jitter;

                Ray ray = generateRayFromCamera(jitteredScreenPosition, seed);

                totalIncomingLight += Trace(ray, seed);
            }
            finalColor = totalIncomingLight / float(numRaysPerPixel);
        }
    } else {
        // For pixels that are not rendered in this frame, use the color from the previous frame
        finalColor = getPreviousFrameColor(gl_FragCoord.xy);
    }

    gl_FragColor = vec4(finalColor, 1.0);
}