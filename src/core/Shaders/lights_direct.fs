// =============================================================================
// LIGHTS DIRECT
// =============================================================================
// This file contains direct lighting calculations including shadow ray tracing
// and contribution calculations for all light types.

// -----------------------------------------------------------------------------
// Shadow Ray Tracing
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

// -----------------------------------------------------------------------------
// Ray Offset Calculation
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

// -----------------------------------------------------------------------------
// Light Importance Estimation
// -----------------------------------------------------------------------------

// Directional light importance calculation
float calculateDirectionalLightImportance(
    DirectionalLight light,
    vec3 hitPoint,
    vec3 normal,
    RayTracingMaterial material,
    int bounceIndex
) {
    float NoL = max( 0.0, dot( normal, light.direction ) );
    if( NoL <= 0.0 )
        return 0.0;

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

// Area light importance estimation
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

// Point light importance calculation
float calculatePointLightImportance(
    PointLight light,
    vec3 hitPoint,
    vec3 normal,
    RayTracingMaterial material
) {
    vec3 toLight = light.position - hitPoint;
    float distSq = dot( toLight, toLight );
    if( distSq < 0.001 )
        return 0.0; // Too close

    vec3 lightDir = toLight / sqrt( distSq );
    float NoL = max( 0.0, dot( normal, lightDir ) );
    if( NoL <= 0.0 )
        return 0.0;

    // Distance attenuation
    float distanceFactor = 1.0 / max( distSq, 0.01 );

    // Intensity and color
    float intensity = light.intensity * luminance( light.color );

    // Material weighting
    float materialWeight = material.metalness > 0.7 ? 1.5 : ( material.roughness > 0.8 ? 0.8 : 1.0 );

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
    if( distSq < 0.001 )
        return 0.0;

    vec3 lightDir = toLight / sqrt( distSq );
    float NoL = max( 0.0, dot( normal, lightDir ) );
    if( NoL <= 0.0 )
        return 0.0;

    // Check if point is within spot cone
    float spotCosAngle = dot( - lightDir, light.direction );
    float coneCosAngle = cos( light.angle );
    if( spotCosAngle < coneCosAngle )
        return 0.0;

    // Distance attenuation
    float distanceFactor = 1.0 / max( distSq, 0.01 );

    // Cone attenuation
    float coneAttenuation = smoothstep( coneCosAngle, coneCosAngle + 0.1, spotCosAngle );

    // Intensity and color
    float intensity = light.intensity * luminance( light.color );

    // Material weighting
    float materialWeight = material.metalness > 0.7 ? 1.5 : ( material.roughness > 0.8 ? 0.8 : 1.0 );

    return intensity * distanceFactor * coneAttenuation * NoL * materialWeight;
}

// -----------------------------------------------------------------------------
// Directional Light Contribution
// -----------------------------------------------------------------------------

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
    }

    return contribution;
}

// -----------------------------------------------------------------------------
// Area Light Contribution
// -----------------------------------------------------------------------------

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

    // LIGHT SAMPLING STRATEGY
    if( isFirstBounce || isDiffuse || ( lightImportance > 0.1 && ! isSpecular ) ) {
        // Get stratified sample point for better coverage
        vec2 ruv = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex, rngState, - 1 );

        // Generate position on light surface
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
            // Shadow test
            float visibility = traceShadowRay( rayOrigin, lightDir, lightDist, rngState, stats );

            if( visibility > 0.0 ) {
                // BRDF evaluation
                vec3 brdfValue = evaluateMaterialResponseCached( viewDir, lightDir, normal, material, matCache );

                // Calculate PDFs for MIS
                float lightPdf = lightDistSq / ( light.area * lightFacing );
                float brdfPdf = brdfSample.pdf;

                // Light contribution with inverse-square falloff
                float falloff = light.area / ( 4.0 * PI * lightDistSq );
                vec3 lightContribution = light.color * light.intensity * falloff * lightFacing;

                // MIS weight
                float misWeight = ( brdfPdf > 0.0 && isFirstBounce ) ? powerHeuristic( lightPdf, brdfPdf ) : 1.0;

                contribution += lightContribution * brdfValue * NoL * visibility * misWeight;
            }
        }
    }

    // BRDF SAMPLING STRATEGY
    if( ( isFirstBounce || isSpecular ) && brdfSample.pdf > 0.0 ) {
        // Fast path - check if ray could possibly hit light
        vec3 toLight = light.position - rayOrigin;
        float rayToLightDot = dot( toLight, brdfSample.direction );

        // Only proceed if ray is pointing toward light
        if( rayToLightDot > 0.0 ) {
            float hitDistance = 0.0;
            bool hitLight = intersectAreaLight( light, rayOrigin, brdfSample.direction, hitDistance );

            if( hitLight ) {
                float visibility = traceShadowRay( rayOrigin, brdfSample.direction, hitDistance, rngState, stats );

                if( visibility > 0.0 ) {
                    float lightFacing = max( 0.0, - dot( brdfSample.direction, light.normal ) );

                    if( lightFacing > 0.0 ) {
                        // PDFs for MIS
                        float lightPdf = ( hitDistance * hitDistance ) / ( light.area * lightFacing );
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
// Point Light Contribution
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
    float distance = length( toLight );

    // Early exit for extremely far lights
    if( distance > 1000.0 )
        return vec3( 0.0 );

    vec3 lightDir = toLight / distance;

    // Check if light is on same side of surface as normal
    float NdotL = dot( normal, lightDir );
    if( NdotL <= 0.0 )
        return vec3( 0.0 );

    // Calculate attenuation using inverse square law
    float attenuation = 1.0 / ( distance * distance );

    // Apply intensity and color
    vec3 lightRadiance = light.color * light.intensity * attenuation;

    // Calculate shadow ray offset
    vec3 rayOffset = calculateRayOffset( hitPoint, normal, material );
    vec3 rayOrigin = hitPoint + rayOffset;

    // Trace shadow ray
    float visibility = traceShadowRay( rayOrigin, lightDir, distance - 0.001, rngState, stats );
    if( visibility <= 0.0 )
        return vec3( 0.0 );

    // Calculate BRDF contribution
    vec3 brdfValue = evaluateMaterialResponse( viewDir, lightDir, normal, material );

    // Final contribution
    return brdfValue * lightRadiance * NdotL * visibility;
}

// -----------------------------------------------------------------------------
// Spot Light Contribution
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
    float distance = length( toLight );

    // Early exit for extremely far lights
    if( distance > 1000.0 )
        return vec3( 0.0 );

    vec3 lightDir = toLight / distance;

    // Check if light is on same side of surface as normal
    float NdotL = dot( normal, lightDir );
    if( NdotL <= 0.0 )
        return vec3( 0.0 );

    // Calculate spot light cone attenuation
    float spotCosAngle = dot( - lightDir, light.direction );
    float coneCosAngle = cos( light.angle );

    // Early exit if outside the cone
    if( spotCosAngle < coneCosAngle )
        return vec3( 0.0 );

    // Smooth falloff at cone edge
    float coneAttenuation = smoothstep( coneCosAngle, coneCosAngle + 0.1, spotCosAngle );

    // Calculate distance attenuation
    float distanceAttenuation = 1.0 / ( distance * distance );

    // Apply intensity, color, and both attenuations
    vec3 lightRadiance = light.color * light.intensity * distanceAttenuation * coneAttenuation;

    // Calculate shadow ray offset
    vec3 rayOffset = calculateRayOffset( hitPoint, normal, material );
    vec3 rayOrigin = hitPoint + rayOffset;

    // Trace shadow ray
    float visibility = traceShadowRay( rayOrigin, lightDir, distance - 0.001, rngState, stats );
    if( visibility <= 0.0 )
        return vec3( 0.0 );

    // Calculate BRDF contribution
    vec3 brdfValue = evaluateMaterialResponse( viewDir, lightDir, normal, material );

    // Final contribution
    return brdfValue * lightRadiance * NdotL * visibility;
}