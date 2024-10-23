vec4 TraceDebugMode( vec3 rayOrigin, vec3 rayDir ) {
	Ray ray;
	ray.origin = rayOrigin;
	ray.direction = rayDir;
	HitInfo hitInfo = traverseBVH( ray, stats );
	
	switch( visMode ) {
		case 1: {
			// Triangle test count vis
			float triVis = float( stats.x ) / debugVisScale;
			return triVis < 1.0 ? vec4( vec3( triVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
		}
		case 2: {
			// Box test count vis
			float boxVis = float( stats.y ) / debugVisScale;
			return boxVis < 1.0 ? vec4( vec3( boxVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
		}
		case 3: {
			// Distance
			return vec4( vec3( length( rayOrigin - hitInfo.hitPoint ) / debugVisScale ), 1.0 );
		}
		case 4: {
			// Normal
			if( ! hitInfo.didHit )
				return vec4( 0.0, 0.0, 0.0, 1.0 );
			return vec4( vec3( hitInfo.normal * 0.5 + 0.5 ), 1.0 );
		}
		default: {
			// Invalid test mode
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
	}
}