uniform bool enableEnvironmentLight;
uniform float sunAzimuth;
uniform float sunElevation;
uniform float sunIntensity;
uniform vec3 sunColor;

vec3 GetEnvironmentLight(Ray ray) {
	
	if (!enableEnvironmentLight) {
		return vec3(0.0);
	}
	const vec3 SkyColourHorizon = vec3(0.13, 0.49, 0.97);  // Light blue
	const vec3 SkyColourZenith = vec3(0.529, 0.808, 0.922);   // Darker blue
	const float SunFocus = 512.0;
	const vec3 GroundColour = vec3(0.53, 0.6, 0.62);  // Dark grey

	// Calculate sun direction from angles
	vec3 SunLightDirection = vec3(cos(sunElevation) * sin(sunAzimuth), sin(sunElevation), cos(sunElevation) * cos(sunAzimuth));

	float skyGradientT = pow(smoothstep(0.0, 0.4, ray.direction.y), 0.35);
	vec3 skyGradient = lerp(SkyColourHorizon, SkyColourZenith, skyGradientT);

	// Calculate sun contribution
	float sunDot = max(0.0, dot(ray.direction, -SunLightDirection));
	float sun = pow(sunDot, SunFocus) * sunIntensity;

	// Combine ground, sky, and sun
	float groundToSkyT = smoothstep(-0.01, 0.0, ray.direction.y);
	float sunMask = (groundToSkyT >= 1.0) ? 1.0 : 0.0;
	return lerp(GroundColour, skyGradient, groundToSkyT) + sun * sunMask;
}

// Trace the path of a ray of light (in reverse) as it travels from the camera,
// reflects off objects in the scene, and ends up (hopefully) at a light source.