// =============================================================================
// EMISSIVE TRIANGLE SAMPLING
// =============================================================================
// This file contains direct lighting from emissive triangles (next-event estimation)
// Samples emissive geometry to reduce noise in scenes with emissive surfaces

// -----------------------------------------------------------------------------
// Emissive Triangle Sampling Structures
// -----------------------------------------------------------------------------

uniform sampler2D emissiveTriangleTexture;
uniform ivec2 emissiveTriangleTexSize;
uniform int emissiveTriangleCount;
uniform float emissiveBoost;

struct EmissiveSample {
	vec3 position;       // Sample point on emissive triangle
	vec3 normal;         // Normal at sample point
	vec3 emission;       // Emissive color * intensity
	vec3 direction;      // Direction from hit point to sample
	float distance;      // Distance to emissive surface
	float pdf;           // Probability density
	float area;          // Triangle area
	float cosThetaLight; // Cosine of angle on light surface
	bool valid;          // Whether sample is valid
};

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

// Sample a point on a triangle using barycentric coordinates
vec3 sampleTriangle( vec3 v0, vec3 v1, vec3 v2, vec2 xi ) {
	float sqrtU = sqrt( xi.x );
	float u = 1.0 - sqrtU;
	float v = xi.y * sqrtU;
	float w = 1.0 - u - v;
	return u * v0 + v * v1 + w * v2;
}

// Calculate triangle area
float triangleArea( vec3 v0, vec3 v1, vec3 v2 ) {
	vec3 edge1 = v1 - v0;
	vec3 edge2 = v2 - v0;
	return length( cross( edge1, edge2 ) ) * 0.5;
}

// Interpolate triangle normals using barycentric coordinates
vec3 interpolateNormal( vec3 n0, vec3 n1, vec3 n2, vec2 xi ) {
	float sqrtU = sqrt( xi.x );
	float u = 1.0 - sqrtU;
	float v = xi.y * sqrtU;
	float w = 1.0 - u - v;
	return normalize( u * n0 + v * n1 + w * n2 );
}

// Check if a material is emissive
bool isEmissive( RayTracingMaterial material ) {
	return material.emissiveIntensity > 0.0 && length( material.emissive ) > 0.0;
}

// Calculate emissive power of a triangle
float calculateEmissivePower( RayTracingMaterial material, float area ) {
	if( ! isEmissive( material ) )
		return 0.0;

	// Power = emissive radiance * area
	float avgEmissive = ( material.emissive.r + material.emissive.g + material.emissive.b ) / 3.0;
	return avgEmissive * material.emissiveIntensity * area;
}

// -----------------------------------------------------------------------------
// Triangle Data Access
// -----------------------------------------------------------------------------

// Fetch triangle vertices from texture
void fetchTriangleData(
	int triangleIndex,
	out vec3 v0, out vec3 v1, out vec3 v2,
	out vec3 n0, out vec3 n1, out vec3 n2,
	out int materialIndex
) {
	// Each triangle takes 8 vec4s (32 floats)
	int baseOffset = triangleIndex * 8;

	// Positions
	vec4 pos0 = texelFetch( triangleTexture, ivec2( baseOffset % triangleTexSize.x, baseOffset / triangleTexSize.x ), 0 );
	vec4 pos1 = texelFetch( triangleTexture, ivec2( ( baseOffset + 1 ) % triangleTexSize.x, ( baseOffset + 1 ) / triangleTexSize.x ), 0 );
	vec4 pos2 = texelFetch( triangleTexture, ivec2( ( baseOffset + 2 ) % triangleTexSize.x, ( baseOffset + 2 ) / triangleTexSize.x ), 0 );

	v0 = pos0.xyz;
	v1 = pos1.xyz;
	v2 = pos2.xyz;

	// Normals
	vec4 norm0 = texelFetch( triangleTexture, ivec2( ( baseOffset + 3 ) % triangleTexSize.x, ( baseOffset + 3 ) / triangleTexSize.x ), 0 );
	vec4 norm1 = texelFetch( triangleTexture, ivec2( ( baseOffset + 4 ) % triangleTexSize.x, ( baseOffset + 4 ) / triangleTexSize.x ), 0 );
	vec4 norm2 = texelFetch( triangleTexture, ivec2( ( baseOffset + 5 ) % triangleTexSize.x, ( baseOffset + 5 ) / triangleTexSize.x ), 0 );

	n0 = norm0.xyz;
	n1 = norm1.xyz;
	n2 = norm2.xyz;

	// Material index (stored in last vec4)
	vec4 uvMat = texelFetch( triangleTexture, ivec2( ( baseOffset + 7 ) % triangleTexSize.x, ( baseOffset + 7 ) / triangleTexSize.x ), 0 );
	materialIndex = int( uvMat.z );
}

// -----------------------------------------------------------------------------
// Emissive Triangle Sampling (Simple Uniform Sampling)
// -----------------------------------------------------------------------------

// Sample from emissive triangle index (100% success rate!)
// Uses pre-built list of emissive triangles for direct sampling
EmissiveSample sampleEmissiveTriangle(
	vec3 hitPoint,
	vec3 surfaceNormal,
	int totalTriangleCount,
	inout uint rngState
) {
	EmissiveSample result;
	result.valid = false;
	result.pdf = 0.0;

	// Check if we have emissive triangles
	if( emissiveTriangleCount <= 0 )
		return result;

	// Select random emissive triangle from the index
	float randEmissive = RandomValue( rngState );
	int emissiveIndex = int( randEmissive * float( emissiveTriangleCount ) );
	emissiveIndex = clamp( emissiveIndex, 0, emissiveTriangleCount - 1 );

	// Fetch emissive triangle data from texture
	// Texture layout: R=triangleIndex, G=power, B=cdf, A=unused
	ivec2 texCoord = ivec2(
		emissiveIndex % emissiveTriangleTexSize.x,
		emissiveIndex / emissiveTriangleTexSize.x
	);
	vec4 emissiveData = texelFetch( emissiveTriangleTexture, texCoord, 0 );
	int triangleIndex = int( emissiveData.r );
	float emissivePower = emissiveData.g;

	// Fetch triangle geometry
	vec3 v0, v1, v2, n0, n1, n2;
	int matIndex;
	fetchTriangleData( triangleIndex, v0, v1, v2, n0, n1, n2, matIndex );

	// Get material
	RayTracingMaterial material = getMaterial( matIndex );

	// Sample point on triangle
	vec2 xi = vec2( RandomValue( rngState ), RandomValue( rngState ) );
	vec3 samplePos = sampleTriangle( v0, v1, v2, xi );
	vec3 sampleNormal = interpolateNormal( n0, n1, n2, xi );

	// Direction from surface to emissive triangle
	vec3 toEmissive = samplePos - hitPoint;
	float distSq = dot( toEmissive, toEmissive );
	float dist = sqrt( distSq );
	vec3 dir = toEmissive / dist;

	// Check if facing the surface
	float surfaceFacing = dot( dir, surfaceNormal );
	float emissiveFacing = dot( dir, -sampleNormal );

	if( surfaceFacing <= 0.0 || emissiveFacing <= 0.0 )
		return result;

	// Calculate triangle area for PDF
	float area = triangleArea( v0, v1, v2 );

	// PDF for area sampling: 1 / area (uniform over triangle surface)
	// Convert to solid angle: pdf_solid = pdf_area * (distance^2 / cos(theta_light))
	// For uniform sampling over emissive triangles: pdf_area = 1 / (emissiveTriangleCount * area)
	float pdfArea = 1.0 / ( float( emissiveTriangleCount ) * area );
	float pdfSolidAngle = pdfArea * distSq / emissiveFacing;

	// Build result
	result.position = samplePos;
	result.normal = sampleNormal;
	result.emission = material.emissive * material.emissiveIntensity;
	result.direction = dir;
	result.distance = dist;
	result.pdf = max( pdfSolidAngle, MIN_PDF );
	result.area = area;
	result.cosThetaLight = emissiveFacing;
	result.valid = true;

	return result;
}

// -----------------------------------------------------------------------------
// Emissive Triangle Direct Lighting Contribution
// -----------------------------------------------------------------------------

struct EmissiveContributionResult {
	vec3 contribution;
	bool hasEmissive;
	vec3 emissionOnly;  // For debug visualization
	float distance;     // Distance to emissive surface
};

EmissiveContributionResult calculateEmissiveTriangleContributionDebug(
	vec3 hitPoint,
	vec3 normal,
	vec3 viewDir,
	RayTracingMaterial material,
	int totalTriangleCount,
	int bounceIndex,
	inout uint rngState,
	inout ivec2 stats
) {
	EmissiveContributionResult result;
	result.contribution = vec3( 0.0 );
	result.hasEmissive = false;
	result.emissionOnly = vec3( 0.0 );
	result.distance = 0.0;
	// Skip for very rough diffuse surfaces on secondary bounces (low contribution)
	if( bounceIndex > 1 && material.roughness > 0.9 && material.metalness < 0.1 )
		return result;

	// Sample emissive triangle
	EmissiveSample emissiveSample = sampleEmissiveTriangle( hitPoint, normal, totalTriangleCount, rngState );

	if( ! emissiveSample.valid || emissiveSample.pdf <= 0.0 )
		return result;

	result.hasEmissive = true;
	result.emissionOnly = emissiveSample.emission;
	result.distance = emissiveSample.distance;

	// Check geometric validity
	float NoL = max( 0.0, dot( normal, emissiveSample.direction ) );
	if( NoL <= 0.0 )
		return result;

	// Calculate ray offset for shadow ray
	vec3 rayOffset = calculateRayOffset( hitPoint, normal, material );
	vec3 rayOrigin = hitPoint + rayOffset;

	// Trace shadow ray
	float shadowDist = emissiveSample.distance - 0.001;
	float visibility = traceShadowRay( rayOrigin, emissiveSample.direction, shadowDist, rngState, stats );

	if( visibility <= 0.0 )
		return result;

	// Evaluate BRDF
	vec3 brdfValue = evaluateMaterialResponse( viewDir, emissiveSample.direction, normal, material );

	// For emissive surfaces, we're sampling radiance (not intensity)
	// The contribution from an area light with radiance L is:
	// dL = L * BRDF * cos(θ_surface) * cos(θ_light) * (area / distance²) * visibility
	//
	// But our emissiveSample.emission is already the radiance, so:
	// contribution = emission * BRDF * cos(θ_surface) * cos(θ_light) * (area / distance²)

	float distSq = emissiveSample.distance * emissiveSample.distance;
	float solidAngleTerm = emissiveSample.area * emissiveSample.cosThetaLight / distSq;

	// Final contribution (no 4π because we're not converting from intensity)
	// Note: This bypasses firefly suppression in pathtracer_core.fs
	// Large boost needed because: BRDF (~0.1-0.3) * geometric falloff * cosine terms = very small
	// emissiveBoost is a uniform that can be adjusted via UI
	result.contribution = emissiveSample.emission * brdfValue * NoL * solidAngleTerm * visibility * emissiveBoost;

	return result;
}

// Wrapper function for backward compatibility
vec3 calculateEmissiveTriangleContribution(
	vec3 hitPoint,
	vec3 normal,
	vec3 viewDir,
	RayTracingMaterial material,
	int totalTriangleCount,
	int bounceIndex,
	inout uint rngState,
	inout ivec2 stats
) {
	EmissiveContributionResult result = calculateEmissiveTriangleContributionDebug(
		hitPoint, normal, viewDir, material, totalTriangleCount, bounceIndex, rngState, stats
	);
	return result.contribution;
}
