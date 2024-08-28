precision highp float;

uniform uint frame;
uniform vec2 resolution;
uniform int maxBounceCount;
uniform int numRaysPerPixel;
uniform samplerCube sceneBackground;

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
                float iorRatio = dot(ray.direction, hitInfo.normal) < 0.0 ? (1.0 / material.ior) : material.ior;
                vec3 refractionDir = refract(ray.direction, hitInfo.normal, iorRatio);
                vec3 reflectionDir = reflect(ray.direction, hitInfo.normal);
                
                // Calculate Fresnel for transparent material
                float cosTheta = abs(dot(ray.direction, hitInfo.normal));
                float F0 = pow((1.0 - material.ior) / (1.0 + material.ior), 2.0);
                float fresnelFactor = F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
                
                vec3 newDir;
                if (RandomValue(rngState) < fresnelFactor) {
                    newDir = reflectionDir;
                } else {
                    newDir = refractionDir;
                    // Apply color absorption
                    float distance = length(hitInfo.hitPoint - ray.origin);
                    vec3 transmissionColor = mix(vec3(1.0), albedo, material.transmission);
                    rayColor *= pow(transmissionColor, vec3(distance * material.thickness));
                }

                ray.origin = hitInfo.hitPoint + newDir * 0.001;
                ray.direction = newDir;

                // Accumulate emissive light
                incomingLight += material.emissive * material.emissiveIntensity * rayColor;

                // Continue tracing without adding direct lighting
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
			incomingLight += directLight * rayColor;

			// Calculate emitted light
            vec3 emittedLight = material.emissive * material.emissiveIntensity;
            incomingLight += emittedLight * rayColor;

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
			vec3 flippedDirection = vec3(-ray.direction.x, ray.direction.yz);
			// incomingLight += !enableEnvironmentLight ? vec3(0.0) : textureCube(sceneBackground, flippedDirection).rgb * rayColor;
			incomingLight += !enableEnvironmentLight ? vec3(0.0) : textureCube(sceneBackground, ray.direction).rgb * rayColor;
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

void main() {

	vec2 pixelSize = 1.0 / resolution;
    vec2 screenPosition = (gl_FragCoord.xy / resolution) * 2.0 - 1.0;

    vec3 finalColor = vec3(0.0);
    uint seed = uint(gl_FragCoord.x) * uint(gl_FragCoord.y) * frame;

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

    gl_FragColor = vec4(finalColor, 1.0);
}