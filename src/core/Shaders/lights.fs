// -----------------------------------------------------------------------------
// Uniform Declarations & Structures
// -----------------------------------------------------------------------------

#if MAX_DIRECTIONAL_LIGHTS > 0
uniform float directionalLights[ MAX_DIRECTIONAL_LIGHTS * 8 ]; // Updated from 7 to 8 for angle parameter
#else
uniform float directionalLights[ 1 ]; // Dummy array to avoid compilation error
#endif

#if MAX_AREA_LIGHTS > 0
uniform float areaLights[ MAX_AREA_LIGHTS * 13 ];
#else
uniform float areaLights[ 1 ]; // Dummy array to avoid compilation error
#endif

#if MAX_POINT_LIGHTS > 0
uniform float pointLights[ MAX_POINT_LIGHTS * 7 ]; // position(3) + color(3) + intensity(1)
#else
uniform float pointLights[ 1 ]; // Dummy array to avoid compilation error
#endif

#if MAX_SPOT_LIGHTS > 0
uniform float spotLights[ MAX_SPOT_LIGHTS * 11 ]; // position(3) + direction(3) + color(3) + intensity(1) + angle(1)
#else
uniform float spotLights[ 1 ]; // Dummy array to avoid compilation error
#endif

uniform float globalIlluminationIntensity;

struct DirectionalLight {
    vec3 direction;
    vec3 color;
    float intensity;
    float angle;  // Angular diameter in radians
};

struct AreaLight {
    vec3 position;
    vec3 u; // First axis of the rectangular light
    vec3 v; // Second axis of the rectangular light
    vec3 color;
    float intensity;
    vec3 normal;
    float area;
};

struct PointLight {
    vec3 position;
    vec3 color;
    float intensity;
};

struct SpotLight {
    vec3 position;
    vec3 direction;
    vec3 color;
    float intensity;
    float angle; // cone half-angle in radians
};

struct IndirectLightingResult {
    vec3 direction;    // Sampled direction for next bounce
    vec3 throughput;   // Light throughput along this path
    float misWeight;   // MIS weight for this sample
    float pdf;         // PDF of the generated sample
};

// -----------------------------------------------------------------------------
// Light Data Access Functions
// -----------------------------------------------------------------------------

DirectionalLight getDirectionalLight( int index ) {
    int baseIndex = index * 8;  // Updated from 7 to 8
    DirectionalLight light;
    light.direction = normalize( vec3( directionalLights[ baseIndex ], directionalLights[ baseIndex + 1 ], directionalLights[ baseIndex + 2 ] ) );
    light.color = vec3( directionalLights[ baseIndex + 3 ], directionalLights[ baseIndex + 4 ], directionalLights[ baseIndex + 5 ] );
    light.intensity = directionalLights[ baseIndex + 6 ];
    light.angle = directionalLights[ baseIndex + 7 ];  // New angle parameter
    return light;
}

AreaLight getAreaLight( int index ) {
    int baseIndex = index * 13;
    AreaLight light;
    light.position = vec3( areaLights[ baseIndex ], areaLights[ baseIndex + 1 ], areaLights[ baseIndex + 2 ] );
    light.u = vec3( areaLights[ baseIndex + 3 ], areaLights[ baseIndex + 4 ], areaLights[ baseIndex + 5 ] );
    light.v = vec3( areaLights[ baseIndex + 6 ], areaLights[ baseIndex + 7 ], areaLights[ baseIndex + 8 ] );
    light.color = vec3( areaLights[ baseIndex + 9 ], areaLights[ baseIndex + 10 ], areaLights[ baseIndex + 11 ] );
    light.intensity = areaLights[ baseIndex + 12 ];
    light.normal = normalize( cross( light.u, light.v ) );
    light.area = length( cross( light.u, light.v ) );
    return light;
}

PointLight getPointLight( int index ) {
    int baseIndex = index * 7;
    PointLight light;
    light.position = vec3( pointLights[ baseIndex ], pointLights[ baseIndex + 1 ], pointLights[ baseIndex + 2 ] );
    light.color = vec3( pointLights[ baseIndex + 3 ], pointLights[ baseIndex + 4 ], pointLights[ baseIndex + 5 ] );
    light.intensity = pointLights[ baseIndex + 6 ];
    return light;
}

SpotLight getSpotLight( int index ) {
    int baseIndex = index * 11;
    SpotLight light;
    light.position = vec3( spotLights[ baseIndex ], spotLights[ baseIndex + 1 ], spotLights[ baseIndex + 2 ] );
    light.direction = normalize( vec3( spotLights[ baseIndex + 3 ], spotLights[ baseIndex + 4 ], spotLights[ baseIndex + 5 ] ) );
    light.color = vec3( spotLights[ baseIndex + 6 ], spotLights[ baseIndex + 7 ], spotLights[ baseIndex + 8 ] );
    light.intensity = spotLights[ baseIndex + 9 ];
    light.angle = spotLights[ baseIndex + 10 ];
    return light;
}

// -----------------------------------------------------------------------------
// Cone Sampling for Soft Directional Shadows
// -----------------------------------------------------------------------------

// Sample direction within a cone for soft shadows
vec3 sampleCone( vec3 direction, float halfAngle, vec2 xi ) {
    // Sample within cone using spherical coordinates
    float cosHalfAngle = cos( halfAngle );
    float cosTheta = mix( cosHalfAngle, 1.0, xi.x );
    float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );
    float phi = TWO_PI * xi.y;

    // Create local coordinate system
    vec3 up = abs( direction.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
    vec3 tangent = normalize( cross( up, direction ) );
    vec3 bitangent = cross( direction, tangent );

    // Convert to world space
    vec3 localDir = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
    return normalize( tangent * localDir.x + bitangent * localDir.y + direction * localDir.z );
}

// -----------------------------------------------------------------------------
// Shadow & Intersection Test Functions
// -----------------------------------------------------------------------------

float getMaterialTransparency( HitInfo shadowHit, Ray shadowRay, inout uint rngState ) {
    // Check if the material has transmission (like glass)
    if( shadowHit.material.transmission > 0.0 ) {
        // Check if ray is entering or exiting the material
        bool isEntering = dot( shadowRay.direction, shadowHit.normal ) < 0.0;

        // Use simplified shadow transmission instead of full handleTransmission
        float transmittance = calculateShadowTransmittance( shadowRay.direction, shadowHit.normal, shadowHit.material, isEntering );

        // Return opacity based on transmittance
        return 1.0 - transmittance;
    } 
    // If no transmission, check if it's transparent
    else if( shadowHit.material.transparent ) {
        return shadowHit.material.opacity;
    }
    // If neither transmissive nor transparent, it's fully opaque
    else {
        return 1.0;
    }
}

float traceShadowRay( vec3 origin, vec3 dir, float maxDist, inout uint rngState, inout ivec2 stats ) {
    Ray shadowRay;
    shadowRay.origin = origin;
    shadowRay.direction = dir;

    // Media tracking for shadow rays
    MediumStack shadowMediaStack;
    shadowMediaStack.depth = 0;

    // Track accumulated transmittance
    float transmittance = 1.0;

    // Allow more steps through transparent media for shadow rays
    const int MAX_SHADOW_TRANSMISSIONS = 8;

    for( int step = 0; step < MAX_SHADOW_TRANSMISSIONS; step ++ ) {
        HitInfo shadowHit = traverseBVH( shadowRay, stats, true );

        // No hit or hit beyond light distance
        if( ! shadowHit.didHit || length( shadowHit.hitPoint - origin ) > maxDist )
            break;

        // Special handling for transmissive materials
        if( shadowHit.material.transmission > 0.0 ) {
            // Determine if entering or exiting medium
            bool entering = dot( shadowRay.direction, shadowHit.normal ) < 0.0;
            vec3 N = entering ? shadowHit.normal : - shadowHit.normal;

            // Apply absorption if exiting medium
            if( ! entering && shadowHit.material.attenuationDistance > 0.0 ) {
                float dist = length( shadowHit.hitPoint - shadowRay.origin );
                vec3 absorption = calculateBeerLawAbsorption( shadowHit.material.attenuationColor, shadowHit.material.attenuationDistance, dist );
                transmittance *= ( absorption.r + absorption.g + absorption.b ) / 3.0;
            }

            // Compute transmittance based on material properties
            float fresnel = fresnelSchlick( abs( dot( shadowRay.direction, N ) ), iorToFresnel0( shadowHit.material.ior, 1.0 ) );

            // Combine Fresnel with transmission property
            float matTransmittance = ( 1.0 - fresnel ) * shadowHit.material.transmission;
            transmittance *= matTransmittance;

            // Early exit if almost no light passes through
            if( transmittance < 0.005 )
                return 0.0;

            // Continue ray
            shadowRay.origin = shadowHit.hitPoint + shadowRay.direction * 0.001;
        } else if( shadowHit.material.transparent ) {
            // Handle transparent materials
            transmittance *= ( 1.0 - shadowHit.material.opacity );

            if( transmittance < 0.005 )
                return 0.0;

            // Continue ray
            shadowRay.origin = shadowHit.hitPoint + shadowRay.direction * 0.001;
        } else {
            // Fully opaque object blocks shadow ray
            return 0.0;
        }
    }

    return transmittance;
}

bool intersectAreaLight( AreaLight light, vec3 rayOrigin, vec3 rayDirection, inout float t ) {
    // Fast path - precomputed normal
    vec3 normal = light.normal;
    float denom = dot( normal, rayDirection );

    // Quick rejection (backface culling and near-parallel rays)
    if( denom >= - 0.0001 )
        return false;

    // Calculate intersection distance
    float invDenom = 1.0 / denom; // Multiply is faster than divide on many GPUs
    t = dot( light.position - rayOrigin, normal ) * invDenom;

    // Skip intersections behind the ray
    if( t <= 0.001 )
        return false;

    // Optimized rectangle test using vector rejection
    vec3 hitPoint = rayOrigin + rayDirection * t;
    vec3 localPoint = hitPoint - light.position;

    // Normalized u/v directions
    vec3 u_dir = light.u / length( light.u );
    vec3 v_dir = light.v / length( light.v );

    // Project onto axes
    float u_proj = dot( localPoint, u_dir );
    float v_proj = dot( localPoint, v_dir );

    // Check within rectangle bounds (half-lengths)
    return ( abs( u_proj ) <= length( light.u ) && abs( v_proj ) <= length( light.v ) );
}

// -----------------------------------------------------------------------------
// DIRECTIONAL LIGHT FUNCTIONS
// -----------------------------------------------------------------------------

// Calculate adaptive ray offset based on scene scale and surface properties
vec3 calculateRayOffset( vec3 hitPoint, vec3 normal, RayTracingMaterial material ) {
    // Base epsilon scaled by scene size
    float scaleEpsilon = max( 1e-4, length( hitPoint ) * 1e-6 );

    // Adjust for material properties
    float materialEpsilon = scaleEpsilon;
    if( material.transmission > 0.0 ) {
        // Transmissive materials need larger offsets to avoid light leaking
        materialEpsilon *= 2.0;
    }
    if( material.roughness < 0.1 ) {
        // Smooth materials are more sensitive to precision issues
        materialEpsilon *= 1.5;
    }

    return normal * materialEpsilon;
}

// Fast early exit checks for directional lights
bool shouldSkipDirectionalLight(
    DirectionalLight light,
    vec3 normal,
    RayTracingMaterial material,
    int bounceIndex
) {
    float NoL = max( 0.0, dot( normal, light.direction ) );

    // Basic validity checks
    if( light.intensity <= 0.001 || NoL <= 0.001 ) {
        return true;
    }

    // Material-specific early exits for performance
    if( bounceIndex > 0 ) {
        // Skip dim lights on secondary bounces
        if( light.intensity < 0.01 ) {
            return true;
        }

        // Skip lights that barely hit metals at grazing angles
        if( material.metalness > 0.9 && NoL < 0.1 ) {
            return true;
        }

        // Skip lights that won't contribute much to rough dielectrics
        if( material.metalness < 0.1 && material.roughness > 0.9 && light.intensity < 0.1 ) {
            return true;
        }
    }

    return false;
}

// Directional light contribution with soft shadows
vec3 calculateDirectionalLightContribution(
    DirectionalLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    MaterialCache matCache,
    DirectionSample brdfSample,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Fast early exit
    if( shouldSkipDirectionalLight( light, normal, material, bounceIndex ) ) {
        return vec3( 0.0 );
    }

    // Calculate adaptive ray offset
    vec3 rayOffset = calculateRayOffset( hitPoint, normal, material );
    vec3 rayOrigin = hitPoint + rayOffset;

    // Determine shadow sampling strategy based on light angle
    vec3 shadowDirection;
    float lightPdf = 1e6; // Default for sharp shadows

    if( light.angle > 0.001 ) {
        // Soft shadows: sample direction within cone
        vec2 xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
        float halfAngle = light.angle * 0.5;
        shadowDirection = sampleCone( light.direction, halfAngle, xi );

        // Calculate PDF for cone sampling
        float cosHalfAngle = cos( halfAngle );
        lightPdf = 1.0 / ( TWO_PI * ( 1.0 - cosHalfAngle ) );
    } else {
        // Sharp shadows: use original direction
        shadowDirection = light.direction;
    }

    float NoL = max( 0.0, dot( normal, shadowDirection ) );
    if( NoL <= 0.0 ) {
        return vec3( 0.0 );
    }

    // Shadow test
    float maxShadowDistance = 1e6;
    float visibility = traceShadowRay( rayOrigin, shadowDirection, maxShadowDistance, rngState, stats );
    if( visibility <= 0.0 ) {
        return vec3( 0.0 );
    }

    // BRDF evaluation using sampled direction
    vec3 brdfValue = evaluateMaterialResponseCached( viewDir, shadowDirection, normal, material, matCache );

    // Physical light contribution
    // The BRDF already includes material color, so we apply light radiance properly
    vec3 lightRadiance = light.color * light.intensity;
    vec3 contribution = lightRadiance * brdfValue * NoL * visibility;

    // MIS for directional lights (only on primary rays where it matters)
    if( bounceIndex == 0 && brdfSample.pdf > 0.0 ) {
        // Check alignment between BRDF sample and shadow direction
        float alignment = max( 0.0, dot( normalize( brdfSample.direction ), shadowDirection ) );

        // Only apply MIS if there's significant alignment
        if( alignment > 0.996 ) {
            float misWeight = powerHeuristic( lightPdf, brdfSample.pdf );
            contribution *= misWeight;
        }
        // If no alignment, light sampling dominates (no reduction needed)
    }

    return contribution;
}

// -----------------------------------------------------------------------------
// Light Importance & Contribution Calculations (Area Lights)
// -----------------------------------------------------------------------------

// Light importance estimation - helps guide where to spend computation
float estimateLightImportance(
    AreaLight light,
    vec3 hitPoint,
    vec3 normal,
    RayTracingMaterial material
) {
    // Distance-based importance
    vec3 toLight = light.position - hitPoint;
    float distSq = dot( toLight, toLight );
    float distanceFactor = 1.0 / max( distSq, 0.01 );

    // Angular importance - light facing toward surface?
    vec3 lightDir = normalize( toLight );
    float NoL = max( dot( normal, lightDir ), 0.0 );
    float lightFacing = max( - dot( lightDir, light.normal ), 0.0 );

    // Size importance
    float sizeFactor = light.area;

    // Brightness importance
    float intensity = light.intensity * luminance( light.color );

    // Material-specific factors
    float materialFactor = 1.0;
    if( material.metalness > 0.7 ) {
        // Metals care more about bright lights for specular reflections
        materialFactor = 2.0;
    } else if( material.roughness > 0.8 ) {
        // Rough diffuse surfaces care more about large lights
        materialFactor = 0.8;
    }

    // Combined importance score
    return distanceFactor * NoL * lightFacing * sizeFactor * intensity * materialFactor;
}

// Directional light importance calculation
float calculateDirectionalLightImportance(
    DirectionalLight light,
    vec3 hitPoint,
    vec3 normal,
    RayTracingMaterial material,
    int bounceIndex
) {
    float NoL = max( 0.0, dot( normal, light.direction ) );
    if( NoL <= 0.0 ) return 0.0;
    
    float intensity = light.intensity * luminance( light.color );
    
    // Material-specific weighting
    float materialWeight = 1.0;
    if( material.metalness > 0.7 ) {
        materialWeight = 1.5; // Metals benefit more from directional lights
    } else if( material.roughness > 0.8 ) {
        materialWeight = 0.7; // Rough surfaces less sensitive to directional lights
    }
    
    // Reduce importance on secondary bounces
    float bounceWeight = 1.0 / ( 1.0 + float( bounceIndex ) * 0.5 );
    
    return intensity * NoL * materialWeight * bounceWeight;
}

// Point light importance calculation
float calculatePointLightImportance(
    PointLight light,
    vec3 hitPoint,
    vec3 normal,
    RayTracingMaterial material
) {
    vec3 toLight = light.position - hitPoint;
    float distSq = dot( toLight, toLight );
    if( distSq < 0.001 ) return 0.0; // Too close
    
    vec3 lightDir = toLight / sqrt( distSq );
    float NoL = max( 0.0, dot( normal, lightDir ) );
    if( NoL <= 0.0 ) return 0.0;
    
    // Distance attenuation
    float distanceFactor = 1.0 / max( distSq, 0.01 );
    
    // Intensity and color
    float intensity = light.intensity * luminance( light.color );
    
    // Material weighting
    float materialWeight = material.metalness > 0.7 ? 1.5 : 
                          (material.roughness > 0.8 ? 0.8 : 1.0);
    
    return intensity * distanceFactor * NoL * materialWeight;
}

// Spot light importance calculation
float calculateSpotLightImportance(
    SpotLight light,
    vec3 hitPoint,
    vec3 normal,
    RayTracingMaterial material
) {
    vec3 toLight = light.position - hitPoint;
    float distSq = dot( toLight, toLight );
    if( distSq < 0.001 ) return 0.0;
    
    vec3 lightDir = toLight / sqrt( distSq );
    float NoL = max( 0.0, dot( normal, lightDir ) );
    if( NoL <= 0.0 ) return 0.0;
    
    // Check if point is within spot cone
    float spotCosAngle = dot( -lightDir, light.direction );
    float coneCosAngle = cos( light.angle );
    if( spotCosAngle < coneCosAngle ) return 0.0;
    
    // Distance attenuation
    float distanceFactor = 1.0 / max( distSq, 0.01 );
    
    // Cone attenuation
    float coneAttenuation = smoothstep( coneCosAngle, coneCosAngle + 0.1, spotCosAngle );
    
    // Intensity and color
    float intensity = light.intensity * luminance( light.color );
    
    // Material weighting
    float materialWeight = material.metalness > 0.7 ? 1.5 : 
                          (material.roughness > 0.8 ? 0.8 : 1.0);
    
    return intensity * distanceFactor * coneAttenuation * NoL * materialWeight;
}

// Highly optimized area light contribution calculation
vec3 calculateAreaLightContribution(
    AreaLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    MaterialCache matCache,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Importance estimation to decide sampling strategy
    float lightImportance = estimateLightImportance( light, hitPoint, normal, material );

    // Skip lights with negligible contribution 
    if( lightImportance < 0.001 )
        return vec3( 0.0 );

    // Pre-compute common values
    vec3 contribution = vec3( 0.0 );
    vec3 rayOffset = calculateRayOffset( hitPoint, normal, material );
    vec3 rayOrigin = hitPoint + rayOffset;

    // Adaptive sampling strategy based on material and importance
    bool isDiffuse = material.roughness > 0.7 && material.metalness < 0.3;
    bool isSpecular = material.roughness < 0.3 || material.metalness > 0.7;
    bool isFirstBounce = bounceIndex == 0;

    // ---------------------------
    // LIGHT SAMPLING STRATEGY
    // ---------------------------
    if( isFirstBounce || isDiffuse || ( lightImportance > 0.1 && ! isSpecular ) ) {
        // Get stratified sample point for better coverage
        vec2 ruv = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, - 1 );

        // Generate position on light surface (stratified to improve sampling)
        vec3 lightPos = light.position +
            light.u * ( ruv.x - 0.5 ) +
            light.v * ( ruv.y - 0.5 );

        // Calculate light direction and properties
        vec3 toLight = lightPos - hitPoint;
        float lightDistSq = dot( toLight, toLight );
        float lightDist = sqrt( lightDistSq );
        vec3 lightDir = toLight / lightDist;

        // Geometric terms
        float NoL = max( 0.0, dot( normal, lightDir ) );
        float lightFacing = max( 0.0, - dot( lightDir, light.normal ) );

        // Early exit for geometry facing away
        if( NoL > 0.0 && lightFacing > 0.0 ) {
            // Shadow test with single ray
            float visibility = traceShadowRay( rayOrigin, lightDir, lightDist, rngState, stats );

            if( visibility > 0.0 ) {
                // BRDF evaluation
                vec3 brdfValue = evaluateMaterialResponseCached( viewDir, lightDir, normal, material, matCache );

                // Calculate PDFs for both strategies
                float lightPdf = lightDistSq / ( light.area * lightFacing );
                float brdfPdf = brdfSample.pdf;

                // Light contribution with inverse-square falloff
                float falloff = light.area / ( 4.0 * PI * lightDistSq );
                vec3 lightContribution = light.color * light.intensity * falloff * lightFacing;

                // MIS weight using power heuristic for better noise reduction
                float misWeight = ( brdfPdf > 0.0 && isFirstBounce ) ? powerHeuristic( lightPdf, brdfPdf ) : 1.0;

                contribution += lightContribution * brdfValue * NoL * visibility * misWeight;
            }
        }
    }

    // ---------------------------
    // BRDF SAMPLING STRATEGY
    // ---------------------------
    if( ( isFirstBounce || isSpecular ) && brdfSample.pdf > 0.0 ) {
        // Fast path - check if ray could possibly hit light before intersection test
        vec3 toLight = light.position - rayOrigin;
        float rayToLightDot = dot( toLight, brdfSample.direction );

        // Only proceed if ray is pointing toward light's general area
        if( rayToLightDot > 0.0 ) {
            float hitDistance = 0.0;
            bool hitLight = intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance );

            if( hitLight ) {
                // We hit the light with our BRDF sample!
                float visibility = traceShadowRay( rayOrigin, brdfSample.direction, hitDistance, rngState, stats );

                if( visibility > 0.0 ) {
                    // Light geometric terms at hit point
                    float lightFacing = max( 0.0, - dot( brdfSample.direction, light.normal ) );

                    if( lightFacing > 0.0 ) {
                        // PDFs for MIS
                        float lightPdf = ( hitDistance * hitDistance ) / ( light.area * lightFacing );

                        // MIS weight using power heuristic
                        float misWeight = powerHeuristic( brdfSample.pdf, lightPdf );

                        // Direct light emission
                        vec3 lightEmission = light.color * light.intensity;
                        float NoL = max( 0.0, dot( normal, brdfSample.direction ) );

                        contribution += lightEmission * brdfSample.value * NoL * visibility * misWeight;
                    }
                }
            }
        }
    }

    return contribution;
}

// -----------------------------------------------------------------------------
// Point Light Contribution Calculation
// -----------------------------------------------------------------------------
vec3 calculatePointLightContribution(
    PointLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    MaterialCache matCache,
    DirectionSample brdfSample,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Calculate vector from surface to light
    vec3 toLight = light.position - hitPoint;
    float distance = length(toLight);
    
    // Early exit for extremely far lights (performance optimization)
    if (distance > 1000.0) return vec3(0.0);
    
    vec3 lightDir = toLight / distance;
    
    // Check if light is on same side of surface as normal
    float NdotL = dot(normal, lightDir);
    if (NdotL <= 0.0) return vec3(0.0);
    
    // Calculate attenuation using inverse square law
    float attenuation = 1.0 / (distance * distance);
    
    // Apply intensity and color
    vec3 lightRadiance = light.color * light.intensity * attenuation;
    
    // Calculate shadow ray offset
    vec3 rayOffset = calculateRayOffset(hitPoint, normal, material);
    vec3 rayOrigin = hitPoint + rayOffset;
    
    // Trace shadow ray
    float visibility = traceShadowRay(rayOrigin, lightDir, distance - 0.001, rngState, stats);
    if (visibility <= 0.0) return vec3(0.0);
    
    // Calculate BRDF contribution
    vec3 brdfValue = evaluateMaterialResponse(viewDir, lightDir, normal, material);
    
    // Final contribution
    return brdfValue * lightRadiance * NdotL * visibility;
}

// -----------------------------------------------------------------------------
// Spot Light Contribution Calculation
// -----------------------------------------------------------------------------
vec3 calculateSpotLightContribution(
    SpotLight light,
    vec3 hitPoint,
    vec3 normal,
    vec3 viewDir,
    RayTracingMaterial material,
    MaterialCache matCache,
    DirectionSample brdfSample,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Calculate vector from surface to light
    vec3 toLight = light.position - hitPoint;
    float distance = length(toLight);
    
    // Early exit for extremely far lights (performance optimization)
    if (distance > 1000.0) return vec3(0.0);
    
    vec3 lightDir = toLight / distance;
    
    // Check if light is on same side of surface as normal
    float NdotL = dot(normal, lightDir);
    if (NdotL <= 0.0) return vec3(0.0);
    
    // Calculate spot light cone attenuation
    float spotCosAngle = dot(-lightDir, light.direction);
    float coneCosAngle = cos(light.angle);
    
    // Early exit if outside the cone
    if (spotCosAngle < coneCosAngle) return vec3(0.0);
    
    // Smooth falloff at cone edge using smoothstep
    float coneAttenuation = smoothstep(coneCosAngle, coneCosAngle + 0.1, spotCosAngle);
    
    // Calculate distance attenuation using inverse square law
    float distanceAttenuation = 1.0 / (distance * distance);
    
    // Apply intensity, color, and both attenuations
    vec3 lightRadiance = light.color * light.intensity * distanceAttenuation * coneAttenuation;
    
    // Calculate shadow ray offset
    vec3 rayOffset = calculateRayOffset(hitPoint, normal, material);
    vec3 rayOrigin = hitPoint + rayOffset;
    
    // Trace shadow ray
    float visibility = traceShadowRay(rayOrigin, lightDir, distance - 0.001, rngState, stats);
    if (visibility <= 0.0) return vec3(0.0);
    
    // Calculate BRDF contribution
    vec3 brdfValue = evaluateMaterialResponse(viewDir, lightDir, normal, material);
    
    // Final contribution
    return brdfValue * lightRadiance * NdotL * visibility;
}

// =============================================================================
// UNIFIED LIGHTING SYSTEM 
// Based on gkjohnson/three-gpu-pathtracer approach
// =============================================================================

// Light type constants
const int LIGHT_TYPE_DIRECTIONAL = 0;
const int LIGHT_TYPE_AREA = 1;
const int LIGHT_TYPE_POINT = 2;
const int LIGHT_TYPE_SPOT = 3;

// Power heuristic for Multiple Importance Sampling
float misHeuristic( float a, float b ) {
    float aa = a * a;
    float bb = b * b;
    return aa / ( aa + bb );
}

// Enhanced light record structure with improved features
struct LightSample {
    vec3 direction;
    vec3 emission;
    float pdf;
    float distance;
    int lightType;
    bool valid;
};

// Distance attenuation based on Frostbite PBR
float getDistanceAttenuation( float lightDistance, float cutoffDistance, float decayExponent ) {
    float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
    
    if( cutoffDistance > 0.0 ) {
        distanceFalloff *= pow( clamp( 1.0 - pow( lightDistance / cutoffDistance, 4.0 ), 0.0, 1.0 ), 2.0 );
    }
    
    return distanceFalloff;
}

// Spot light attenuation
float getSpotAttenuation( float coneCosine, float penumbraCosine, float angleCosine ) {
    return smoothstep( coneCosine, penumbraCosine, angleCosine );
}

// Utility function to validate ray direction (simplified)
bool isDirectionValid( vec3 direction, vec3 surfaceNormal ) {
    return dot( direction, surfaceNormal ) > 0.0;
}

// Get total number of lights in the scene
int getTotalLightCount() {
    int count = 0;
    #if MAX_DIRECTIONAL_LIGHTS > 0
        count += MAX_DIRECTIONAL_LIGHTS;
    #endif
    #if MAX_AREA_LIGHTS > 0
        count += MAX_AREA_LIGHTS;
    #endif
    #if MAX_POINT_LIGHTS > 0
        count += MAX_POINT_LIGHTS;
    #endif
    #if MAX_SPOT_LIGHTS > 0
        count += MAX_SPOT_LIGHTS;
    #endif
    return count;
}

// Enhanced area light sampling functions
LightSample sampleRectAreaLight( AreaLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
    // Sample random position on rectangle
    vec3 randomPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );
    
    vec3 toLight = randomPos - rayOrigin;
    float lightDistSq = dot( toLight, toLight );
    float dist = sqrt( lightDistSq );
    vec3 direction = toLight / dist;
    vec3 lightNormal = normalize( cross( light.u, light.v ) );
    
    LightSample lightSample;
    lightSample.lightType = LIGHT_TYPE_AREA;
    lightSample.emission = light.color * light.intensity;
    lightSample.distance = dist;
    lightSample.direction = direction;
    lightSample.pdf = ( lightDistSq / ( light.area * max( dot( -direction, lightNormal ), 0.001 ) ) ) * lightSelectionPdf;
    lightSample.valid = dot( -direction, lightNormal ) > 0.0;
    
    return lightSample;
}

LightSample sampleCircAreaLight( AreaLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
    // Sample random position on circle
    float r = 0.5 * sqrt( ruv.x );
    float theta = ruv.y * 2.0 * PI;
    float x = r * cos( theta );
    float y = r * sin( theta );
    
    vec3 randomPos = light.position + light.u * x + light.v * y;
    
    vec3 toLight = randomPos - rayOrigin;
    float lightDistSq = dot( toLight, toLight );
    float dist = sqrt( lightDistSq );
    vec3 direction = toLight / dist;
    vec3 lightNormal = normalize( cross( light.u, light.v ) );
    
    LightSample lightSample;
    lightSample.lightType = LIGHT_TYPE_AREA;
    lightSample.emission = light.color * light.intensity;
    lightSample.distance = dist;
    lightSample.direction = direction;
    lightSample.pdf = ( lightDistSq / ( light.area * max( dot( -direction, lightNormal ), 0.001 ) ) ) * lightSelectionPdf;
    lightSample.valid = dot( -direction, lightNormal ) > 0.0;
    
    return lightSample;
}

// Enhanced spot light sampling with radius support
LightSample sampleSpotLightWithRadius( SpotLight light, vec3 rayOrigin, vec2 ruv, float lightSelectionPdf ) {
    vec3 toLight = light.position - rayOrigin;
    float lightDist = length( toLight );
    vec3 lightDir = toLight / lightDist;
    
    // Check cone attenuation
    float spotCosAngle = dot( -lightDir, light.direction );
    float coneCosAngle = cos( light.angle );
    
    LightSample lightSample;
    lightSample.lightType = LIGHT_TYPE_SPOT;
    lightSample.direction = lightDir;
    lightSample.distance = lightDist;
    lightSample.pdf = lightSelectionPdf;
    lightSample.valid = spotCosAngle >= coneCosAngle;
    
    if( lightSample.valid ) {
        float penumbraCosAngle = cos( light.angle * 0.9 ); // 10% penumbra
        float coneAttenuation = getSpotAttenuation( coneCosAngle, penumbraCosAngle, spotCosAngle );
        float distanceAttenuation = getDistanceAttenuation( lightDist, 0.0, 2.0 );
        
        lightSample.emission = light.color * light.intensity * distanceAttenuation * coneAttenuation;
    } else {
        lightSample.emission = vec3( 0.0 );
    }
    
    return lightSample;
}

// Enhanced point light sampling with distance attenuation
LightSample samplePointLightWithAttenuation( PointLight light, vec3 rayOrigin, float lightSelectionPdf ) {
    vec3 toLight = light.position - rayOrigin;
    float lightDist = length( toLight );
    vec3 lightDir = toLight / lightDist;
    
    // Calculate distance attenuation
    float distanceAttenuation = getDistanceAttenuation( lightDist, 0.0, 2.0 );
    
    LightSample lightSample;
    lightSample.lightType = LIGHT_TYPE_POINT;
    lightSample.direction = lightDir;
    lightSample.distance = lightDist;
    lightSample.emission = light.color * light.intensity * distanceAttenuation;
    lightSample.pdf = lightSelectionPdf;
    lightSample.valid = true;
    
    return lightSample;
}

// Enhanced light sampling with importance weighting for better noise reduction
LightSample sampleLightWithImportance( 
    vec3 rayOrigin, 
    vec3 normal, 
    RayTracingMaterial material,
    vec2 randomSeed, 
    int bounceIndex,
    inout uint rngState 
) {
    LightSample result;
    result.valid = false;
    result.pdf = 0.0;
    
    int totalLights = getTotalLightCount();
    if( totalLights == 0 ) return result;
    
    // Calculate light importance weights for better sampling
    float lightWeights[16]; // Assuming max 16 total lights
    float totalWeight = 0.0;
    int lightIndex = 0;
    
    // Calculate importance for each light type
    #if MAX_DIRECTIONAL_LIGHTS > 0
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS && lightIndex < 16; i++ ) {
        DirectionalLight light = getDirectionalLight( i );
        float importance = calculateDirectionalLightImportance( light, rayOrigin, normal, material, bounceIndex );
        lightWeights[lightIndex] = importance;
        totalWeight += importance;
        lightIndex++;
    }
    #endif
    
    #if MAX_AREA_LIGHTS > 0
    for( int i = 0; i < MAX_AREA_LIGHTS && lightIndex < 16; i++ ) {
        AreaLight light = getAreaLight( i );
        float importance = estimateLightImportance( light, rayOrigin, normal, material );
        lightWeights[lightIndex] = importance;
        totalWeight += importance;
        lightIndex++;
    }
    #endif
    
    #if MAX_POINT_LIGHTS > 0
    for( int i = 0; i < MAX_POINT_LIGHTS && lightIndex < 16; i++ ) {
        PointLight light = getPointLight( i );
        float importance = calculatePointLightImportance( light, rayOrigin, normal, material );
        lightWeights[lightIndex] = importance;
        totalWeight += importance;
        lightIndex++;
    }
    #endif
    
    #if MAX_SPOT_LIGHTS > 0
    for( int i = 0; i < MAX_SPOT_LIGHTS && lightIndex < 16; i++ ) {
        SpotLight light = getSpotLight( i );
        float importance = calculateSpotLightImportance( light, rayOrigin, normal, material );
        lightWeights[lightIndex] = importance;
        totalWeight += importance;
        lightIndex++;
    }
    #endif
    
    if( totalWeight <= 0.0 ) {
        // Fallback to uniform sampling - select a random light uniformly
        float lightSelection = randomSeed.x * float( totalLights );
        int selectedLight = int( lightSelection );
        float lightSelectionPdf = 1.0 / float( totalLights );
        
        // Simple uniform sampling fallback
        LightSample fallbackResult;
        fallbackResult.valid = false;
        fallbackResult.pdf = lightSelectionPdf;
        
        // For simplicity, just sample first available directional light as fallback
        #if MAX_DIRECTIONAL_LIGHTS > 0
        if( selectedLight < MAX_DIRECTIONAL_LIGHTS ) {
            DirectionalLight light = getDirectionalLight( selectedLight );
            if( light.intensity > 0.0 ) {
                fallbackResult.direction = normalize( light.direction );
                fallbackResult.emission = light.color * light.intensity;
                fallbackResult.distance = 1e6;
                fallbackResult.lightType = LIGHT_TYPE_DIRECTIONAL;
                fallbackResult.valid = true;
            }
        }
        #endif
        
        return fallbackResult;
    }
    
    // Importance-based light selection
    float selectionValue = randomSeed.x * totalWeight;
    float cumulative = 0.0;
    int selectedLight = 0;
    
    for( int i = 0; i < totalLights && i < 16; i++ ) {
        cumulative += lightWeights[i];
        if( selectionValue <= cumulative ) {
            selectedLight = i;
            break;
        }
    }
    
    float lightSelectionPdf = lightWeights[selectedLight] / totalWeight;
    
    // Now sample the selected light with importance weighting
    result.valid = false;
    result.pdf = lightSelectionPdf;
    
    // Map selectedLight index to the appropriate light type and index
    int currentIndex = 0;
    
    // Sample directional lights
    #if MAX_DIRECTIONAL_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_DIRECTIONAL_LIGHTS ) {
        int dirLightIndex = selectedLight - currentIndex;
        DirectionalLight light = getDirectionalLight( dirLightIndex );
        if( light.intensity > 0.0 ) {
            vec3 direction;
            float pdf = 1.0;
            
            if( light.angle > 0.0 ) {
                // Soft directional light - sample within cone
                float cosHalfAngle = cos( light.angle * 0.5 );
                float cosTheta = mix( cosHalfAngle, 1.0, randomSeed.y );
                float sinTheta = sqrt( max( 0.0, 1.0 - cosTheta * cosTheta ) );
                float phi = 2.0 * PI * RandomValue( rngState );
                
                // Create local coordinate system around light direction
                vec3 w = normalize( light.direction );
                vec3 u = normalize( cross( abs( w.x ) > 0.9 ? vec3( 0, 1, 0 ) : vec3( 1, 0, 0 ), w ) );
                vec3 v = cross( w, u );
                
                direction = normalize( cosTheta * w + sinTheta * ( cos( phi ) * u + sin( phi ) * v ) );
                pdf = 1.0 / ( 2.0 * PI * ( 1.0 - cosHalfAngle ) );
            } else {
                direction = normalize( light.direction );
            }
            
            result.direction = direction;
            result.emission = light.color * light.intensity;
            result.distance = 1e6;
            result.pdf = pdf * lightSelectionPdf;
            result.lightType = LIGHT_TYPE_DIRECTIONAL;
            result.valid = true;
            return result;
        }
    }
    currentIndex += MAX_DIRECTIONAL_LIGHTS;
    #endif
    
    // Sample area lights with enhanced sampling
    #if MAX_AREA_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_AREA_LIGHTS ) {
        int areaLightIndex = selectedLight - currentIndex;
        AreaLight light = getAreaLight( areaLightIndex );
        if( light.intensity > 0.0 ) {
            vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
            return sampleRectAreaLight( light, rayOrigin, uv, lightSelectionPdf );
        }
    }
    currentIndex += MAX_AREA_LIGHTS;
    #endif
    
    // Sample point lights with enhanced attenuation
    #if MAX_POINT_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_POINT_LIGHTS ) {
        int pointLightIndex = selectedLight - currentIndex;
        PointLight light = getPointLight( pointLightIndex );
        if( light.intensity > 0.0 ) {
            return samplePointLightWithAttenuation( light, rayOrigin, lightSelectionPdf );
        }
    }
    currentIndex += MAX_POINT_LIGHTS;
    #endif
    
    // Sample spot lights with enhanced features
    #if MAX_SPOT_LIGHTS > 0
    if( selectedLight < currentIndex + MAX_SPOT_LIGHTS ) {
        int spotLightIndex = selectedLight - currentIndex;
        SpotLight light = getSpotLight( spotLightIndex );
        if( light.intensity > 0.0 ) {
            vec2 uv = vec2( randomSeed.y, RandomValue( rngState ) );
            return sampleSpotLightWithRadius( light, rayOrigin, uv, lightSelectionPdf );
        }
    }
    #endif
    
    return result;
}

// Helper function to calculate material PDF for a given direction
float calculateMaterialPDF( vec3 viewDir, vec3 lightDir, vec3 normal, RayTracingMaterial material ) {
    float NoV = max( 0.0, dot( normal, viewDir ) );
    float NoL = max( 0.0, dot( normal, lightDir ) );
    vec3 H = normalize( viewDir + lightDir );
    float NoH = max( 0.0, dot( normal, H ) );
    float VoH = max( 0.0, dot( viewDir, H ) );
    
    // Calculate lobe weights
    float diffuseWeight = ( 1.0 - material.metalness ) * ( 1.0 - material.transmission );
    float specularWeight = 1.0 - diffuseWeight * ( 1.0 - material.metalness );
    float totalWeight = diffuseWeight + specularWeight;
    
    if( totalWeight <= 0.0 ) return 0.0;
    
    diffuseWeight /= totalWeight;
    specularWeight /= totalWeight;
    
    float pdf = 0.0;
    
    // Diffuse PDF (cosine-weighted hemisphere)
    if( diffuseWeight > 0.0 && NoL > 0.0 ) {
        pdf += diffuseWeight * NoL * PI_INV;
    }
    
    // Specular PDF (GGX distribution)
    if( specularWeight > 0.0 && NoL > 0.0 ) {
        float roughness = max( material.roughness, 0.02 );
        float D = DistributionGGX( NoH, roughness );
        float G1 = GeometrySchlickGGX( NoV, roughness );
        pdf += specularWeight * D * G1 * VoH / max( NoV, 0.001 );
    }
    
    return max( pdf, 1e-8 );
}

// Enhanced area light sampling with proper MIS and validation
vec3 sampleAreaLightContribution(
    AreaLight light,
    vec3 worldWo,
    HitInfo surf,
    vec3 rayOrigin,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    // Sample random position on light surface
    vec2 ruv = vec2( RandomValue( rngState ), RandomValue( rngState ) );
    vec3 lightPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );
    
    vec3 toLight = lightPos - rayOrigin;
    float lightDistSq = dot( toLight, toLight );
    float lightDist = sqrt( lightDistSq );
    vec3 lightDir = toLight / lightDist;
    
    // Check if light is facing the surface
    vec3 lightNormal = normalize( cross( light.u, light.v ) );
    float lightFacing = dot( -lightDir, lightNormal );
    
    if( lightFacing <= 0.0 ) {
        return vec3( 0.0 );
    }
    
    // Check if surface is facing the light
    float surfaceFacing = dot( surf.normal, lightDir );
    if( surfaceFacing <= 0.0 ) {
        return vec3( 0.0 );
    }
    
    // Validate direction
    if( !isDirectionValid( lightDir, surf.normal ) ) {
        return vec3( 0.0 );
    }
    
    // Test for occlusion
    float visibility = traceShadowRay( rayOrigin, lightDir, lightDist - 0.001, rngState, stats );
    if( visibility <= 0.0 ) {
        return vec3( 0.0 );
    }
    
    // Calculate BRDF
    vec3 brdfColor = evaluateMaterialResponse( worldWo, lightDir, surf.normal, surf.material );
    
    // Calculate light PDF
    float lightPdf = lightDistSq / ( light.area * lightFacing );
    
    // Calculate BRDF PDF for MIS
    float brdfPdf = calculateMaterialPDF( worldWo, lightDir, surf.normal, surf.material );
    
    // Apply MIS weighting
    float misWeight = ( brdfPdf > 0.0 ) ? misHeuristic( lightPdf, brdfPdf ) : 1.0;
    
    // Calculate final contribution
    vec3 lightEmission = light.color * light.intensity;
    vec3 contribution = lightEmission * brdfColor * surfaceFacing * visibility * misWeight / lightPdf;
    
    return contribution;
}

// Optimized direct lighting function with importance-based sampling and better MIS
vec3 calculateDirectLightingUnified(
    HitInfo hitInfo,
    vec3 viewDir,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    vec3 totalContribution = vec3( 0.0 );
    vec3 rayOrigin = hitInfo.hitPoint + hitInfo.normal * 0.001;

    // Early exit for highly emissive surfaces
    if( hitInfo.material.emissiveIntensity > 10.0 ) {
        return vec3( 0.0 );
    }

    // IMPROVEMENT: Adaptive MIS Strategy Selection
    vec3 currentThroughput = vec3(1.0); // This should be passed from caller, using 1.0 as fallback
    MISStrategy misStrategy = selectOptimalMISStrategy(hitInfo.material, bounceIndex, currentThroughput);

    // Adaptive light processing based on bounce depth
    int totalLights = getTotalLightCount();
    if( totalLights == 0 ) {
        return vec3( 0.0 );
    }
    
    // Importance threshold that increases with bounce depth for early termination
    float importanceThreshold = 0.001 * ( 1.0 + float( bounceIndex ) * 0.5 );
    
    // Calculate total denominator using adaptive strategy
    float totalSamplingWeight = 0.0;
    if( misStrategy.useLightSampling ) totalSamplingWeight += misStrategy.lightWeight;
    if( misStrategy.useBRDFSampling ) totalSamplingWeight += misStrategy.brdfWeight;
    if( misStrategy.useEnvSampling && enableEnvironmentLight ) totalSamplingWeight += misStrategy.envWeight;

    // Ensure we have valid weights
    if( totalSamplingWeight <= 0.0 ) {
        totalSamplingWeight = 1.0;
        // Fallback to light sampling
        misStrategy.useLightSampling = true;
        misStrategy.lightWeight = 1.0;
    }

    // Use stratified sampling for better distribution with adaptive weights
    vec2 stratifiedRandom = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, -1 );

    // Determine sampling technique based on adaptive strategy
    float rand = stratifiedRandom.x;
    bool sampleLights = false;
    bool sampleBRDF = false;
    bool sampleEnv = false;

    if( rand < misStrategy.lightWeight / totalSamplingWeight && misStrategy.useLightSampling ) {
        sampleLights = true;
    } else if( rand < (misStrategy.lightWeight + misStrategy.brdfWeight) / totalSamplingWeight && misStrategy.useBRDFSampling ) {
        sampleBRDF = true;
    } else if( misStrategy.useEnvSampling && enableEnvironmentLight ) {
        sampleEnv = true;
    } else {
        // Fallback to light sampling
        sampleLights = true;
    }
    
    if( sampleLights ) {
        // 1. IMPORTANCE-WEIGHTED LIGHT SAMPLING STRATEGY
        vec2 lightRandom = vec2( stratifiedRandom.y, RandomValue( rngState ) );
        LightSample lightSample = sampleLightWithImportance( rayOrigin, hitInfo.normal, hitInfo.material, lightRandom, bounceIndex, rngState );
        
        if( lightSample.valid && lightSample.pdf > 0.0 ) {
            float NoL = max( 0.0, dot( hitInfo.normal, lightSample.direction ) );
            
            // Early termination for low-contribution lights
            float lightImportance = lightSample.emission.r + lightSample.emission.g + lightSample.emission.b;
            if( NoL > 0.0 && lightImportance * NoL > importanceThreshold && isDirectionValid( lightSample.direction, hitInfo.normal ) ) {
                // Shadow test with distance optimization
                float shadowDistance = min( lightSample.distance - 0.001, 1000.0 );
                float visibility = traceShadowRay( rayOrigin, lightSample.direction, shadowDistance, rngState, stats );
                
                if( visibility > 0.0 ) {
                    // Evaluate BSDF for light direction
                    vec3 brdfValue = evaluateMaterialResponse( viewDir, lightSample.direction, hitInfo.normal, hitInfo.material );
                    
                    // Calculate BSDF PDF for this direction for improved MIS
                    float brdfPdf = calculateMaterialPDF( viewDir, lightSample.direction, hitInfo.normal, hitInfo.material );
                    
                    // Enhanced MIS weight calculation using adaptive strategy
                    float misWeight = 1.0;
                    if( brdfPdf > 0.0 && misStrategy.useBRDFSampling ) {
                        // Apply adaptive MIS weights based on selected strategy
                        float lightPdfWeighted = lightSample.pdf * misStrategy.lightWeight;
                        float brdfPdfWeighted = brdfPdf * misStrategy.brdfWeight;

                        if( lightSample.lightType == LIGHT_TYPE_AREA ) {
                            misWeight = powerHeuristic( lightPdfWeighted, brdfPdfWeighted );
                        } else if( bounceIndex == 0 && lightSample.lightType == LIGHT_TYPE_DIRECTIONAL ) {
                            // Apply MIS for directional lights on primary rays only
                            misWeight = powerHeuristic( lightPdfWeighted, brdfPdfWeighted );
                        }
                    }
                    
                    // Light contribution with improved MIS
                    vec3 lightContribution = lightSample.emission * brdfValue * NoL * visibility * misWeight / lightSample.pdf;
                    totalContribution += lightContribution * totalSamplingWeight / misStrategy.lightWeight; // Compensate for adaptive selection probability
                }
            }
        }
        
    }

    if( sampleBRDF ) {
        // 2. ENHANCED BSDF SAMPLING STRATEGY (optimized for better MIS)
        if( brdfSample.pdf > 0.0 && misStrategy.useBRDFSampling ) {
            float NoL = max( 0.0, dot( hitInfo.normal, brdfSample.direction ) );
            
            if( NoL > 0.0 && isDirectionValid( brdfSample.direction, hitInfo.normal ) ) {
                // Adaptive area light intersection testing based on importance
                #if MAX_AREA_LIGHTS > 0
                bool foundIntersection = false;
                float maxImportance = 0.0;
                int maxImportanceLight = -1;
                
                // First pass: find most important intersected light
                for( int i = 0; i < MAX_AREA_LIGHTS && !foundIntersection; i++ ) {
                    AreaLight light = getAreaLight( i );
                    if( light.intensity <= 0.0 ) continue;
                    
                    // Quick importance check before expensive intersection test
                    float lightImportance = estimateLightImportance( light, hitInfo.hitPoint, hitInfo.normal, hitInfo.material );
                    if( lightImportance < importanceThreshold ) continue;
                    
                    // Test intersection with area light
                    float hitDistance = 1e6;
                    if( intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance ) ) {
                        if( lightImportance > maxImportance ) {
                            maxImportance = lightImportance;
                            maxImportanceLight = i;
                        }
                        foundIntersection = true;
                    }
                }
                
                // Process the most important intersected light
                if( foundIntersection && maxImportanceLight >= 0 ) {
                    AreaLight light = getAreaLight( maxImportanceLight );
                    float hitDistance = 1e6;
                    
                    if( intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance ) ) {
                        // Shadow test with distance optimization
                        float shadowDistance = min( hitDistance - 0.001, 1000.0 );
                        float visibility = traceShadowRay( rayOrigin, brdfSample.direction, shadowDistance, rngState, stats );
                        
                        if( visibility > 0.0 ) {
                            // Calculate light PDF for this intersection
                            float lightFacing = max( 0.0, -dot( brdfSample.direction, light.normal ) );
                            if( lightFacing > 0.0 ) {
                                float lightDistSq = hitDistance * hitDistance;
                                float lightPdf = lightDistSq / ( light.area * lightFacing );
                                lightPdf /= float( totalLights ); // Account for light selection probability
                                
                                // Enhanced MIS weight using adaptive strategy
                                float brdfPdfWeighted = brdfSample.pdf * misStrategy.brdfWeight;
                                float lightPdfWeighted = lightPdf * misStrategy.lightWeight;
                                float misWeight = powerHeuristic( brdfPdfWeighted, lightPdfWeighted );

                                // BSDF sampling contribution with importance weighting
                                vec3 lightEmission = light.color * light.intensity;
                                vec3 brdfContribution = lightEmission * brdfSample.value * NoL * visibility * misWeight / brdfSample.pdf;
                                totalContribution += brdfContribution * totalSamplingWeight / misStrategy.brdfWeight;
                            }
                        }
                    }
                }
                #endif
            }
        }
    }

    if( sampleEnv ) {
        // 3. ADAPTIVE ENVIRONMENT SAMPLING
        if( enableEnvironmentLight && misStrategy.useEnvSampling ) {
            vec2 envRandom = vec2( RandomValue( rngState ), RandomValue( rngState ) );

            // Sample environment map with importance sampling using our improved function
            EnvMapSample envSample = sampleEnvironmentWithContext( envRandom, bounceIndex, hitInfo.material, viewDir, hitInfo.normal );

            if( envSample.pdf > 0.0 ) {
                float NoL = max( 0.0, dot( hitInfo.normal, envSample.direction ) );

                if( NoL > 0.0 && isDirectionValid( envSample.direction, hitInfo.normal ) ) {
                    // Shadow test for environment direction
                    float visibility = traceShadowRay( rayOrigin, envSample.direction, 1000.0, rngState, stats );

                    if( visibility > 0.0 ) {
                        // Calculate BRDF response for environment direction
                        vec3 brdfValue = evaluateMaterialResponse( viewDir, envSample.direction, hitInfo.normal, hitInfo.material );
                        float brdfPdf = calculateMaterialPDF( viewDir, envSample.direction, hitInfo.normal, hitInfo.material );

                        // MIS weight using adaptive strategy
                        float envPdfWeighted = envSample.pdf * misStrategy.envWeight;
                        float brdfPdfWeighted = brdfPdf * misStrategy.brdfWeight;
                        float misWeight = (brdfPdf > 0.0) ? powerHeuristic( envPdfWeighted, brdfPdfWeighted ) : 1.0;

                        // Environment contribution with adaptive MIS
                        vec3 envContribution = envSample.value * brdfValue * NoL * visibility * misWeight / envSample.pdf;
                        totalContribution += envContribution * totalSamplingWeight / misStrategy.envWeight;
                    }
                }
            }
        }
    }
    
    return totalContribution;
}

// =============================================================================
// LEGACY LIGHTING FUNCTION (Kept for backward compatibility)
// =============================================================================

vec3 calculateDirectLightingMIS(
    HitInfo hitInfo,
    vec3 V,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    inout ivec2 stats
) {
    vec3 totalLighting = vec3( 0.0 );
    vec3 N = hitInfo.normal;

    MaterialCache matCache = createMaterialCacheLegacy( N, V, hitInfo.material );

    // Early termination for materials that don't need direct lighting
    if( hitInfo.material.emissiveIntensity > 10.0 ) {
        // Highly emissive materials don't need direct lighting contribution
        return vec3( 0.0 );
    }

    // Skip direct lighting for pure glass/transparent materials at deeper bounces
    if( bounceIndex > 1 && hitInfo.material.transmission > 0.95 && hitInfo.material.roughness < 0.1 ) {
        return vec3( 0.0 );
    }

    // Importance threshold that increases with bounce depth
    float importanceThreshold = 0.001 * ( 1.0 + float( bounceIndex ) * 0.5 );

    // -----------------------------
    // Directional lights processing
    // -----------------------------
    #if MAX_DIRECTIONAL_LIGHTS > 0

    // Adaptive light count based on bounce depth and material
    int directionalLightCount = MAX_DIRECTIONAL_LIGHTS;
    if( bounceIndex > 0 ) {
        // More aggressive reduction for secondary bounces
        if( bounceIndex == 1 ) {
            directionalLightCount = max( 1, min( 4, MAX_DIRECTIONAL_LIGHTS ) );
        } else if( bounceIndex == 2 ) {
            directionalLightCount = max( 1, min( 2, MAX_DIRECTIONAL_LIGHTS ) );
        } else {
            // For very deep bounces, only process the most important light
            directionalLightCount = 1;
        }
    }

    // Process lights in importance order (they should be pre-sorted by importance)
    #pragma unroll_loop_start
    for( int i = 0; i < min( 16, directionalLightCount ); i ++ ) {
        if( i >= MAX_DIRECTIONAL_LIGHTS )
            break;

        DirectionalLight light = getDirectionalLight( i );

        // Material-aware importance check for directional lights
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : 
                               (hitInfo.material.roughness > 0.8 ? 0.7 : 1.0);
        float quickDirImportance = light.intensity * materialWeight * max( 0.0, dot( N, light.direction ) );
        if( quickDirImportance < importanceThreshold ) {
            continue;
        }

        totalLighting += calculateDirectionalLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, bounceIndex, rngState, stats );
    }
    #pragma unroll_loop_end
    #endif // MAX_DIRECTIONAL_LIGHTS > 0

    // ----------------------
    // Area lights processing
    // ----------------------
    #if MAX_AREA_LIGHTS > 0 
    // For deeper bounces, limit area light count
    int maxAreaLightCount = ( MAX_AREA_LIGHTS / 13 );
    if( bounceIndex > 2 ) {
        maxAreaLightCount = min( 2, maxAreaLightCount );
    } else if( bounceIndex > 1 ) {
        maxAreaLightCount = min( 4, maxAreaLightCount );
    }

    for( int i = 0; i < maxAreaLightCount; i ++ ) {
        AreaLight light = getAreaLight( i );
        if( light.intensity <= 0.0 )
            continue;

        // Quick distance and facing checks
        vec3 lightCenter = light.position - hitInfo.hitPoint;
        float distSq = dot( lightCenter, lightCenter );

        // Material-aware importance calculation for early culling
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : 
                               (hitInfo.material.roughness > 0.8 ? 0.7 : 1.0);
        float quickImportance = (light.intensity * light.area * materialWeight) / max( distSq, 1.0 );
        if( quickImportance < importanceThreshold ) {
            continue;
        }

        float cosTheta = dot( normalize( lightCenter ), N );

        // Early exit for lights that won't contribute much
        if( distSq > ( light.intensity * 100.0 ) || ( hitInfo.material.metalness > 0.9 && cosTheta <= 0.0 ) ) {
            continue;
        }

        totalLighting += calculateAreaLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, sampleIndex, bounceIndex, rngState, stats );
    }
    #endif // MAX_AREA_LIGHTS > 0

    // ----------------------
    // Point lights processing
    // ----------------------
    #if MAX_POINT_LIGHTS > 0
    // For deeper bounces, limit point light count
    int maxPointLightCount = MAX_POINT_LIGHTS;
    if( bounceIndex > 2 ) {
        maxPointLightCount = min( 2, MAX_POINT_LIGHTS );
    } else if( bounceIndex > 1 ) {
        maxPointLightCount = min( 4, MAX_POINT_LIGHTS );
    }

    for( int i = 0; i < maxPointLightCount; i ++ ) {
        if( i >= MAX_POINT_LIGHTS )
            break;
            
        PointLight light = getPointLight( i );
        if( light.intensity <= 0.0 )
            continue;

        // Material-aware distance check for early culling
        vec3 toLight = light.position - hitInfo.hitPoint;
        float distSq = dot( toLight, toLight );
        
        // Material-aware culling with distance check
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : 
                               (hitInfo.material.roughness > 0.8 ? 0.7 : 1.0);
        float effectiveIntensity = light.intensity * materialWeight;
        if( distSq > ( effectiveIntensity * 10000.0 ) || distSq < 0.001 )
            continue;

        totalLighting += calculatePointLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, bounceIndex, rngState, stats );
    }
    #endif // MAX_POINT_LIGHTS > 0

    // ----------------------
    // Spot lights processing
    // ----------------------
    #if MAX_SPOT_LIGHTS > 0
    // For deeper bounces, limit spot light count
    int maxSpotLightCount = MAX_SPOT_LIGHTS;
    if( bounceIndex > 2 ) {
        maxSpotLightCount = min( 2, MAX_SPOT_LIGHTS );
    } else if( bounceIndex > 1 ) {
        maxSpotLightCount = min( 4, MAX_SPOT_LIGHTS );
    }

    for( int i = 0; i < maxSpotLightCount; i ++ ) {
        if( i >= MAX_SPOT_LIGHTS )
            break;
            
        SpotLight light = getSpotLight( i );
        if( light.intensity <= 0.0 )
            continue;

        // Material-aware distance check for early culling
        vec3 toLight = light.position - hitInfo.hitPoint;
        float distSq = dot( toLight, toLight );
        
        // Material-aware culling with distance check
        float materialWeight = hitInfo.material.metalness > 0.7 ? 1.5 : 
                               (hitInfo.material.roughness > 0.8 ? 0.7 : 1.0);
        float effectiveIntensity = light.intensity * materialWeight;
        if( distSq > ( effectiveIntensity * 10000.0 ) || distSq < 0.001 )
            continue;

        totalLighting += calculateSpotLightContribution( light, hitInfo.hitPoint, N, V, hitInfo.material, matCache, brdfSample, bounceIndex, rngState, stats );
    }
    #endif // MAX_SPOT_LIGHTS > 0

    return totalLighting;
}

float calculateTransmissionPDF( vec3 V, vec3 L, vec3 N, float ior, float roughness, bool entering ) {
    // Calculate the half vector for transmission
    float eta = entering ? 1.0 / ior : ior;
    vec3 H = normalize( V + L * eta );

    if( dot( H, N ) < 0.0 )
        H = - H; // Ensure H points into the correct hemisphere

    float VoH = abs( dot( V, H ) );
    float LoH = abs( dot( L, H ) );
    float NoH = abs( dot( N, H ) );

    // GGX distribution
    float D = DistributionGGX( NoH, roughness );

    // Jacobian for transmission
    float denom = square( VoH + LoH * eta );
    float jacobian = ( LoH * eta * eta ) / max( denom, EPSILON );

    return D * NoH * jacobian;
}

float calculateClearcoatPDF( vec3 V, vec3 L, vec3 N, float clearcoatRoughness ) {
    vec3 H = normalize( V + L );
    float NoH = max( dot( N, H ), 0.0 );
    float VoH = max( dot( V, H ), 0.0 );
    float NoV = max( dot( N, V ), 0.0 );

    float D = DistributionGGX( NoH, clearcoatRoughness );
    float G1 = GeometrySchlickGGX( NoV, clearcoatRoughness );

    return ( D * G1 * VoH ) / ( NoV * 4.0 );
}

// Validation function for sampling info
bool validateSamplingInfo( ImportanceSamplingInfo info ) {
    return ( info.diffuseImportance >= 0.0 ) &&
        ( info.specularImportance >= 0.0 ) &&
        ( info.transmissionImportance >= 0.0 ) &&
        ( info.clearcoatImportance >= 0.0 ) &&
        ( info.envmapImportance >= 0.0 );
}

SamplingStrategyWeights computeSamplingInfo(
    ImportanceSamplingInfo samplingInfo,
    int bounceIndex,
    RayTracingMaterial material
) {
    SamplingStrategyWeights info;

    // Environment sampling weight
    info.envWeight = 0.0;
    info.useEnv = false;
    if( enableEnvironmentLight && shouldUseEnvironmentSampling( bounceIndex, material ) ) {
        info.envWeight = samplingInfo.envmapImportance;
        info.useEnv = info.envWeight > 0.001;
    }

    // Separate each sampling strategy
    info.specularWeight = samplingInfo.specularImportance;
    info.useSpecular = info.specularWeight > 0.001;

    info.diffuseWeight = samplingInfo.diffuseImportance;
    info.useDiffuse = info.diffuseWeight > 0.001;

    info.transmissionWeight = samplingInfo.transmissionImportance;
    info.useTransmission = info.transmissionWeight > 0.001;

    info.clearcoatWeight = samplingInfo.clearcoatImportance;
    info.useClearcoat = info.clearcoatWeight > 0.001;

    // Calculate total weight
    info.totalWeight = info.envWeight + info.specularWeight + info.diffuseWeight +
        info.transmissionWeight + info.clearcoatWeight;

    // Proper normalization and fallback
    if( info.totalWeight < 0.001 ) {
        // Safe fallback to diffuse sampling
        info = SamplingStrategyWeights( 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, false, false, true, false, false );
    } else {
        // CRITICAL: Normalize weights to sum to 1.0
        float invTotal = 1.0 / info.totalWeight;
        info.envWeight *= invTotal;
        info.specularWeight *= invTotal;
        info.diffuseWeight *= invTotal;
        info.transmissionWeight *= invTotal;
        info.clearcoatWeight *= invTotal;
        info.totalWeight = 1.0;
    }

    return info;
}

// Fixed strategy selection with proper cumulative distribution
void selectSamplingStrategy(
    SamplingStrategyWeights weights,
    float randomValue,
    out int selectedStrategy,
    out float strategyPdf
) {
    // Strategy IDs: 0=env, 1=specular, 2=diffuse, 3=transmission, 4=clearcoat

    float cumulative = 0.0;

    if( weights.useEnv ) {
        cumulative += weights.envWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 0;
            strategyPdf = weights.envWeight;
            return;
        }
    }

    if( weights.useSpecular ) {
        cumulative += weights.specularWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 1;
            strategyPdf = weights.specularWeight;
            return;
        }
    }

    if( weights.useDiffuse ) {
        cumulative += weights.diffuseWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 2;
            strategyPdf = weights.diffuseWeight;
            return;
        }
    }

    if( weights.useTransmission ) {
        cumulative += weights.transmissionWeight;
        if( randomValue < cumulative ) {
            selectedStrategy = 3;
            strategyPdf = weights.transmissionWeight;
            return;
        }
    }

    if( weights.useClearcoat ) {
        selectedStrategy = 4;
        strategyPdf = weights.clearcoatWeight;
        return;
    }

    // Fallback
    selectedStrategy = 2; // Diffuse
    strategyPdf = weights.useDiffuse ? weights.diffuseWeight : 1.0;
}

IndirectLightingResult calculateIndirectLighting(
    vec3 V,
    vec3 N,
    RayTracingMaterial material,
    DirectionSample brdfSample,
    int sampleIndex,
    int bounceIndex,
    inout uint rngState,
    ImportanceSamplingInfo samplingInfo
) {
    // Initialize result
    IndirectLightingResult result;

    // Validate input sampling info
    if( samplingInfo.diffuseImportance < 0.0 ||
        samplingInfo.specularImportance < 0.0 ||
        samplingInfo.transmissionImportance < 0.0 ||
        samplingInfo.clearcoatImportance < 0.0 ||
        samplingInfo.envmapImportance < 0.0 ) {
        // Fallback to diffuse sampling
        result.direction = cosineWeightedSample( N, vec2( RandomValue( rngState ), RandomValue( rngState ) ) );
        result.throughput = material.color.rgb;
        result.misWeight = 1.0;
        result.pdf = 1.0;
        return result;
    }

    // Use corrected sampling info
    SamplingStrategyWeights weights = computeSamplingInfo( samplingInfo, bounceIndex, material );

    float selectionRand = RandomValue( rngState );
    vec2 sampleRand = vec2( RandomValue( rngState ), RandomValue( rngState ) );

    // Strategy selection
    int selectedStrategy;
    float strategySelectionPdf;
    selectSamplingStrategy( weights, selectionRand, selectedStrategy, strategySelectionPdf );

    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdfValue;

    // Execute selected strategy
    if( selectedStrategy == 0 ) { // Environment
        EnvMapSample envSample = sampleEnvironmentWithContext( sampleRand, bounceIndex, material, V, N );
        sampleDir = envSample.direction;
        samplePdf = envSample.pdf;
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );

    } else if( selectedStrategy == 1 ) { // Specular
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdfValue = brdfSample.value;

    } else if( selectedStrategy == 2 ) { // Diffuse
        sampleDir = cosineWeightedSample( N, sampleRand );
        samplePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );

    } else if( selectedStrategy == 3 ) { // Transmission
        bool entering = dot( V, N ) < 0.0;
        MicrofacetTransmissionResult mtResult = sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, sampleRand, rngState );
        sampleDir = mtResult.direction;
        samplePdf = mtResult.pdf;
        sampleBrdfValue = evaluateMaterialResponse( V, sampleDir, N, material );

    } else { // Clearcoat (strategy 4)
        // Note: This needs to be implemented properly based on your clearcoat sampling
        sampleDir = brdfSample.direction; // Fallback for now
        samplePdf = brdfSample.pdf;
        sampleBrdfValue = brdfSample.value;
    }

    float NoL = max( dot( N, sampleDir ), 0.0 );

    // Calculate combined PDF for MIS (all active strategies)
    float combinedPdf = 0.0;

    if( weights.useEnv ) {
        float envPdf = envMapSamplingPDFWithContext( sampleDir, bounceIndex, material, V, N );
        combinedPdf += weights.envWeight * envPdf;
    }

    if( weights.useSpecular ) {
        combinedPdf += weights.specularWeight * brdfSample.pdf;
    }

    if( weights.useDiffuse ) {
        float diffusePdf = cosineWeightedPDF( NoL );
        combinedPdf += weights.diffuseWeight * diffusePdf;
    }

    if( weights.useTransmission && material.transmission > 0.0 ) {
        // Calculate transmission PDF for this direction
        bool entering = dot( V, N ) < 0.0;
        float transmissionPdf = calculateTransmissionPDF( V, sampleDir, N, material.ior, material.roughness, entering );
        combinedPdf += weights.transmissionWeight * transmissionPdf;
    }

    if( weights.useClearcoat && material.clearcoat > 0.0 ) {
        // Calculate clearcoat PDF for this direction
        float clearcoatPdf = calculateClearcoatPDF( V, sampleDir, N, material.clearcoatRoughness );
        combinedPdf += weights.clearcoatWeight * clearcoatPdf;
    }

    // Ensure valid PDFs
    samplePdf = max( samplePdf, MIN_PDF );
    combinedPdf = max( combinedPdf, MIN_PDF );

    // MIS weight calculation
    float misWeight = samplePdf / combinedPdf;

    // Throughput calculation
    vec3 throughput = sampleBrdfValue * NoL * misWeight / samplePdf;

    // Apply global illumination scaling
    throughput *= globalIlluminationIntensity;

    // Apply firefly reduction with proper material context
    float materialTolerance = getMaterialFireflyTolerance( material );
    float viewTolerance = getViewDependentTolerance( material, sampleDir, V, N );
    float finalThreshold = calculateFireflyThreshold( fireflyThreshold, materialTolerance * viewTolerance, bounceIndex );
    throughput = applySoftSuppressionRGB( throughput, finalThreshold, 0.25 );

    result.direction = sampleDir;
    result.throughput = throughput;
    result.misWeight = misWeight;
    result.pdf = samplePdf;

    return result;
}

// -----------------------------------------------------------------------------
// Debug/Helper Functions
// -----------------------------------------------------------------------------

vec3 evaluateAreaLightHelper( AreaLight light, Ray ray, out bool didHit ) {
    // Get light plane normal
    vec3 lightNormal = normalize( cross( light.u, light.v ) );

    // Calculate intersection with the light plane
    float denom = dot( lightNormal, ray.direction );

    // Skip if ray is parallel to plane
    if( abs( denom ) < 1e-6 ) {
        didHit = false;
        return vec3( 0.0 );
    }

    // Calculate intersection distance
    float t = dot( light.position - ray.origin, lightNormal ) / denom;

    // Skip if intersection is behind ray
    if( t < 0.0 ) {
        didHit = false;
        return vec3( 0.0 );
    }

    // Calculate intersection point
    vec3 hitPoint = ray.origin + ray.direction * t;
    vec3 localPoint = hitPoint - light.position;

    // Project onto light's axes
    float u = dot( localPoint, normalize( light.u ) );
    float v = dot( localPoint, normalize( light.v ) );

    // Check if point is within rectangle bounds
    if( abs( u ) <= length( light.u ) && abs( v ) <= length( light.v ) ) {
        didHit = true;
        // Return visualization color based on light properties
        return light.color * light.intensity * 0.1; // Scale for visibility
    }

    didHit = false;
    return vec3( 0.0 );
}