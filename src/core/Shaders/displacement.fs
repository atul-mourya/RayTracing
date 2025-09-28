// Tessellation-free displacement mapping implementation
// Uses sphere tracing / ray marching to find intersection with displaced surface

// Configuration constants for displacement mapping
const int MAX_DISPLACEMENT_STEPS = 64;
const int MAX_BINARY_SEARCH_STEPS = 8;
const float DISPLACEMENT_EPSILON = 0.0001;
const float MIN_STEP_SIZE = 0.0005;

// Sample displacement map at given UV coordinates - moved to texture_sampling.fs

// Get surface height at point using displacement mapping
float getDisplacedHeight( vec3 point, vec3 normal, vec2 baseUV, RayTracingMaterial material ) {
    if( material.displacementMapIndex < 0 ) {
        return 0.0;
    }

    float heightSample = sampleDisplacementMap( material.displacementMapIndex, baseUV, material.displacementTransform );
    return heightSample * material.displacementScale;
}

// Calculate displaced position along surface normal
vec3 getDisplacedPosition( vec3 basePoint, vec3 normal, vec2 uv, RayTracingMaterial material ) {
    float height = getDisplacedHeight( basePoint, normal, uv, material );
    return basePoint + normal * height;
}

// Simplified displacement application for post-intersection processing
vec3 applyDisplacement( vec3 basePoint, vec3 normal, vec2 uv, RayTracingMaterial material ) {
    if( material.displacementMapIndex < 0 ) {
        return basePoint;
    }

    float height = getDisplacedHeight( basePoint, normal, uv, material );
    return basePoint + normal * height;
}

// Calculate normal for displaced surface using finite differences
vec3 calculateDisplacedNormal( vec3 point, vec3 baseNormal, vec2 uv, RayTracingMaterial material ) {
    if( material.displacementMapIndex < 0 ) {
        return baseNormal;
    }

    // Use larger offset for smoother normal variation - prevents overly sharp/glossy appearance
    float h = 0.01; // Increased from 0.001 for smoother results

    // Sample heights at nearby UV coordinates
    float heightCenter = getDisplacedHeight( point, baseNormal, uv, material );
    float heightU = getDisplacedHeight( point, baseNormal, uv + vec2( h, 0.0 ), material );
    float heightV = getDisplacedHeight( point, baseNormal, uv + vec2( 0.0, h ), material );

    // Calculate partial derivatives with smoothing
    float dHdU = ( heightU - heightCenter ) / h;
    float dHdV = ( heightV - heightCenter ) / h;

    // Scale down the gradient strength to avoid overly sharp normals
    float gradientStrength = 0.5; // Reduce from 1.0 to make it less aggressive
    dHdU *= gradientStrength;
    dHdV *= gradientStrength;

    // Create tangent vectors (simplified - assumes UV corresponds to world space)
    vec3 tangentU = normalize( cross( baseNormal, vec3( 0.0, 1.0, 0.0 ) ) );
    vec3 tangentV = normalize( cross( baseNormal, tangentU ) );

    // Perturb normal based on height gradients with reduced strength
    vec3 displacedNormal = baseNormal - dHdU * tangentU - dHdV * tangentV;
    return normalize( displacedNormal );
}

// Ray marching function to find displaced surface intersection
HitInfo RayTriangleDisplaced( Ray ray, Triangle tri ) {
    // First, get the base triangle intersection
    HitInfo baseHit = RayTriangle( ray, tri );

    if( ! baseHit.didHit ) {
        return baseHit;
    }

    // Get material from material index
    RayTracingMaterial material = getMaterial( tri.materialIndex );

    // If displacement is not enabled, return base hit
    if( material.displacementMapIndex < 0 || material.displacementScale <= 0.0 ) {
        return baseHit;
    }

    // Ray march to find the actual displaced surface
    vec3 rayDir = ray.direction;
    vec3 rayOrigin = ray.origin;

    // Start marching from slightly before the base surface
    float marchStart = max( 0.0, baseHit.dst - material.displacementScale );
    float marchEnd = baseHit.dst + material.displacementScale;

    // Dynamic step size based on displacement scale
    float stepSize = material.displacementScale / 16.0; // 16 steps across displacement range
    stepSize = max( stepSize, 0.001 ); // Minimum step size

    vec3 baseNormal = baseHit.normal;
    vec2 baseUV = baseHit.uv;

    // Ray marching loop
    for( float t = marchStart; t < marchEnd; t += stepSize ) {
        vec3 marchPoint = rayOrigin + rayDir * t;

        // Project point onto base triangle to get UV coordinates
        vec3 toPoint = marchPoint - baseHit.hitPoint;
        vec3 projected = baseHit.hitPoint + toPoint - baseNormal * dot( toPoint, baseNormal );

        // Use base UV for now (could be improved with proper UV interpolation)
        vec2 currentUV = baseUV;

        // Get displacement at this point
        float heightSample = sampleDisplacementMap( material.displacementMapIndex, currentUV, material.displacementTransform );
        float displacementHeight = ( heightSample - 0.5 ) * material.displacementScale;
        vec3 displacedSurface = baseHit.hitPoint + baseNormal * displacementHeight;

        // Check if we're close to the displaced surface
        float distanceToSurface = dot( marchPoint - displacedSurface, baseNormal );

        if( abs( distanceToSurface ) < stepSize * 0.5 ) {
            // Found intersection - create displaced hit info
            HitInfo displacedHit = baseHit;
            displacedHit.dst = t;
            displacedHit.hitPoint = marchPoint;
            displacedHit.uv = currentUV;
            displacedHit.normal = calculateDisplacedNormal( displacedSurface, baseNormal, currentUV, material );
            return displacedHit;
        }
    }

    // If no displaced intersection found, return base hit
    return baseHit;
}
