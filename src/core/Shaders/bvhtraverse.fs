uniform sampler2D triangleTexture;
uniform sampler2D materialTexture;
uniform sampler2D bvhTexture;

uniform ivec2 triangleTexSize;
uniform ivec2 materialTexSize;
uniform ivec2 bvhTexSize;

struct BVHNode {
	vec3 boundsMin;
	int leftChild;
	vec3 boundsMax;
	int rightChild;
	ivec2 triOffset;
	vec2 padding;
};

vec4 getDatafromDataTexture( sampler2D tex, ivec2 texSize, int stride, int sampleIndex, int dataOffset ) {
	int pixelIndex = stride * dataOffset + sampleIndex;
	return texelFetch( tex, ivec2( pixelIndex % texSize.x, pixelIndex / texSize.x ), 0 );
}

BVHNode getBVHNode( int index ) {
	vec4 data[ 3 ];
	for( int i = 0; i < 3; i ++ ) {
		data[ i ] = getDatafromDataTexture( bvhTexture, bvhTexSize, index, i, 3 );
	}

	BVHNode node;
	node.boundsMin = data[ 0 ].xyz;
	node.leftChild = int( data[ 0 ].w );
	node.boundsMax = data[ 1 ].xyz;
	node.rightChild = int( data[ 1 ].w );
	node.triOffset = ivec2( data[ 2 ].xy );
	node.padding = vec2( 0.0 );
	return node;
}

mat3 arrayToMat3( vec4 data1, vec4 data2 ) {
	return mat3( data1.xyz, vec3( data1.w, data2.xy ), vec3( data2.zw, 1.0 ) );
}

RayTracingMaterial getMaterial( int materialIndex ) {
	RayTracingMaterial material;

	vec4 data[ 24 ];
	for( int i = 0; i < 24; i ++ ) {
		data[ i ] = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, i, 24 );
	}

	material.color = vec4( data[ 0 ].rgb, 1.0 );
	material.metalness = data[ 0 ].a;
	material.emissive = data[ 1 ].rgb;
	material.roughness = data[ 1 ].a;
	material.ior = data[ 2 ].r;
	material.transmission = data[ 2 ].g;
	material.thickness = data[ 2 ].b;
	material.emissiveIntensity = data[ 2 ].a;

	material.attenuationColor = data[ 3 ].rgb;
	material.attenuationDistance = data[ 3 ].a;

	material.dispersion = data[ 4 ].r;
	material.visible = bool( data[ 4 ].g );
	material.sheen = data[ 4 ].b;
	material.sheenRoughness = data[ 4 ].a;

	material.sheenColor = data[ 5 ].rgb;
	material.bumpScale = data[ 5 ].a;

	material.specularIntensity = data[ 6 ].r;
	material.specularColor = data[ 6 ].gba;

	material.iridescence = data[ 7 ].r;
	material.iridescenceIOR = data[ 7 ].g;
	material.iridescenceThicknessRange = data[ 7 ].ba;

	material.albedoMapIndex = int( data[ 8 ].r );
	material.normalMapIndex = int( data[ 8 ].g );
	material.roughnessMapIndex = int( data[ 8 ].b );
	material.metalnessMapIndex = int( data[ 8 ].a );

	material.emissiveMapIndex = int( data[ 9 ].r );
	material.bumpMapIndex = int( data[ 9 ].g );
	material.clearcoat = data[ 9 ].b;
	material.clearcoatRoughness = data[ 9 ].a;

	material.opacity = data[ 10 ].r;
	material.side = int( data[ 10 ].g );
	material.transparent = bool( data[ 10 ].b );
	material.alphaTest = data[ 10 ].a;

	material.alphaMode = int( data[ 11 ].r );
	material.depthWrite = int( data[ 11 ].g );
	material.normalScale = data[ 11 ].ba;

	material.albedoTransform = arrayToMat3( data[ 12 ], data[ 13 ] );
	material.normalTransform = arrayToMat3( data[ 14 ], data[ 15 ] );
	material.roughnessTransform = arrayToMat3( data[ 16 ], data[ 17 ] );
	material.metalnessTransform = arrayToMat3( data[ 18 ], data[ 19 ] );
	material.emissiveTransform = arrayToMat3( data[ 20 ], data[ 21 ] );
	material.bumpTransform = arrayToMat3( data[ 22 ], data[ 23 ] );

	return material;
}

Triangle getTriangle( int triangleIndex ) {
	vec4 data[ 8 ];
	for( int i = 0; i < 8; i ++ ) {
		data[ i ] = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, i, 8 );
	}

	Triangle tri;
	tri.posA = data[ 0 ].xyz;
	tri.posB = data[ 1 ].xyz;
	tri.posC = data[ 2 ].xyz;
	tri.normalA = data[ 3 ].xyz;
	tri.normalB = data[ 4 ].xyz;
	tri.normalC = data[ 5 ].xyz;
	tri.uvA = data[ 6 ].xy;
	tri.uvB = data[ 6 ].zw;
	tri.uvC = data[ 7 ].xy;
	tri.materialIndex = int( data[ 7 ].z );
	tri.padding = 0.0;
	return tri;
}

bool isMaterialVisible( int materialIndex, vec3 rayDirection, vec3 normal ) {
	// Only fetch the data we need for visibility check
	vec4 visibilityData = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 4, 24 );

	if( ! bool( visibilityData.g ) )
		return false;

	// Check side visibility
	float rayDotNormal = dot( rayDirection, normal );
	vec4 sideData = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 10, 24 );
	int side = int( sideData.g );

	return ( side == 2 || // DoubleSide - most common case first
		( side == 0 && rayDotNormal < - 0.0001 ) || // FrontSide
		( side == 1 && rayDotNormal > 0.0001 )     // BackSide
	);
}

// Modified traverseBVH function
HitInfo traverseBVH( Ray ray, inout ivec2 stats ) {
	HitInfo closestHit;
	closestHit.didHit = false;
	closestHit.dst = 1e20;
	closestHit.materialIndex = - 1; // Initialize material index

	// Reduced stack size - most scenes don't need 32 levels
	int stack[ 24 ];
	int stackPtr = 0;
	stack[ stackPtr ++ ] = 0; // Root node

	// FIXED: Compact axis-aligned ray handling
	const float HUGE_VAL = 1e8;
	vec3 invDir = mix( 1.0 / ray.direction,                    // Normal case
	HUGE_VAL * sign( ray.direction + 1e-10 ), // Axis-aligned case (add tiny value to avoid sign(0))
	lessThan( abs( ray.direction ), vec3( 1e-8 ) ) );

	// Cache ray properties to reduce redundant calculations
	vec3 rayOrigin = ray.origin;
	vec3 rayDirection = ray.direction;

	while( stackPtr > 0 ) {
		int nodeIndex = stack[ -- stackPtr ];
		BVHNode node = getBVHNode( nodeIndex );
		stats[ 0 ] ++;

		if( node.leftChild < 0 ) { // Leaf node
			int triCount = node.triOffset.y;
			int triStart = node.triOffset.x;

			// Process triangles in leaf
			for( int i = 0; i < triCount; i ++ ) {
				stats[ 1 ] ++;
				Triangle tri = getTriangle( triStart + i );

				HitInfo hit = RayTriangle( ray, tri );

				if( hit.didHit && hit.dst < closestHit.dst ) {
					// Check visibility without loading full material
					if( isMaterialVisible( tri.materialIndex, rayDirection, hit.normal ) ) {
						closestHit = hit;
						closestHit.materialIndex = tri.materialIndex; // Store material index

						// Early termination for very close hits
						if( hit.dst < 0.001 ) {
							break; // Exit the triangle loop
						}
					}
				}
			}

			// If we found a very close hit, we can terminate early
			if( closestHit.didHit && closestHit.dst < 0.001 ) {
				break; // Exit the main traversal loop
			}

			continue;
		}

		// Internal node - optimized child processing
		int leftChild = node.leftChild;
		int rightChild = node.rightChild;

		BVHNode childA = getBVHNode( leftChild );
		BVHNode childB = getBVHNode( rightChild );

		// Vectorized distance computation with single AABB function call
		float dstA = fastRayAABBDst( ray, invDir, childA.boundsMin, childA.boundsMax );
		float dstB = fastRayAABBDst( ray, invDir, childB.boundsMin, childB.boundsMax );

		// Optimized early rejection
		float minDst = min( dstA, dstB );
		if( minDst >= closestHit.dst )
			continue;

		// Improved node ordering with fewer conditionals
		bool aCloser = dstA < dstB;
		int nearChild = aCloser ? leftChild : rightChild;
		int farChild = aCloser ? rightChild : leftChild;
		float nearDst = aCloser ? dstA : dstB;
		float farDst = aCloser ? dstB : dstA;

		// Push far child first (processed last)
		if( farDst < closestHit.dst ) {
			stack[ stackPtr ++ ] = farChild;
		}

		// Push near child second (processed first)  
		if( nearDst < closestHit.dst ) {
			stack[ stackPtr ++ ] = nearChild;
		}
	}

	// Load full material data only for the closest hit
	if( closestHit.didHit && closestHit.materialIndex >= 0 ) {
		closestHit.material = getMaterial( closestHit.materialIndex );
	}

	return closestHit;
}

Ray generateRayFromCamera( vec2 screenPosition, inout uint rngState ) {
    // Convert screen position to NDC (Normalized Device Coordinates)
	vec3 ndcPos = vec3( screenPosition.xy, 1.0 );

	// Convert NDC to camera space
	vec4 rayDirCS = cameraProjectionMatrixInverse * vec4( ndcPos, 1.0 );

	// Convert to world space
	vec3 rayDirectionWorld = normalize( mat3( cameraWorldMatrix ) * ( rayDirCS.xyz / rayDirCS.w ) );
	vec3 rayOriginWorld = vec3( cameraWorldMatrix[ 3 ] );

	// Disable depth of field if aperture is very small (pinhole) or focal length is 0
	if( aperture >= 16.0 || focalLength <= 0.0 || focusDistance <= 0.001 ) {
		return Ray( rayOriginWorld, rayDirectionWorld );
	}

    // Calculate focal point - where rays converge
	vec3 focalPoint = rayOriginWorld + rayDirectionWorld * focusDistance;

	// Calculate aperture radius using proper photographic formula
	// Convert focal length from mm to scene units and calculate circle of confusion
	float focalLengthMeters = focalLength * 0.001; // Convert mm to meters
	float apertureRadius = ( focalLengthMeters * apertureScale ) / aperture;

	// Scale by scene scale to maintain proper proportions
	// apertureRadius *= 0.1; // Adjust this factor based on your scene scale

	// Generate random point on aperture disk
	vec2 randomPoint = RandomPointInCircle( rngState );

	// Create camera coordinate system
	vec3 forward = normalize( rayDirectionWorld );
	vec3 right = normalize( cross( forward, vec3( 0.0, 1.0, 0.0 ) ) );
	vec3 up = normalize( cross( right, forward ) );

	// Apply aperture offset
	vec3 offset = ( right * randomPoint.x + up * randomPoint.y ) * apertureRadius;

	// Calculate new ray from offset origin to focal point
	vec3 newOrigin = rayOriginWorld + offset;
	vec3 newDirection = normalize( focalPoint - newOrigin );

	return Ray( newOrigin, newDirection );
}