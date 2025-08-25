


struct BVHNode {
	vec3 boundsMin;
	int leftChild;
	vec3 boundsMax;
	int rightChild;
	ivec2 triOffset;
	vec2 padding;
};


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


bool isTriangleVisible( int triangleIndex, vec3 rayDirection ) {
    // Fetch only the essential visibility data (1 texture read vs full material)
	vec4 visData = getDatafromDataTexture( materialTexture, materialTexSize, triangleIndex, 4, MATERIAL_SLOTS );
	return bool( visData.g ); // visible flag
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
	vec4 visibilityData = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 4, MATERIAL_SLOTS );

	if( ! bool( visibilityData.g ) )
		return false;

	// Check side visibility
	float rayDotNormal = dot( rayDirection, normal );
	vec4 sideData = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 10, MATERIAL_SLOTS );
	int side = int( sideData.g );

	return ( side == 2 || // DoubleSide - most common case first
		( side == 0 && rayDotNormal < - 0.0001 ) || // FrontSide
		( side == 1 && rayDotNormal > 0.0001 )     // BackSide
	);
}

// Modified traverseBVH function
HitInfo traverseBVH( Ray ray, inout ivec2 stats, bool shadowRay ) {
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
					if( shadowRay ) {
						// For shadow rays, only check basic visibility
						if( isTriangleVisible( tri.materialIndex, rayDirection ) ) {
							closestHit = hit;
							closestHit.materialIndex = tri.materialIndex;
							// Early exit for shadow rays - any hit is sufficient
							// return closestHit;
						}
					} else {
						// For primary rays, do full material check
						if( isMaterialVisible( tri.materialIndex, rayDirection, hit.normal ) ) {
							closestHit = hit;
							closestHit.materialIndex = tri.materialIndex;
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

		// Internal node - optimized child processing with bounds-only reads
		int leftChild = node.leftChild;
		int rightChild = node.rightChild;

		// Optimized: Read only bounds data (2 texture reads instead of 6)
		vec4 leftData0 = getDatafromDataTexture( bvhTexture, bvhTexSize, leftChild, 0, 3 );
		vec4 leftData1 = getDatafromDataTexture( bvhTexture, bvhTexSize, leftChild, 1, 3 );
		vec4 rightData0 = getDatafromDataTexture( bvhTexture, bvhTexSize, rightChild, 0, 3 );
		vec4 rightData1 = getDatafromDataTexture( bvhTexture, bvhTexSize, rightChild, 1, 3 );

		vec3 childA_boundsMin = leftData0.xyz;
		vec3 childA_boundsMax = leftData1.xyz;
		vec3 childB_boundsMin = rightData0.xyz;
		vec3 childB_boundsMax = rightData1.xyz;

		// Vectorized distance computation
		float dstA = fastRayAABBDst( ray, invDir, childA_boundsMin, childA_boundsMax );
		float dstB = fastRayAABBDst( ray, invDir, childB_boundsMin, childB_boundsMax );

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

	// Check if DOF is disabled or conditions make it ineffective
	if( !enableDOF || focalLength <= 0.0 || aperture >= 64.0 || focusDistance <= 0.001 ) {
		return Ray( rayOriginWorld, rayDirectionWorld );
	}

    // Calculate focal point - where rays converge
	vec3 focalPoint = rayOriginWorld + rayDirectionWorld * focusDistance;

    // Physical aperture calculation
	float effectiveAperture = focalLength / aperture;
	float apertureRadius = ( effectiveAperture * 0.001 ) * apertureScale;

	// Generate random point on aperture disk
	vec2 randomPoint = RandomPointInCircle( rngState );

    // Extract camera coordinate system directly from camera matrix
    // This is guaranteed to be consistent with the camera's actual orientation
	vec3 cameraRight = normalize( vec3( cameraWorldMatrix[ 0 ] ) );
	vec3 cameraUp = normalize( vec3( cameraWorldMatrix[ 1 ] ) );
    // Note: cameraForward would be -normalize( vec3( cameraWorldMatrix[2] ) ) but we don't need it

    // Apply aperture offset using camera's actual coordinate system
	vec3 offset = ( cameraRight * randomPoint.x + cameraUp * randomPoint.y ) * apertureRadius;

	// Calculate new ray from offset origin to focal point
	vec3 newOrigin = rayOriginWorld + offset;
	vec3 newDirection = normalize( focalPoint - newOrigin );

	return Ray( newOrigin, newDirection );
}