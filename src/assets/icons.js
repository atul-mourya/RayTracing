import { createLucideIcon } from 'lucide-react';

export const FieldOfView = createLucideIcon( "FieldOfView", [
	// Center point (eye)
	[ "circle", { cx: "8", cy: "12", r: "2", key: "eye" } ],

	// Main field of view lines
	[ "path", { d: "M8 12 L20 6", key: "upper-line" } ],
	[ "path", { d: "M8 12 L20 18", key: "lower-line" } ],

	// Arc representing the field
	[ "path", { d: "M20 6 A 12.5 12.5 0 0 1 20 18", key: "arc" } ],

	// Degree markers
	[ "path", { d: "M8 12 L16 8", key: "marker-upper" } ],
	[ "path", { d: "M8 12 L16 16", key: "marker-lower" } ]
] );

export const Exposure = createLucideIcon( "Exposure", [
	// Border rectangle with rounded corners
	[ "rect", { width: "22", height: "22", rx: "2", ry: "2", transform: "translate(1 1)", fill: "none", stroke: "#fff", strokeWidth: "2", strokeLinejoin: "round", key: "border-rect" } ],

	// Diagonal line
	[ "line", { x1: "-15.0675", y1: "8.9354", x2: "8.9325", y2: "-15.0646", transform: "matrix(.916667 0 0 0.916667 14.81188 14.809225)", fill: "none", stroke: "#fff", strokeWidth: "2", key: "diagonal-line" } ],

	// Smaller rectangles (representing exposure adjustments)
	[ "rect", { width: "5.8", height: "1.28", rx: "0", ry: "0", transform: "translate(4.1 6.36)", fill: "#fff", strokeWidth: "0", key: "small-rect-1" } ],
	[ "rect", { width: "5.8", height: "1.28", rx: "0", ry: "0", transform: "translate(13.305649 16.001727)", fill: "#fff", strokeWidth: "0", key: "small-rect-2" } ],
	[ "rect", { width: "5.8", height: "1.28", rx: "0", ry: "0", transform: "matrix(0-1 1 0 15.565649 19.541727)", fill: "#fff", strokeWidth: "0", key: "small-rect-3" } ],

] );

