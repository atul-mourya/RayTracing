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
		case 8: {
            // Environment Map Luminance Visualization
			if( enableEnvironmentLight ) {
                // Show the environment map luminance directly
				vec2 uv = gl_FragCoord.xy / resolution;
				vec3 direction = uvToDirection( uv );
				vec3 envColor = sampleEnvironment( direction ).rgb;
				float luminance = dot( envColor, vec3( 0.2126, 0.7152, 0.0722 ) );
				return vec4( vec3( luminance ), 1.0 );
			}
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
		case 11: {
			// Environment Importance Sampling PDF Direction Map
			if( enableEnvironmentLight && useEnvMapIS ) {
				// Instead of randomly sampling, use screen space to map UV coordinates
				vec2 uv = gl_FragCoord.xy / resolution;

				// Convert UV to direction
				vec3 direction = uvToDirection( uv );

				// Get PDF for this direction
				float pdf = envMapSamplingPDF( direction );

				// Visualize with better scaling
				float logPdf = log( pdf + 1e-8 );
				float normalizedPdf = ( logPdf + 15.0 ) / 15.0;

				// Heat map colors
				vec3 color;
				if( normalizedPdf < 0.33 ) {
					color = mix( vec3( 0.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), normalizedPdf * 3.0 );
				} else if( normalizedPdf < 0.66 ) {
					color = mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), ( normalizedPdf - 0.33 ) * 3.0 );
				} else {
					color = mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), ( normalizedPdf - 0.66 ) * 3.0 );
				}

				return vec4( color, 1.0 );
			}
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
		default: {
			// Invalid test mode
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
	}
}