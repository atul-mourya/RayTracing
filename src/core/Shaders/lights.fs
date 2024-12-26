#if MAX_DIRECTIONAL_LIGHTS > 0
uniform float directionalLights[ MAX_DIRECTIONAL_LIGHTS * 7 ]; // 7 values per light;
#else
uniform float directionalLights[ 1 ]; // Dummy array to avoid compilation error
#endif

struct AreaLight {
    vec3 position;
    vec3 u; // First axis of the rectangular light
    vec3 v; // Second axis of the rectangular light
    vec3 color;
    float intensity;
};

#if MAX_AREA_LIGHTS > 0
uniform float areaLights[ MAX_AREA_LIGHTS * 13 ]; // 13 values per light;
#else
uniform float areaLights[ 1 ]; // Dummy array to avoid compilation error
#endif

uniform float globalIlluminationIntensity;

struct DirectionalLight {
    vec3 direction;
    vec3 color;
    float intensity;
};

DirectionalLight getDirectionalLight( int index ) {
    int baseIndex = index * 7;
    DirectionalLight light;
    light.direction = vec3( directionalLights[ baseIndex ], directionalLights[ baseIndex + 1 ], directionalLights[ baseIndex + 2 ] );
    light.color = vec3( directionalLights[ baseIndex + 3 ], directionalLights[ baseIndex + 4 ], directionalLights[ baseIndex + 5 ] );
    light.intensity = directionalLights[ baseIndex + 6 ];
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

    return light;
}

vec3 sampleAreaLight( AreaLight light, vec2 xi, out vec3 lightPos, out float pdf ) {
    vec3 randomPos = light.position + light.u * ( xi.x - 0.5 ) + light.v * ( xi.y - 0.5 );
    lightPos = randomPos;
    vec3 lightArea = cross( light.u, light.v );
    float area = length( lightArea );
    pdf = 1.0 / area;
    return normalize( lightPos );
}

vec3 evaluateAreaLight( AreaLight light, vec3 hitPoint, vec3 lightDir, float lightDistance ) {
    float cosTheta = dot( lightDir, cross( light.u, light.v ) );
    if( cosTheta <= 0.0 )
        return vec3( 0.0 );
    float falloff = 1.0 / ( lightDistance * lightDistance );
    return light.color * light.intensity * falloff * cosTheta;
}

bool isPointInShadow( vec3 point, vec3 normal, vec3 lightDir, inout ivec2 stats ) {
    Ray shadowRay;
    shadowRay.origin = point + normal * 0.001; // shadow bais or Offset to avoid self-intersection
    shadowRay.direction = lightDir;
    HitInfo shadowHit = traverseBVH( shadowRay, stats );
    return shadowHit.didHit;
}

bool pointInRectangle( vec3 point, vec3 center, vec3 u, vec3 v ) {
    vec3 d = point - center;
    float projU = dot( d, normalize( u ) );
    float projV = dot( d, normalize( v ) );
    return abs( projU ) <= length( u ) && abs( projV ) <= length( v );
}

vec3 calculateDirectLightingMIS( HitInfo hitInfo, vec3 V, BRDFSample brdfSample, inout uint rngState, inout ivec2 stats ) {
    vec3 totalLighting = vec3( 0.0 );
    vec3 N = hitInfo.normal;

    // Pre-compute shadow ray origin
    vec3 shadowOrigin = hitInfo.hitPoint + N * 0.001;

    // Directional lights
    for( int i = 0; i < MAX_DIRECTIONAL_LIGHTS / 7; i ++ ) {
        DirectionalLight light = getDirectionalLight( i );

        if( light.intensity <= 0.0 )
            continue;

        vec3 L = normalize( light.direction );
        float NoL = dot( N, L );

        // check if light coming from behind
        if( NoL <= 0.0 )
            continue;

        // Check for shadows
        if( isPointInShadow( shadowOrigin, N, L, stats ) )
            continue;

        // Light contribution
        vec3 lightContribution = light.color * light.intensity;
        vec3 brdfValueForLight = evaluateBRDF( V, L, N, hitInfo.material );

        // MIS weights
        float lightPdf = 1.0; // Directional light has uniform PDF
        float misWeightLight = powerHeuristic( lightPdf, brdfSample.pdf );
        float misWeightBRDF = powerHeuristic( brdfSample.pdf, lightPdf );

        // Combine contributions
        totalLighting += lightContribution * brdfValueForLight * NoL * misWeightLight;

        // Add BRDF sampling contribution
        // Check if the BRDF sample direction hits the light
        float alignment = dot( brdfSample.direction, L );
        if( alignment > 0.99 && brdfSample.pdf > 0.0 ) {
            totalLighting += lightContribution * brdfSample.value * NoL * misWeightBRDF / max( brdfSample.pdf, 0.001 );
        }
    }

    #if MAX_AREA_LIGHTS > 0
    for( int i = 0; i < MAX_AREA_LIGHTS / 13; i ++ ) {
        AreaLight light = getAreaLight( i );
        // return normalize(light.color);

        if( light.intensity <= 0.0 )
            continue;

        vec3 lightPos;
        float lightPdf;
        vec2 xi = getRandomSample( gl_FragCoord.xy, i, 0, rngState, 6 );
        vec3 L = sampleAreaLight( light, xi, lightPos, lightPdf );

        float NoL = dot( N, L );
        if( NoL <= 0.0 )
            continue;

        if( isPointInShadow( shadowOrigin, N, L, stats ) )
            continue;

        float lightDistance = length( lightPos - hitInfo.hitPoint );
        vec3 lightContribution = evaluateAreaLight( light, hitInfo.hitPoint, L, lightDistance );

        // MIS weights
        float misWeightLight = powerHeuristic( lightPdf, brdfSample.pdf );
        float misWeightBRDF = powerHeuristic( brdfSample.pdf, lightPdf );

        // Light sampling contribution
        totalLighting += lightContribution * evaluateBRDF( V, L, N, hitInfo.material ) * NoL * misWeightLight / max( lightPdf, 0.001 );

        // BRDF sampling contribution
        vec3 hitPointOnLight = hitInfo.hitPoint + brdfSample.direction * lightDistance;
        if( pointInRectangle( hitPointOnLight, light.position, light.u, light.v ) ) {
            vec3 brdfLightContribution = evaluateAreaLight( light, hitInfo.hitPoint, sampleDir, lightDistance );
            totalLighting += brdfLightContribution * brdfSample.value * NoL * misWeightBRDF / max( brdfSample.pdf, 0.001 );
        }
    }
    #endif

    return totalLighting;
}

struct IndirectLightingResult {
    vec3 direction;
    vec3 throughput;
};

IndirectLightingResult calculateIndirectLightingMIS( vec3 V, vec3 N, RayTracingMaterial material, BRDFSample brdfSample, int sampleIndex, int bounceIndex, inout uint rngState ) {
    // Sample cosine-weighted direction
    vec2 indirectSample = getRandomSample( gl_FragCoord.xy, sampleIndex, bounceIndex + 1, rngState, - 1 );

    // Choose sampling strategy based on material properties
    float materialImportance = getMaterialImportance( material );
    vec3 sampleDir;
    float samplePdf;
    vec3 sampleBrdf;

    if( RandomValue( rngState ) < materialImportance ) {
        // Use BRDF sampling
        sampleDir = brdfSample.direction;
        samplePdf = brdfSample.pdf;
        sampleBrdf = brdfSample.value;
    } else {
        // Use cosine sampling
        sampleDir = cosineWeightedSample( N, indirectSample );
        samplePdf = cosineWeightedPDF( max( dot( N, sampleDir ), 0.0 ) );
        sampleBrdf = evaluateBRDF( V, sampleDir, N, material );
    }

    // Ensure PDFs are never zero
    samplePdf = max( samplePdf, 0.001 );
    float brdfPDF = max( brdfSample.pdf, 0.001 );

    // Calculate MIS weights
    float misWeight = powerHeuristic( samplePdf, brdfPDF );

    // Calculate final contribution
    float NoL = max( dot( N, sampleDir ), 0.0 );
    vec3 throughput = sampleBrdf * NoL * misWeight * globalIlluminationIntensity / max( samplePdf, 0.001 );

    IndirectLightingResult result;
    result.direction = sampleDir;
    result.throughput = clamp( throughput, vec3( 0.0 ), vec3( 1.0 ) );
    return result;
}