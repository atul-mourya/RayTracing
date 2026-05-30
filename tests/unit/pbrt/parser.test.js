import { describe, it, expect } from 'vitest';
import { tokenize, TokenType } from '@/core/Processor/PBRT/PBRTTokenizer.js';
import { PBRTParser, parsePBRT } from '@/core/Processor/PBRT/PBRTParser.js';

describe( 'PBRT tokenizer', () => {

	it( 'tokenizes numbers, strings, brackets and skips comments', () => {

		const toks = tokenize( `# a comment
			Shape "trianglemesh" "float v" [ -1 .5 1e-3 -2.5e2 ] true` );

		expect( toks[ 0 ] ).toEqual( { type: TokenType.WORD, value: 'Shape' } );
		expect( toks[ 1 ] ).toEqual( { type: TokenType.STRING, value: 'trianglemesh' } );
		expect( toks[ 2 ] ).toEqual( { type: TokenType.STRING, value: 'float v' } );
		expect( toks[ 3 ].type ).toBe( TokenType.LBRACKET );
		expect( toks.slice( 4, 8 ).map( t => t.value ) ).toEqual( [ - 1, 0.5, 1e-3, - 250 ] );
		expect( toks[ 8 ].type ).toBe( TokenType.RBRACKET );
		expect( toks[ 9 ] ).toEqual( { type: TokenType.WORD, value: 'true' } );

	} );

	it( 'throws on an unterminated string', () => {

		expect( () => tokenize( 'Shape "oops' ) ).toThrow( /unterminated/ );

	} );

	it( 'tokenizes signed + leading-dot numbers (-.55, +.5, .25)', () => {

		const toks = tokenize( 'Transform [ -.55 +.5 .25 -0.5 +0.5 ]' );
		expect( toks.slice( 2, 7 ).map( t => t.value ) ).toEqual( [ - 0.55, 0.5, 0.25, - 0.5, 0.5 ] );

	} );

} );

describe( 'PBRT parser', () => {

	it( 'derives camera-to-world from LookAt (inverse-of-inverse round trip)', () => {

		const ir = parsePBRT( `
			LookAt 0 0 5   0 0 0   0 1 0
			Camera "perspective" "float fov" 45
			Film "rgb" "integer xresolution" 800 "integer yresolution" 600
			WorldBegin
		` );

		expect( ir.camera.type ).toBe( 'perspective' );
		expect( ir.camera.params.fov.value[ 0 ] ).toBe( 45 );

		const m = ir.camera.cameraToWorld;
		// translation column == eye
		expect( m[ 12 ] ).toBeCloseTo( 0, 5 );
		expect( m[ 13 ] ).toBeCloseTo( 0, 5 );
		expect( m[ 14 ] ).toBeCloseTo( 5, 5 );
		// viewing direction column (dir) == -z
		expect( m[ 8 ] ).toBeCloseTo( 0, 5 );
		expect( m[ 10 ] ).toBeCloseTo( - 1, 5 );

		expect( ir.film.xresolution ).toBe( 800 );
		expect( ir.film.yresolution ).toBe( 600 );

	} );

	it( 'accumulates the CTM and captures it per-shape', () => {

		const ir = parsePBRT( `
			WorldBegin
			AttributeBegin
				Translate 1 2 3
				Shape "sphere" "float radius" 0.25
			AttributeEnd
			Shape "sphere" "float radius" 1
		` );

		expect( ir.shapes ).toHaveLength( 2 );
		// first shape carries the translate
		expect( ir.shapes[ 0 ].ctm.slice( 12, 15 ) ).toEqual( [ 1, 2, 3 ] );
		expect( ir.shapes[ 0 ].params.radius.value[ 0 ] ).toBe( 0.25 );
		// AttributeEnd restored CTM → second shape is at the origin
		expect( ir.shapes[ 1 ].ctm.slice( 12, 15 ) ).toEqual( [ 0, 0, 0 ] );

	} );

	it( 'resolves named materials and attaches them to shapes', () => {

		const ir = parsePBRT( `
			WorldBegin
			MakeNamedMaterial "glass" "string type" "dielectric" "float eta" 1.5
			NamedMaterial "glass"
			Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ]
		` );

		expect( ir.namedMaterials.get( 'glass' ).type ).toBe( 'dielectric' );
		const shape = ir.shapes[ 0 ];
		expect( shape.material.type ).toBe( 'dielectric' );
		expect( shape.material.params.eta.value[ 0 ] ).toBe( 1.5 );
		expect( shape.params.P.value ).toEqual( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
		expect( shape.params.indices.value ).toEqual( [ 0, 1, 2 ] );

	} );

	it( 'attaches area-light emission to shapes within the attribute block', () => {

		const ir = parsePBRT( `
			WorldBegin
			AttributeBegin
				AreaLightSource "diffuse" "rgb L" [ 4 4 4 ]
				Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ]
			AttributeEnd
			Shape "sphere" "float radius" 1
		` );

		expect( ir.shapes[ 0 ].areaLight.params.L.value ).toEqual( [ 4, 4, 4 ] );
		expect( ir.shapes[ 1 ].areaLight ).toBeNull();

	} );

	it( 'follows Include directives via the resolver', () => {

		const files = {
			'geometry/tri.pbrt': `Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ]`
		};
		const parser = new PBRTParser( { resolveInclude: ( p ) => files[ p ] ?? null } );
		const ir = parser.parse( `
			WorldBegin
			Include "geometry/tri.pbrt"
			Shape "sphere" "float radius" 1
		` );

		expect( ir.shapes ).toHaveLength( 2 );
		expect( ir.shapes[ 0 ].type ).toBe( 'trianglemesh' );
		expect( ir.shapes[ 1 ].type ).toBe( 'sphere' );

	} );

	it( 'parses Transform matrices column-major', () => {

		const ir = parsePBRT( `
			WorldBegin
			Transform [ 1 0 0 0  0 1 0 0  0 0 1 0  5 6 7 1 ]
			Shape "sphere" "float radius" 1
		` );
		expect( ir.shapes[ 0 ].ctm.slice( 12, 15 ) ).toEqual( [ 5, 6, 7 ] );

	} );

	it( 'records instances and object templates', () => {

		const ir = parsePBRT( `
			WorldBegin
			ObjectBegin "leaf"
				Shape "sphere" "float radius" 1
			ObjectEnd
			Translate 10 0 0
			ObjectInstance "leaf"
		` );

		expect( ir.objects.get( 'leaf' ) ).toHaveLength( 1 );
		expect( ir.instances ).toHaveLength( 1 );
		expect( ir.instances[ 0 ].name ).toBe( 'leaf' );
		expect( ir.instances[ 0 ].ctm.slice( 12, 15 ) ).toEqual( [ 10, 0, 0 ] );

	} );

	it( 'warns on unknown directives without desyncing', () => {

		const ir = parsePBRT( `
			Integrator "volpath" "integer maxdepth" 64
			Sampler "halton" "integer pixelsamples" 16
			WorldBegin
			Shape "sphere" "float radius" 1
		` );
		expect( ir.shapes ).toHaveLength( 1 );

	} );

} );
