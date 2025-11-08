/**
 * Preetham Sky Model - Physically-Based Atmospheric Scattering
 *
 * Based on Three.js Sky implementation (Preetham et al. model)
 * Adapted for equirectangular texture generation
 */

#ifndef PI
#define PI 3.141592653589793238462643383279502884197169
#endif

#ifndef TWO_PI
#define TWO_PI 6.283185307179586476925286766559
#endif

// ===== UNIFORMS =====

uniform vec3 sunDirection;
uniform float sunIntensity;
uniform float rayleighDensity;  // Maps to 'rayleigh' in Three.js
uniform float mieDensity;       // Maps to 'mieCoefficient' in Three.js
uniform float mieAnisotropy;    // Maps to 'mieDirectionalG' in Three.js
uniform float turbidity;

// ===== CONSTANTS =====

const float e = 2.71828182845904523536028747135266249775724709369995957;
const float pi = 3.141592653589793238462643383279502884197169;

// Total Rayleigh scattering coefficient
const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );

// Mie scattering constants
const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

// Sun parameters
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

// Path length parameters
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

// Phase function constants
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

// Up vector (zenith direction)
const vec3 up = vec3( 0.0, 1.0, 0.0 );

// ===== HELPER FUNCTIONS =====

/**
 * Compute sun intensity based on zenith angle
 */
float computeSunIntensity( float zenithAngleCos ) {
    zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
    return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
}

/**
 * Total Mie scattering coefficient based on turbidity
 */
vec3 totalMie( float T ) {
    float c = ( 0.2 * T ) * 10E-18;
    return 0.434 * c * MieConst;
}

/**
 * Rayleigh phase function
 */
float rayleighPhase( float cosTheta ) {
    return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
}

/**
 * Henyey-Greenstein phase function for Mie scattering
 */
float hgPhase( float cosTheta, float g ) {
    float g2 = pow( g, 2.0 );
    float inverse = 1.0 / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 );
    return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
}

/**
 * Main sky color computation - Preetham model
 */
vec3 computePrethamSkyColor(vec2 uv) {
    // Convert UV to direction (equirectangular mapping)
    // theta: polar angle from north pole (0 to PI)
    // phi: azimuthal angle around equator (-PI to PI)
    float theta = (1.0 - uv.y) * PI;  // 0 to PI (top = north pole, bottom = south pole)
    float phi = (uv.x - 0.5) * TWO_PI;  // -PI to PI (left to right)

    // Spherical to cartesian conversion for equirectangular mapping
    vec3 direction = normalize(vec3(
        sin(theta) * sin(phi),
        cos(theta),
        sin(theta) * cos(phi)
    ));

    // Normalize sun direction
    vec3 vSunDirection = normalize(sunDirection);

    // Compute sun intensity based on sun elevation
    float vSunE = computeSunIntensity( dot( vSunDirection, up ) ) * sunIntensity;

    // Sun fade effect (fade when sun is below horizon)
    float vSunfade = 1.0 - clamp( 1.0 - exp( ( sunDirection.y / 450000.0 ) ), 0.0, 1.0 );

    // Adjust Rayleigh coefficient based on sun position
    float rayleighCoefficient = rayleighDensity - ( 1.0 * ( 1.0 - vSunfade ) );

    // Compute scattering coefficients
    vec3 vBetaR = totalRayleigh * rayleighCoefficient;
    vec3 vBetaM = totalMie( turbidity ) * mieDensity;

    // === Fragment shader computations ===

    // Zenith angle for this direction
    float zenithAngle = acos( max( 0.0, dot( up, direction ) ) );

    // Optical path length (air mass)
    float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
    float sR = rayleighZenithLength * inverse;
    float sM = mieZenithLength * inverse;

    // Extinction (Beer's law)
    vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

    // Scattering angle
    float cosTheta = dot( direction, vSunDirection );

    // Rayleigh scattering
    float rPhase = rayleighPhase( cosTheta * 0.5 + 0.5 );
    vec3 betaRTheta = vBetaR * rPhase;

    // Mie scattering
    float mPhase = hgPhase( cosTheta, mieAnisotropy );
    vec3 betaMTheta = vBetaM * mPhase;

    // Inscattered light
    vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
    Lin *= mix(
        vec3( 1.0 ),
        pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ),
        clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 1.0 )
    );

    // Base luminance
    vec3 L0 = vec3( 0.1 ) * Fex;

    // Add sun disk
    // Using cosTheta (3D angular distance) ensures circular appearance when sampled in 3D
    // Note: In equirectangular texture space, the sun may appear distorted near poles,
    // but it will appear circular when the path tracer samples it correctly in 3D
    float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );
    L0 += ( vSunE * 19000.0 * Fex ) * sundisk;

    // Combine inscattered light and direct light
    // This matches Three.js Sky.js exactly
    vec3 texColor = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );

    // Tone mapping with sun fade (matches Three.js)
    // vec3 retColor = pow( texColor, vec3( 1.0 / ( 1.2 + ( 1.2 * vSunfade ) ) ) );

    return texColor;
}
