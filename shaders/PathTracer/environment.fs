
// Simple background environment lighting
vec3 GetEnvironmentLight(Ray ray) {
			// Sky colors
	const vec3 SkyColourHorizon = vec3(0.13f, 0.49f, 0.97f);  // Light blue
	const vec3 SkyColourZenith = vec3(0.529f, 0.808f, 0.922f);   // Darker blue

	// Sun properties
	float sunAzimuth = 2.0f * PI - PI / 4.0f;  // Angle around the horizon (0 to 2π)
	float sunElevation = - PI / 4.0f;  // Angle above the horizon (-π/2 to π/2)
	const float SunFocus = 512.0f;
	const float SunIntensity = 100.0f;

	// Ground color
	const vec3 GroundColour = vec3(0.53f, 0.6f, 0.62f);  // Dark grey

	// Calculate sun direction from angles
	vec3 SunLightDirection = vec3(cos(sunElevation) * sin(sunAzimuth), sin(sunElevation), cos(sunElevation) * cos(sunAzimuth));

	float skyGradientT = pow(smoothstep(0.0f, 0.4f, ray.direction.y), 0.35f);
	vec3 skyGradient = lerp(SkyColourHorizon, SkyColourZenith, skyGradientT);

	// Calculate sun contribution
	float sunDot = max(0.0f, dot(ray.direction, - SunLightDirection));
	float sun = pow(sunDot, SunFocus) * SunIntensity;

	// Combine ground, sky, and sun
	float groundToSkyT = smoothstep(- 0.01f, 0.0f, ray.direction.y);
	float sunMask = (groundToSkyT >= 1.0f) ? 1.0f : 0.0f;
	return lerp(GroundColour, skyGradient, groundToSkyT) + sun * sunMask;
}

// Trace the path of a ray of light (in reverse) as it travels from the camera,
// reflects off objects in the scene, and ends up (hopefully) at a light source.