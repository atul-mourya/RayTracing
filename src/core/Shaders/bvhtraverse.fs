uniform sampler2D triangleTexture;
uniform sampler2D materialTexture;
uniform sampler2D bvhTexture;

uniform ivec2 triangleTexSize;
uniform ivec2 materialTexSize;
uniform ivec2 bvhTexSize;

struct BVHNode {
	vec4 boundsMinAndLeft;   // xyz = boundsMin, w = leftChild
	vec4 boundsMaxAndRight;  // xyz = boundsMax, w = rightChild
	vec2 triOffset;         // x = offset, y = count
};

vec4 getDatafromDataTexture( sampler2D tex, ivec2 texSize, int stride, int sampleIndex, int dataOffset ) {
	int pixelIndex = stride * dataOffset + sampleIndex;
	int x = pixelIndex % texSize.x;
	int y = pixelIndex / texSize.x;
	return texelFetch( tex, ivec2( x, y ), 0 );
}

BVHNode getBVHNode( int index ) {
	vec4 data1 = getDatafromDataTexture( bvhTexture, bvhTexSize, index, 0, 3 );
	vec4 data2 = getDatafromDataTexture( bvhTexture, bvhTexSize, index, 1, 3 );
	vec4 data3 = getDatafromDataTexture( bvhTexture, bvhTexSize, index, 2, 3 );

	BVHNode node;
	node.boundsMinAndLeft = data1;
	node.boundsMaxAndRight = data2;
	node.triOffset = data3.xy;
	return node;
}

mat3 arrayToMat3( vec4 data1, vec4 data2 ) {
	return mat3( data1.x, data1.y, data1.z, data1.w, data2.x, data2.y, data2.z, data2.w, 1.0 );
}

RayTracingMaterial getMaterial( int materialIndex ) {

	vec4 data1 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 0, 18 );
	vec4 data2 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 1, 18 );
	vec4 data3 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 2, 18 );
	vec4 data4 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 3, 18 );
	vec4 data5 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 4, 18 );
	vec4 data6 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 5, 18 );
	vec4 data7 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 6, 18 );
	vec4 data8 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 7, 18 );
	vec4 data9 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 8, 18 );
	vec4 data10 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 9, 18 );
	vec4 data11 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 10, 18 );
	vec4 data12 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 11, 18 );
	vec4 data13 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 12, 18 );
	vec4 data14 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 13, 18 );
	vec4 data15 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 14, 18 );
	vec4 data16 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 15, 18 );
	vec4 data17 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 16, 18 );
	vec4 data18 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 17, 18 );

	RayTracingMaterial material;

	material.color = vec4( data1.rgb, 1.0 );
	material.metalness = data1.a;

	material.emissive = data2.rgb;
	material.roughness = data2.a;

	material.ior = data3.r;
	material.transmission = data3.g;
	material.thickness = data3.b;
	material.emissiveIntensity = data3.a;

	material.albedoMapIndex = int( data4.r );
	material.normalMapIndex = int( data4.g );
	material.roughnessMapIndex = int( data4.b );
	material.metalnessMapIndex = int( data4.a );

	material.emissiveMapIndex = int( data5.r );
	material.bumpMapIndex = int( data5.g );
	material.clearcoat = data5.b;
	material.clearcoatRoughness = data5.a;

	material.opacity = data6.r;
	material.side = int( data6.g );
	material.normalScale = vec2( data6.b, data6.a );

	material.albedoTransform = arrayToMat3( data7, data8 );
	material.emissiveTransform = arrayToMat3( data9, data10 );
	material.normalTransform = arrayToMat3( data11, data12 );
	material.bumpTransform = arrayToMat3( data13, data14 );
	material.metalnessTransform = arrayToMat3( data15, data16 );
	material.roughnessTransform = arrayToMat3( data17, data18 );

	return material;
}

Triangle getTriangle( int triangleIndex ) {
	Triangle tri;

	// Read 8 vec4s for each triangle
	vec4 v0 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 0, 8 );
	vec4 v1 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 1, 8 );
	vec4 v2 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 2, 8 );
	vec4 v3 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 3, 8 );
	vec4 v4 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 4, 8 );
	vec4 v5 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 5, 8 );
	vec4 v6 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 6, 8 );
	vec4 v7 = getDatafromDataTexture( triangleTexture, triangleTexSize, triangleIndex, 7, 8 );

	// Positions
	tri.posA = v0.xyz;
	tri.posB = v1.xyz;
	tri.posC = v2.xyz;

	// Normals
	tri.normalA = v3.xyz;
	tri.normalB = v4.xyz;
	tri.normalC = v5.xyz;

	// UVs
	tri.uvA = v6.xy;
	tri.uvB = v6.zw;
	tri.uvC = v7.xy;

	// Material index
	tri.materialIndex = int( v7.z );

	return tri;
}

// Optimized AABB intersection test
float fastAABBIntersection( Ray ray, vec3 invDir, vec3 boxMin, vec3 boxMax ) {
	vec3 t0 = ( boxMin - ray.origin ) * invDir;
	vec3 t1 = ( boxMax - ray.origin ) * invDir;
	vec3 tmin = min( t0, t1 );
	vec3 tmax = max( t0, t1 );
	float dstNear = max( max( tmin.x, tmin.y ), tmin.z );
	float dstFar = min( min( tmax.x, tmax.y ), tmax.z );
	return dstNear <= dstFar && dstFar > 0.0 ? dstNear : 1e20;
}

HitInfo traverseBVH( Ray ray, inout ivec2 stats ) {
	HitInfo closestHit;
	closestHit.didHit = false;
	closestHit.dst = 1e20;

    // Pre-compute ray inverse direction for faster AABB tests
	vec3 invDir = 1.0 / ray.direction;
	vec3 raySign = step( vec3( 0.0 ), ray.direction );

    // Stack-based traversal with fixed size
	const int MAX_STACK = 32;
	struct StackEntry {
		int nodeIndex;
		float minDist;
	};
	StackEntry stack[ MAX_STACK ];
	int stackSize = 0;

    // Push root node
	stack[ stackSize ++ ] = StackEntry( 0, 0.0 );

	while( stackSize > 0 ) {
        // Pop nearest node
		StackEntry current = stack[ -- stackSize ];

        // Early termination if we can't find a closer hit
		if( current.minDist >= closestHit.dst ) {
			continue;
		}

		BVHNode node = getBVHNode( current.nodeIndex );
		stats[ 0 ] ++;

		if( node.boundsMinAndLeft.w < 0.0 ) { // Leaf node
			int triCount = int( node.triOffset.y );
			int triOffset = int( node.triOffset.x );

            // Process triangles in chunks for better memory coherency
			const int TRIANGLE_CHUNK_SIZE = 4;
			for( int i = 0; i < triCount; i += TRIANGLE_CHUNK_SIZE ) {
				int chunkSize = min( TRIANGLE_CHUNK_SIZE, triCount - i );

                // Pre-fetch triangles
				Triangle tris[ TRIANGLE_CHUNK_SIZE ];
				for( int j = 0; j < chunkSize; j ++ ) {
					tris[ j ] = getTriangle( triOffset + i + j );
				}

                // Process triangle chunk
				for( int j = 0; j < chunkSize; j ++ ) {
					stats[ 1 ] ++;
					Triangle tri = tris[ j ];
					HitInfo hit = RayTriangle( ray, tri );

					if( hit.didHit && hit.dst < closestHit.dst ) {
                        // Defer material fetching until we know we have a hit
						hit.material = getMaterial( tri.materialIndex );

                        // Optimized side checking
						float rayDotNormal = dot( ray.direction, hit.normal );
						bool isValidHit = ( hit.material.side == 2 ) ||
							( hit.material.side == 0 && rayDotNormal < - 0.0001 ) ||
							( hit.material.side == 1 && rayDotNormal > 0.0001 );

						if( isValidHit ) {
							closestHit = hit;
						}
					}
				}
			}
		} else {
            // Faster AABB intersection using pre-computed inverse direction
			float dstA = fastAABBIntersection( ray, invDir, node.boundsMinAndLeft.xyz, node.boundsMaxAndRight.xyz );
			float dstB = fastAABBIntersection( ray, invDir, getBVHNode( int( node.boundsMaxAndRight.w ) ).boundsMinAndLeft.xyz, getBVHNode( int( node.boundsMaxAndRight.w ) ).boundsMaxAndRight.xyz );

            // Sort children by distance
			int nearChild = dstA < dstB ? int( node.boundsMinAndLeft.w ) : int( node.boundsMaxAndRight.w );
			int farChild = dstA < dstB ? int( node.boundsMaxAndRight.w ) : int( node.boundsMinAndLeft.w );
			float nearDist = min( dstA, dstB );
			float farDist = max( dstA, dstB );

            // Push children in order (far then near)
			if( farDist < closestHit.dst ) {
				stack[ stackSize ++ ] = StackEntry( farChild, farDist );
			}
			if( nearDist < closestHit.dst ) {
				stack[ stackSize ++ ] = StackEntry( nearChild, nearDist );
			}
		}
	}

	return closestHit;
}
