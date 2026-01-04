uniform float debugVisScale;

// ============================================================================
// Debug Visualization Helpers
// ============================================================================

// Visualize depth with color gradient (near=white, far=black)
vec3 visualizeDepth( float depth ) {
	return vec3( 1.0 - depth );
}

// Visualize normals in world space (RGB mapped from [-1,1] to [0,1])
vec3 visualizeNormal( vec3 normal ) {
	return normal * 0.5 + 0.5;
}

// ============================================================================
// Main Debug Mode Function
// ============================================================================

vec4 TraceDebugMode( vec3 rayOrigin, vec3 rayDir ) {
	Ray ray;
	ray.origin = rayOrigin;
	ray.direction = rayDir;
	HitInfo hitInfo = traverseBVH( ray, stats, false );

	switch( visMode ) {
		// ------------------------------------------------------------------------
		// BVH Performance Metrics
		// ------------------------------------------------------------------------
		case 1: {
			// Triangle test count visualization
			float triVis = float( stats.x ) / debugVisScale;
			return triVis < 1.0 ? vec4( vec3( triVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
		}
		case 2: {
			// Box test count visualization
			float boxVis = float( stats.y ) / debugVisScale;
			return boxVis < 1.0 ? vec4( vec3( boxVis ), 1.0 ) : vec4( 1.0, 0.0, 0.0, 1.0 );
		}

		// ------------------------------------------------------------------------
		// Geometry Information
		// ------------------------------------------------------------------------
		case 3: {
			// Ray distance visualization
			return vec4( vec3( length( rayOrigin - hitInfo.hitPoint ) / debugVisScale ), 1.0 );
		}
		case 4: {
			// Ray-traced surface normals (from BVH traversal)
			if( ! hitInfo.didHit )
				return vec4( 0.0, 0.0, 0.0, 1.0 );
			return vec4( visualizeNormal( hitInfo.normal ), 1.0 );
		}

		// ------------------------------------------------------------------------
		// Environment & Lighting
		// ------------------------------------------------------------------------
		case 6: {
            // Environment Map Luminance Visualization
			if( enableEnvironmentLight ) {
                // Sample the environment map at the ray direction
				vec4 envSample = sampleEnvironment( rayDir );

                // Calculate luminance from the RGB values
				float envLuminance = dot( envSample.rgb , REC709_LUMINANCE_COEFFICIENTS);

                // Try multiple scaling approaches to diagnose the issue
				float rawLuminance = envLuminance;

                // Use adaptive scaling instead of fixed debugVisScale
				float adaptiveScale = max( debugVisScale * 0.1, 0.001 ); // Much smaller scale
				float scaledLuminance = envLuminance / adaptiveScale;

                // Alternative: Use logarithmic scaling for better dynamic range
				float logLuminance = log( envLuminance + 1e-6 );
				float logScaled = ( logLuminance + 10.0 ) / 10.0; // Adjust range

                // Choose which scaling to use based on debugVisScale value
				float finalValue = debugVisScale > 1.0 ? scaledLuminance : logScaled;

                // Create a heat map visualization with extended range
				vec3 color;
				if( finalValue < 0.2 ) {
                    // Very dark areas: black to dark blue
					color = mix( vec3( 0.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 0.5 ), finalValue * 5.0 );
				} else if( finalValue < 0.4 ) {
                    // Dark areas: dark blue to blue
					color = mix( vec3( 0.0, 0.0, 0.5 ), vec3( 0.0, 0.0, 1.0 ), ( finalValue - 0.2 ) * 5.0 );
				} else if( finalValue < 0.6 ) {
                    // Medium areas: blue to green
					color = mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), ( finalValue - 0.4 ) * 5.0 );
				} else if( finalValue < 0.8 ) {
                    // Bright areas: green to yellow
					color = mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 1.0, 0.0 ), ( finalValue - 0.6 ) * 5.0 );
				} else if( finalValue < 1.0 ) {
                    // Very bright areas: yellow to red
					color = mix( vec3( 1.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), ( finalValue - 0.8 ) * 5.0 );
				} else {
                    // Extremely bright areas: red to white
					color = mix( vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 1.0, 1.0 ), min( finalValue - 1.0, 1.0 ) );
				}

                // Debug: Show raw values in specific screen regions
				vec2 screenPos = gl_FragCoord.xy / resolution;
				if( screenPos.x < 0.1 && screenPos.y < 0.1 ) {
                    // Top-left corner: show raw luminance scaled by 1000
					float debugValue = rawLuminance * 1.0;
					color = vec3( debugValue );
				} else if( screenPos.x > 0.9 && screenPos.y < 0.1 ) {
                    // Top-right corner: show environment sample RGB directly
					color = envSample.rgb * 1.0; // Amplify to see if there's any signal
				}

				return vec4( color, 1.0 );
			}
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
		case 7: {
			// Environment Importance Sampling PDF Direction Map
			if( enableEnvironmentLight && useEnvMapIS ) {
				// Instead of randomly sampling, use screen space to map UV coordinates
				vec2 uv = gl_FragCoord.xy / resolution;

				// Convert UV to direction
				vec3 direction = equirectUvToDirection( uv );

				// Get PDF for this direction
				vec3 envColor;
				float pdf = sampleEquirect( direction, envColor );

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
		case 8: {
			// Emissive Triangle Direct Lighting Visualization
			if( ! enableEmissiveTriangleSampling || totalTriangleCount <= 0 ) {
				return vec4( 1.0, 0.0, 1.0, 1.0 ); // Magenta if disabled
			}

			// Trace primary ray
			if( ! hitInfo.didHit ) {
				return vec4( 0.0, 0.0, 0.0, 1.0 ); // Black for background
			}

			// Get material and normal
			MaterialSamples matSamples = sampleAllMaterialTextures( hitInfo.material, hitInfo.uv, hitInfo.normal );
			RayTracingMaterial material = hitInfo.material;
			material.color = matSamples.albedo;
			material.metalness = matSamples.metalness;
			material.roughness = clamp( matSamples.roughness, MIN_ROUGHNESS, MAX_ROUGHNESS );
			vec3 N = matSamples.normal;
			vec3 V = - rayDir;

			// Sample emissive contribution
			uint tempRng = pcg_hash( uint( gl_FragCoord.x + gl_FragCoord.y * resolution.x ) + frame * 12345u );
			ivec2 tempStats = ivec2( 0 );

			EmissiveContributionResult emissiveResult = calculateEmissiveTriangleContributionDebug(
				hitInfo.hitPoint,
				N,
				V,
				material,
				totalTriangleCount,
				0, // primary bounce
				tempRng,
				tempStats
			);

			// Visualize the result
			if( ! emissiveResult.hasEmissive ) {
				// No emissive found - dark blue
				return vec4( 0.0, 0.0, 0.1, 1.0 );
			}

			// Show emissive contribution with intensity mapping
			vec3 contribution = emissiveResult.contribution;
			float intensity = length( contribution );

			// Scale for visualization
			vec3 visualColor = contribution / max( intensity * 0.1, 0.001 );

			// Add distance-based tint (closer = warmer)
			float distanceFactor = clamp( 1.0 - emissiveResult.distance / 10.0, 0.0, 1.0 );
			visualColor = mix( visualColor, visualColor * vec3( 1.0, 0.8, 0.6 ), distanceFactor * 0.3 );

			return vec4( visualColor, 1.0 );
		}

		// ------------------------------------------------------------------------
		// MRT (Multiple Render Targets) Outputs
		// These visualize what gets written to the MRT buffers
		// ------------------------------------------------------------------------
		case 9: {
			// MRT: World-space normals (gNormalDepth.rgb)
			// Shows the surface normal that gets written to the MRT for denoisers
			if( ! hitInfo.didHit )
				return vec4( 0.5, 0.5, 1.0, 1.0 ); // Sky/background = up vector

			// Get material-mapped normal (same as what's used in main shader)
			MaterialSamples matSamples = sampleAllMaterialTextures( hitInfo.material, hitInfo.uv, hitInfo.normal );
			vec3 worldNormal = normalize( matSamples.normal );

			// Encode as [0,1] range (same as gNormalDepth output)
			return vec4( visualizeNormal( worldNormal ), 1.0 );
		}
		case 10: {
			// MRT: Linear depth (gNormalDepth.a)
			// Shows the NDC depth value [0,1] that gets written to the MRT
			if( ! hitInfo.didHit )
				return vec4( vec3( 1.0 ), 1.0 ); // Far plane = white

			// Compute NDC depth (same as main shader)
			float linearDepth = computeNDCDepth( hitInfo.hitPoint );

			// Visualize: near=white, far=black
			return vec4( visualizeDepth( linearDepth ), 1.0 );
		}
		case 11: {
			// MRT: Albedo (gAlbedo.rgb)
			// Shows the base color that gets written to the MRT for denoisers (OIDN)
			if( ! hitInfo.didHit )
				return vec4( 0.0, 0.0, 0.0, 1.0 ); // Background = black

			// Get albedo from material textures (same as main shader)
			MaterialSamples matSamples = sampleAllMaterialTextures( hitInfo.material, hitInfo.uv, hitInfo.normal );
			vec3 objectColor = matSamples.albedo.rgb;

			return vec4( objectColor, 1.0 );
		}

		// ------------------------------------------------------------------------
		// Default Case
		// ------------------------------------------------------------------------
		default: {
			// Invalid debug mode - show magenta as error indicator
			return vec4( 1.0, 0.0, 1.0, 1.0 );
		}
	}
}