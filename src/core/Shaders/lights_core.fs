// =============================================================================
// LIGHTS CORE
// =============================================================================
// This file contains light data structures, uniform declarations, and
// basic light data access functions.

// -----------------------------------------------------------------------------
// Uniform Declarations
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

// -----------------------------------------------------------------------------
// Light Structure Definitions
// -----------------------------------------------------------------------------

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

struct LightSample {
    vec3 direction;
    vec3 emission;
    float pdf;
    float distance;
    int lightType;
    bool valid;
};

struct IndirectLightingResult {
    vec3 direction;    // Sampled direction for next bounce
    vec3 throughput;   // Light throughput along this path
    float misWeight;   // MIS weight for this sample
    float pdf;         // PDF of the generated sample
};

// Light type constants
const int LIGHT_TYPE_DIRECTIONAL = 0;
const int LIGHT_TYPE_AREA = 1;
const int LIGHT_TYPE_POINT = 2;
const int LIGHT_TYPE_SPOT = 3;

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
// Light Utility Functions
// -----------------------------------------------------------------------------

// Get total number of lights in the scene
int getTotalLightCount( ) {
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

// Utility function to validate ray direction
bool isDirectionValid( vec3 direction, vec3 surfaceNormal ) {
    return dot( direction, surfaceNormal ) > 0.0;
}

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

// Power heuristic for Multiple Importance Sampling
float misHeuristic( float a, float b ) {
    float aa = a * a;
    float bb = b * b;
    return aa / ( aa + bb );
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
// Light Intersection Tests
// -----------------------------------------------------------------------------

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