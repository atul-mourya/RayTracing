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
	vec2 triOffset;
	vec2 padding;
};

vec4 getDatafromDataTexture( sampler2D tex, ivec2 texSize, int stride, int sampleIndex, int dataOffset ) {
	int pixelIndex = stride * dataOffset + sampleIndex;
	int x = pixelIndex % texSize.x;
	int y = pixelIndex / texSize.x;
	return texelFetch( tex, ivec2( x, y ), 0 );
}

BVHNode getBVHNode( int index ) {

	vec4 data1 = getDatafromDataTexture( bvhTexture, bvhTexSize, index, 0, 4 );
	vec4 data2 = getDatafromDataTexture( bvhTexture, bvhTexSize, index, 1, 4 );
	vec4 data3 = getDatafromDataTexture( bvhTexture, bvhTexSize, index, 2, 4 );

	BVHNode node;
	node.boundsMin = data1.xyz;
	node.leftChild = int( data1.w );
	node.boundsMax = data2.xyz;
	node.rightChild = int( data2.w );
	node.triOffset = data3.xy;
	return node;
}

mat3 arrayToMat3( vec4 data1, vec4 data2 ) {
	return mat3(
		data1.x, data1.y, data1.z,
		data1.w, data2.x, data2.y,
		data2.z, data2.w, 1.0
	);
}

RayTracingMaterial getMaterial( int materialIndex ) {

	vec4 data1 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 0, 24 );
	vec4 data2 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 1, 24 );
	vec4 data3 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 2, 24 );
	vec4 data4 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 3, 24 );
	vec4 data5 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 4, 24 );
	vec4 data6 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 5, 24 );
	vec4 data7 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 6, 24 );
	vec4 data8 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 7, 24 );
	vec4 data9 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 8, 24 );
	vec4 data10 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 9, 24 );
	vec4 data11 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 10, 24 );
	vec4 data12 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 11, 24 );
	vec4 data13 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 12, 24 );
	vec4 data14 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 13, 24 );
	vec4 data15 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 14, 24 );
	vec4 data16 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 15, 24 );
	vec4 data17 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 16, 24 );
	vec4 data18 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 17, 24 );
	vec4 data19 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 18, 24 );
	vec4 data20 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 19, 24 );
	vec4 data21 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 20, 24 );
	vec4 data22 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 21, 24 );
	vec4 data23 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 22, 24 );
	vec4 data24 = getDatafromDataTexture( materialTexture, materialTexSize, materialIndex, 23, 24 );

	RayTracingMaterial material;

	material.color = vec4( data1.rgb, 1.0 );
	material.metalness = data1.a;

	material.emissive = data2.rgb;
	material.roughness = data2.a;

	material.ior = data3.r;
	material.transmission = data3.g;
	material.thickness = data3.b;
	material.emissiveIntensity = data3.a;

	material.attenuationColor = data4.rgb;
	material.attenuationDistance = data4.a;

	material.dispersion = data5.r;
	material.visible = bool( data5.g );
	material.sheen = data5.b;
	material.sheenRoughness = data5.a;

	material.sheenColor = data6.rgb;

	material.specularIntensity = data7.r;
	material.specularColor = data7.gba;

	material.iridescence = data8.r;
	material.iridescenceIOR = data8.g;
	material.iridescenceThicknessRange = data8.ba;

	material.albedoMapIndex = int( data9.r );
	material.normalMapIndex = int( data9.g );
	material.roughnessMapIndex = int( data9.b );
	material.metalnessMapIndex = int( data9.a );

	material.emissiveMapIndex = int( data10.r );
	material.bumpMapIndex = int( data10.g );
	material.clearcoat = data10.b;
	material.clearcoatRoughness = data10.a;

	material.opacity = data11.r;
	material.side = int( data11.g );
	material.transparent = bool( data11.b );
	material.alphaTest = data11.a;

	material.alphaMode = int( data12.r );
	material.depthWrite = int( data12.g );
	material.normalScale = vec2( data12.b, data12.a );

	material.albedoTransform = arrayToMat3( data13, data14 );
	material.normalTransform = arrayToMat3( data15, data16 );
	material.roughnessTransform = arrayToMat3( data17, data18 );
	material.metalnessTransform = arrayToMat3( data19, data20 );
	material.emissiveTransform = arrayToMat3( data21, data22 );
	material.bumpTransform = arrayToMat3( data23, data24 );

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

HitInfo traverseBVH( Ray ray, inout ivec2 stats ) {
	HitInfo closestHit;
	closestHit.didHit = false;
	closestHit.dst = 1e20;

	int stack[ 32 ];
	int stackSize = 0;
	stack[ stackSize ++ ] = 0; // Root node

	while( stackSize > 0 ) {
		int nodeIndex = stack[ -- stackSize ];
		BVHNode node = getBVHNode( nodeIndex );
		stats[ 0 ] ++;

		if( node.leftChild < 0 ) { // Leaf node
			for( int i = 0; i < int( node.triOffset.y ); i ++ ) {
				stats[ 1 ] ++;
				int triIndex = int( node.triOffset.x ) + i;
				Triangle tri = getTriangle( triIndex );
				HitInfo hit = RayTriangle( ray, tri );

				if( hit.didHit && hit.dst < closestHit.dst ) {
					hit.material = getMaterial( tri.materialIndex );

                    // Material visibility check
					float rayDotNormal = dot( ray.direction, hit.normal );
					bool visible = hit.material.visible && ( hit.material.side == 2 || // DoubleSide
						( hit.material.side == 0 && rayDotNormal < - 0.0001 ) || // FrontSide
						( hit.material.side == 1 && rayDotNormal > 0.0001 )     // BackSide
					);

					if( visible ) {
						closestHit = hit;
					}
				}
			}
			continue;
		}

        // Internal node - fetch both children at once
		BVHNode childA = getBVHNode( node.leftChild );
		BVHNode childB = getBVHNode( node.rightChild );

        // Compute distances before branching
		float dstA = RayBoundingBoxDst( ray, childA.boundsMin, childA.boundsMax );
		float dstB = RayBoundingBoxDst( ray, childB.boundsMin, childB.boundsMax );

        // Skip subtrees if we can't possibly hit anything closer
		if( dstA >= closestHit.dst && dstB >= closestHit.dst ) {
			continue;
		}

        // Push children onto stack in far-to-near order
        // This ensures we process nearest potential hits first
		if( dstA < dstB ) {
            // Child A is closer
			if( dstB < closestHit.dst ) {
				stack[ stackSize ++ ] = node.rightChild;
			}
			if( dstA < closestHit.dst ) {
				stack[ stackSize ++ ] = node.leftChild;
			}
		} else {
            // Child B is closer
			if( dstA < closestHit.dst ) {
				stack[ stackSize ++ ] = node.leftChild;
			}
			if( dstB < closestHit.dst ) {
				stack[ stackSize ++ ] = node.rightChild;
			}
		}
	}

	return closestHit;
}

Ray generateRayFromCamera( vec2 screenPosition, inout uint rngState ) {
    // Convert screen position to NDC (Normalized Device Coordinates)
	vec3 ndcPos = vec3( screenPosition.xy, 1.0 );

    // Convert NDC to camera space
	vec4 rayDirCameraSpace = cameraProjectionMatrixInverse * vec4( ndcPos, 1.0 );
	rayDirCameraSpace.xyz /= rayDirCameraSpace.w;
	rayDirCameraSpace.xyz = normalize( rayDirCameraSpace.xyz );

    // Convert to world space
	vec3 rayOriginWorld = vec3( cameraWorldMatrix[ 3 ] );
	vec3 rayDirectionWorld = normalize( mat3( cameraWorldMatrix ) * rayDirCameraSpace.xyz );

    // Set up basic ray
	Ray ray;
	ray.origin = rayOriginWorld;
	ray.direction = rayDirectionWorld;

    // Skip depth of field calculations if aperture is too small (pinhole camera)
	if( aperture > 16.0 || focalLength <= 0.0 ) {
		return ray;
	}

    // Calculate focal point - where rays converge
	vec3 focalPoint = rayOriginWorld + rayDirectionWorld * focusDistance;

    // Calculate aperture diameter and scale appropriately
    // Use larger scaling factors to make the effect more visible
    // focalLength is in mm, we want to scale it to have a noticeable but controlled effect
	float focalLengthMeters = focalLength * 0.001; // Convert mm to meters

    // Calculate the aperture size - using real-world-inspired scaling
    // Multiply by a larger factor to make the effect more pronounced
	float apertureRadius = ( focalLengthMeters / ( 2.0 * aperture ) ) * 0.1 * apertureScale;

    // Generate random point on aperture disk
	vec2 randomAperturePoint = RandomPointInCircle( rngState );
	vec3 right = normalize( cross( rayDirectionWorld, vec3( 0.0, 1.0, 0.0 ) ) );
	vec3 up = normalize( cross( right, rayDirectionWorld ) );

    // Apply the aperture offset
	vec3 apertureOffset = ( right * randomAperturePoint.x + up * randomAperturePoint.y ) * apertureRadius;
	ray.origin = rayOriginWorld + apertureOffset;

    // Update ray direction to point through focal point
	ray.direction = normalize( focalPoint - ray.origin );

	return ray;
}