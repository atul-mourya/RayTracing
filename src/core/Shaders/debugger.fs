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
		case 6: {
            // Environment Importance Sampling Direction Visualization
			if( enableEnvironmentLight && useEnvMapIS ) {
                // Sample environment map at uniform intervals
				vec2 xi = gl_FragCoord.xy / resolution;
				EnvMapSample envSample = sampleEnvironmentIS( xi );

                // Visualize direction by showing color-coded direction vectors
				vec3 dirColor = envSample.direction * 0.5 + 0.5;
				return vec4( dirColor, 1.0 );
			}
			return vec4( 1.0, 0.0, 1.0, 1.0 ); // Magenta if not enabled
		}
		case 7: {
            // Environment Importance Sampling PDF Visualization
			if( enableEnvironmentLight && useEnvMapIS ) {
				// Show PDF values across the environment
				vec2 xi = gl_FragCoord.xy / resolution;
				EnvMapSample envSample = sampleEnvironmentIS( xi );

				// PDF values are often very small, so we need logarithmic scaling
				float pdf = envSample.pdf;

				if( pdf <= 0.0 ) {
					return vec4( 0.0, 0.0, 0.0, 1.0 ); // Black for zero PDF
				}

				// Use logarithmic scale for better visualization
				float logPdf = log( pdf + 1e-5 );  // Add small value to avoid log(0)
				float normalizedPdf = ( logPdf + 12.0 ) / 12.0;  // Roughly map to [0, 1]

				// Apply debug scale manually
				normalizedPdf *= debugVisScale;

				// Color coding for better visualization
				vec3 color;
				if( normalizedPdf < 0.5 ) {
					// Blue to Cyan for low PDFs
					color = mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 1.0 ), normalizedPdf * 2.0 );
				} else {
					// Cyan to Yellow for high PDFs
					color = mix( vec3( 0.0, 1.0, 1.0 ), vec3( 1.0, 1.0, 0.0 ), ( normalizedPdf - 0.5 ) * 2.0 );
				}

				return vec4( color, 1.0 );
			}
			return vec4( 1.0, 0.0, 1.0, 1.0 );
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
		case 9: {

			if( enableEnvironmentLight && useEnvMapIS ) {
				vec2 xi = gl_FragCoord.xy / resolution;
				EnvMapSample envSample = sampleEnvironmentIS( xi );

				// Convert direction to spherical coordinates for visualization
				float phi = atan( envSample.direction.x, envSample.direction.z );
				float theta = acos( envSample.direction.y );

				// Color code based on direction
				vec3 color = vec3( ( phi + PI ) / ( 2.0 * PI ),  // Red: azimuth angle
				theta / PI,                // Green: polar angle
				envSample.pdf * 100.0     // Blue: PDF value (scaled)
				);

				return vec4( color, 1.0 );
			}
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
		case 10: {
			// Environment Importance Sampling Raw PDF
			if( enableEnvironmentLight && useEnvMapIS ) {
				vec2 xi = gl_FragCoord.xy / resolution;
				EnvMapSample envSample = sampleEnvironmentIS( xi );

				// Show raw PDF value with auto-scaling
				float pdf = envSample.pdf;

				// Find the maximum PDF value in the scene (approximate)
				float maxPdf = 0.5;  // Typical max PDF for environment maps
				float normalizedPdf = pdf / maxPdf;

				// Simple grayscale visualization
				return vec4( vec3( normalizedPdf ), 1.0 );
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