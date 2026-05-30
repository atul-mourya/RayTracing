/**
 * Parser + graphics-state machine for pbrt-v4 scene files.
 *
 * Consumes the token stream from PBRTTokenizer and produces a plain-data
 * intermediate representation (IR). No Three.js types — the IR is converted
 * to a scene graph later by PBRTSceneBuilder, keeping this module unit-testable.
 *
 * The graphics state mirrors pbrt's: a current transformation matrix (CTM),
 * a current material, a current area-light emission, and a reverse-orientation
 * flag, all saved/restored by AttributeBegin/AttributeEnd.
 *
 * IR shape:
 * {
 *   film:   { xresolution, yresolution, filename } | null,
 *   camera: { type, params, cameraToWorld:number[16] } | null,
 *   namedMaterials: Map<name, { type, params }>,
 *   namedTextures:  Map<name, { dataType, class, params }>,
 *   shapes: [ { type, params, ctm, material, areaLight, reverseOrientation } ],
 *   lights: [ { type, params, ctm } ],
 *   instances: [ { name, ctm } ],
 *   objects: Map<name, shapes[]>,
 *   warnings: string[]
 * }
 */

import { tokenize, TokenType } from './PBRTTokenizer.js';
import * as M from './PBRTMath.js';

export class PBRTParser {

	/**
	 * @param {object} [opts]
	 * @param {(path:string)=>string} [opts.resolveInclude] - returns the text of
	 *        an Include/Import target, resolved relative to the current file.
	 */
	constructor( opts = {} ) {

		this.resolveInclude = opts.resolveInclude || ( () => {

			throw new Error( 'PBRTParser: Include used but no resolveInclude provided' );

		} );

		// IR accumulators
		this.ir = {
			film: null,
			camera: null,
			namedMaterials: new Map(),
			namedTextures: new Map(),
			shapes: [],
			lights: [],
			instances: [],
			objects: new Map(),
			warnings: []
		};

		// Graphics state
		this.ctm = M.identity();
		this.state = { material: null, areaLight: null, reverseOrientation: false };
		this.attributeStack = [];
		this.transformStack = [];
		this.coordSystems = new Map();

		// Object capture (ObjectBegin/End)
		this.currentObject = null; // name being captured, or null
		this.objectBeginCTM = null; // CTM frame at ObjectBegin

		// Directory stack for resolving nested Includes
		this.dirStack = [ '' ];

		// Token cursor (swapped during Include recursion)
		this.tokens = [];
		this.pos = 0;

		this._warnedUnknown = new Set();

	}

	/**
	 * Parse a top-level pbrt source string.
	 * @param {string} src
	 * @param {string} [baseDir] - directory of the source file, for Include paths
	 * @returns {object} IR
	 */
	parse( src, baseDir = '' ) {

		this.dirStack = [ baseDir ];
		this._run( tokenize( src ) );
		return this.ir;

	}

	// ── token helpers ──────────────────────────────────────────────

	_peek() {

		return this.tokens[ this.pos ];

	}

	_next() {

		return this.tokens[ this.pos ++ ];

	}

	_expectNumber( what ) {

		const t = this._next();
		if ( ! t || t.type !== TokenType.NUMBER ) {

			throw new Error( `PBRT parser: expected number for ${what}, got ${t ? t.value : 'EOF'}` );

		}

		return t.value;

	}

	_expectString( what ) {

		const t = this._next();
		if ( ! t || t.type !== TokenType.STRING ) {

			throw new Error( `PBRT parser: expected string for ${what}, got ${t ? t.value : 'EOF'}` );

		}

		return t.value;

	}

	_readNumbers( count ) {

		const out = [];
		for ( let i = 0; i < count; i ++ ) out.push( this._expectNumber( 'matrix/transform' ) );
		return out;

	}

	/**
	 * Reads a `[ ... ]` bracketed list of numbers (transforms use this form,
	 * but pbrt also accepts the 16 bare numbers without brackets).
	 */
	_readBracketedOrBareNumbers( count ) {

		if ( this._peek() && this._peek().type === TokenType.LBRACKET ) {

			this._next(); // [
			const out = [];
			while ( this._peek() && this._peek().type !== TokenType.RBRACKET ) {

				out.push( this._expectNumber( 'transform element' ) );

			}

			this._next(); // ]
			return out;

		}

		return this._readNumbers( count );

	}

	/**
	 * Parse a pbrt parameter list: a run of `"type name" value(s)` pairs.
	 * Stops when the next token is not a declarator string.
	 * @returns {Object<string, {type:string, value:Array}>}
	 */
	_parseParams() {

		const params = {};

		while ( this._peek() && this._peek().type === TokenType.STRING ) {

			const decl = this._next().value.trim().split( /\s+/ );
			const type = decl[ 0 ];
			const name = decl[ 1 ] !== undefined ? decl[ 1 ] : decl[ 0 ];

			const value = this._parseParamValue();
			params[ name ] = { type, value };

		}

		return params;

	}

	/** Read a single parameter value: a bracketed array or one bare token. */
	_parseParamValue() {

		const out = [];

		if ( this._peek() && this._peek().type === TokenType.LBRACKET ) {

			this._next(); // [
			while ( this._peek() && this._peek().type !== TokenType.RBRACKET ) {

				out.push( this._coerceValueToken( this._next() ) );

			}

			this._next(); // ]

		} else {

			out.push( this._coerceValueToken( this._next() ) );

		}

		return out;

	}

	_coerceValueToken( t ) {

		if ( ! t ) throw new Error( 'PBRT parser: unexpected EOF in parameter value' );
		if ( t.type === TokenType.NUMBER ) return t.value;
		if ( t.type === TokenType.STRING ) return t.value;
		if ( t.type === TokenType.WORD ) {

			if ( t.value === 'true' ) return true;
			if ( t.value === 'false' ) return false;
			return t.value;

		}

		throw new Error( `PBRT parser: unexpected token in parameter value: ${t.type}` );

	}

	// ── main directive loop ────────────────────────────────────────

	_run( tokens ) {

		// Save/restore cursor so Include can recurse on a fresh token array.
		const savedTokens = this.tokens;
		const savedPos = this.pos;
		this.tokens = tokens;
		this.pos = 0;

		while ( this.pos < this.tokens.length ) {

			const t = this._next();
			if ( t.type !== TokenType.WORD ) {

				throw new Error( `PBRT parser: expected directive, got ${t.type} ${t.value ?? ''}` );

			}

			this._directive( t.value );

		}

		this.tokens = savedTokens;
		this.pos = savedPos;

	}

	_directive( name ) {

		switch ( name ) {

			// ── transforms ──
			case 'Identity': this.ctm = M.identity(); break;
			case 'Translate': {

				const [ x, y, z ] = this._readNumbers( 3 );
				this.ctm = M.multiply( this.ctm, M.translate( x, y, z ) );
				break;

			}

			case 'Scale': {

				const [ x, y, z ] = this._readNumbers( 3 );
				this.ctm = M.multiply( this.ctm, M.scale( x, y, z ) );
				break;

			}

			case 'Rotate': {

				const [ angle, x, y, z ] = this._readNumbers( 4 );
				this.ctm = M.multiply( this.ctm, M.rotate( angle, x, y, z ) );
				break;

			}

			case 'LookAt': {

				const v = this._readNumbers( 9 );
				const camToWorld = M.lookAtCameraToWorld(
					[ v[ 0 ], v[ 1 ], v[ 2 ] ], [ v[ 3 ], v[ 4 ], v[ 5 ] ], [ v[ 6 ], v[ 7 ], v[ 8 ] ]
				);
				// pbrt sets CTM to world-to-camera = inverse(cameraToWorld).
				this.ctm = M.multiply( this.ctm, M.invert( camToWorld ) );
				break;

			}

			case 'Transform': {

				this.ctm = this._readBracketedOrBareNumbers( 16 );
				break;

			}

			case 'ConcatTransform': {

				const m = this._readBracketedOrBareNumbers( 16 );
				this.ctm = M.multiply( this.ctm, m );
				break;

			}

			case 'CoordinateSystem': this.coordSystems.set( this._expectString( 'CoordinateSystem' ), this.ctm.slice() ); break;
			case 'CoordSysTransform': {

				const cs = this.coordSystems.get( this._expectString( 'CoordSysTransform' ) );
				if ( cs ) this.ctm = cs.slice();
				break;

			}

			// ── scene-wide options ──
			case 'Camera': {

				const type = this._expectString( 'Camera type' );
				const params = this._parseParams();
				// Camera-to-world is the inverse of the CTM at the Camera directive.
				this.ir.camera = { type, params, cameraToWorld: M.invert( this.ctm ) };
				break;

			}

			case 'Film': {

				this._expectString( 'Film type' );
				const params = this._parseParams();
				this.ir.film = {
					xresolution: this._num( params.xresolution, 1280 ),
					yresolution: this._num( params.yresolution, 720 ),
					filename: this._str( params.filename, null )
				};
				break;

			}

			// Consumed for completeness; not used by the engine.
			case 'Integrator':
			case 'Sampler':
			case 'PixelFilter':
			case 'Filter':
			case 'Accelerator':
			case 'ColorSpace':
			case 'Option':
				this._skipTypeAndParams();
				break;

			// ── world block ──
			case 'WorldBegin':
				this.ctm = M.identity();
				this.state = { material: null, areaLight: null, reverseOrientation: false };
				break;
			case 'WorldEnd': break; // legacy v3

			case 'AttributeBegin':
				this.attributeStack.push( {
					ctm: this.ctm.slice(),
					material: this.state.material,
					areaLight: this.state.areaLight,
					reverseOrientation: this.state.reverseOrientation
				} );
				break;
			case 'AttributeEnd': {

				const s = this.attributeStack.pop();
				if ( s ) {

					this.ctm = s.ctm;
					this.state = { material: s.material, areaLight: s.areaLight, reverseOrientation: s.reverseOrientation };

				}

				break;

			}

			case 'TransformBegin': this.transformStack.push( this.ctm.slice() ); break;
			case 'TransformEnd': {

				const m = this.transformStack.pop(); if ( m ) this.ctm = m; break;

			}

			case 'ReverseOrientation': this.state.reverseOrientation = ! this.state.reverseOrientation; break;

			// `Attribute "target" params` — v4 default-setting; ignored for MVP.
			case 'Attribute': this._expectString( 'Attribute target' ); this._parseParams(); break;
			case 'ActiveTransform': this._next(); break; // StartTime|EndTime|All
			case 'TransformTimes': this._readNumbers( 2 ); break;
			case 'MediumInterface': {

				// up to two strings (inside/outside)
				if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
				if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
				break;

			}

			case 'MakeNamedMedium': this._skipNamedAndParams(); break;

			// ── materials ──
			case 'Material': {

				const type = this._expectString( 'Material type' );
				const params = this._parseParams();
				this.state.material = { type, params };
				break;

			}

			case 'MakeNamedMaterial': {

				const matName = this._expectString( 'MakeNamedMaterial name' );
				const params = this._parseParams();
				const type = this._str( params.type, 'diffuse' );
				this.ir.namedMaterials.set( matName, { type, params } );
				break;

			}

			case 'NamedMaterial': {

				const ref = this._expectString( 'NamedMaterial name' );
				const def = this.ir.namedMaterials.get( ref );
				this.state.material = def || { type: 'diffuse', params: {}, _missingRef: ref };
				if ( ! def ) this._warn( `NamedMaterial "${ref}" referenced before definition` );
				break;

			}

			case 'Texture': {

				const texName = this._expectString( 'Texture name' );
				const dataType = this._expectString( 'Texture data type' ); // float | spectrum
				const texClass = this._expectString( 'Texture class' ); // imagemap | scale | ...
				const params = this._parseParams();
				this.ir.namedTextures.set( texName, { dataType, class: texClass, params } );
				break;

			}

			// ── lights ──
			case 'AreaLightSource': {

				const type = this._expectString( 'AreaLightSource type' );
				const params = this._parseParams();
				this.state.areaLight = { type, params };
				break;

			}

			case 'LightSource': {

				const type = this._expectString( 'LightSource type' );
				const params = this._parseParams();
				this.ir.lights.push( { type, params, ctm: this.ctm.slice() } );
				break;

			}

			// ── geometry ──
			case 'Shape': {

				const type = this._expectString( 'Shape type' );
				const params = this._parseParams();
				const shape = {
					type,
					params,
					ctm: this.ctm.slice(),
					material: this.state.material,
					areaLight: this.state.areaLight,
					reverseOrientation: this.state.reverseOrientation
				};
				this._emitShape( shape );
				break;

			}

			// ── instancing ──
			case 'ObjectBegin': {

				const objName = this._expectString( 'ObjectBegin name' );
				// pbrt implicitly pushes graphics state.
				this.attributeStack.push( {
					ctm: this.ctm.slice(),
					material: this.state.material,
					areaLight: this.state.areaLight,
					reverseOrientation: this.state.reverseOrientation
				} );
				this.currentObject = objName;
				this.objectBeginCTM = this.ctm.slice();
				if ( ! this.ir.objects.has( objName ) ) this.ir.objects.set( objName, [] );
				break;

			}

			case 'ObjectEnd': {

				this.currentObject = null;
				this.objectBeginCTM = null;
				const s = this.attributeStack.pop();
				if ( s ) {

					this.ctm = s.ctm;
					this.state = { material: s.material, areaLight: s.areaLight, reverseOrientation: s.reverseOrientation };

				}

				break;

			}

			case 'ObjectInstance': {

				const objName = this._expectString( 'ObjectInstance name' );
				this.ir.instances.push( { name: objName, ctm: this.ctm.slice() } );
				break;

			}

			// ── file inclusion ──
			case 'Include':
			case 'Import': {

				const path = this._expectString( name );
				this._include( path );
				break;

			}

			default:
				this._warnUnknown( name );
				// Best effort: swallow any trailing parameter list to stay in sync.
				this._parseParams();
				break;

		}

	}

	// ── directive support ──────────────────────────────────────────

	_emitShape( shape ) {

		if ( this.currentObject !== null ) {

			// Store relative to the ObjectBegin frame so instances can re-place it.
			shape.relativeCTM = M.multiply( M.invert( this.objectBeginCTM ), shape.ctm );
			this.ir.objects.get( this.currentObject ).push( shape );

		} else {

			this.ir.shapes.push( shape );

		}

	}

	_include( path ) {

		const text = this.resolveInclude( path, this.dirStack[ this.dirStack.length - 1 ] );
		if ( text == null ) {

			this._warn( `Include target not found: ${path}` );
			return;

		}

		const dir = path.includes( '/' ) ? path.slice( 0, path.lastIndexOf( '/' ) ) : '';
		this.dirStack.push( dir );
		this._run( tokenize( text ) );
		this.dirStack.pop();

	}

	_skipTypeAndParams() {

		// "type" then params
		if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
		this._parseParams();

	}

	_skipNamedAndParams() {

		if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
		this._parseParams();

	}

	// ── param coercion helpers ─────────────────────────────────────

	_num( p, dflt ) {

		return p && p.value.length ? p.value[ 0 ] : dflt;

	}

	_str( p, dflt ) {

		return p && p.value.length ? p.value[ 0 ] : dflt;

	}

	// ── diagnostics ────────────────────────────────────────────────

	_warn( msg ) {

		this.ir.warnings.push( msg );

	}

	_warnUnknown( name ) {

		if ( this._warnedUnknown.has( name ) ) return;
		this._warnedUnknown.add( name );
		this._warn( `Unsupported directive ignored: ${name}` );

	}

}

/** Convenience: parse a string into IR with no Include support. */
export function parsePBRT( src, opts ) {

	return new PBRTParser( opts ).parse( src );

}
