uniform sampler2D triangleTexture;
uniform vec2 triangleTexSize;

uniform sampler2D materialTexture;
uniform vec2 materialTexSize;

uniform sampler2D bvhTexture;
uniform vec2 bvhTexSize;

struct BVHNode {
	vec3 boundsMin;
	int leftChild;
	vec3 boundsMax;
	int rightChild;
	vec2 triOffset;
	vec2 padding;
};

vec4 getDatafromDataTexture( sampler2D tex, vec2 texSize, int stride, int sampleIndex, int dataOffset ) {
	int pixelIndex = stride * dataOffset + sampleIndex;
	int x = pixelIndex % int( texSize.x );
	int y = pixelIndex / int( texSize.x );
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

RayTracingMaterial getMaterial(int materialIndex) {
    vec4 data1 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 0, 18);
    vec4 data2 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 1, 18);
    vec4 data3 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 2, 18);
    vec4 data4 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 3, 18);
    vec4 data5 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 4, 18);
    vec4 data6 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 5, 18);
    vec4 data7 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 6, 18);
    vec4 data8 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 7, 18);
	vec4 data9 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 8, 18);
	vec4 data10 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 9, 18);
	vec4 data11 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 10, 18);
	vec4 data12 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 11, 18);
	vec4 data13 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 12, 18);
	vec4 data14 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 13, 18);
	vec4 data15 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 14, 18);
	vec4 data16 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 15, 18);
	vec4 data17 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 16, 18);
	vec4 data18 = getDatafromDataTexture(materialTexture, materialTexSize, materialIndex, 17, 18);

    RayTracingMaterial material;

    material.color = vec4(data1.rgb, 1.0);
    material.metalness = data1.a;

    material.emissive = data2.rgb;
    material.roughness = data2.a;

    material.ior = data3.r;
    material.transmission = data3.g;
    material.thickness = data3.b;
    material.emissiveIntensity = data3.a;

    material.albedoMapIndex = int(data4.r);
    material.normalMapIndex = int(data4.g);
    material.roughnessMapIndex = int(data4.b);
    material.metalnessMapIndex = int(data4.a);

    material.emissiveMapIndex = int(data5.r);
    material.bumpMapIndex = int(data5.g);
    material.clearcoat = data5.b;
    material.clearcoatRoughness = data5.a;

    material.opacity = data6.r;
    material.side = int(data6.g);
    material.normalScale = vec2(data6.b, data6.a);

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

					/* skip if 
						use ray direction and hit normal and check below cases to determine we need to skip or not
						case FrontSide -> material.side = 0;
						case BackSide -> material.side = 1;
						case DoubleSide -> material.side = 2;
					*/
					if( hit.material.side == 0 && dot( ray.direction, hit.normal ) > 0.0001 ) {
						hit.didHit = false;
					} else if( hit.material.side == 1 && dot( ray.direction, hit.normal ) < 0.0001 ) {
						hit.didHit = false;
					} else {
						closestHit = hit;
					}

				}
			}
		} else {

			int childAIndex = node.leftChild;
			int childBIndex = node.rightChild;

			BVHNode childA = getBVHNode( childAIndex );
			BVHNode childB = getBVHNode( childBIndex );

			float dstA = RayBoundingBoxDst( ray, childA.boundsMin, childA.boundsMax );
			float dstB = RayBoundingBoxDst( ray, childB.boundsMin, childB.boundsMax );

			bool isNearestA = dstA < dstB;

			float dstNear = isNearestA ? dstA : dstB;
			float dstFar = isNearestA ? dstB : dstA;

			int childIndexNear = isNearestA ? childAIndex : childBIndex;
			int childIndexFar = isNearestA ? childBIndex : childAIndex;

			// we want closest child to be looked at first, so it should be pushed last
			if( dstFar < closestHit.dst ) stack[ stackSize ++ ] = childIndexFar;
			if( dstNear < closestHit.dst ) stack[ stackSize ++ ] = childIndexNear;

		}

	}

	return closestHit;
}