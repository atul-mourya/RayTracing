/**
 * Tokenizer for the pbrt-v4 scene description grammar.
 *
 * pbrt files are a flat stream of directives. Lexically there are only four
 * things to recognize:
 *   - quoted strings:  "perspective", "float fov"
 *   - numbers:         1, -2.5, 1e-3, .5
 *   - brackets:        [ ]   (array delimiters)
 *   - bare words:      WorldBegin, Shape, true, false  (directives / bools)
 * Comments run from '#' to end of line.
 *
 * Pure JS, no Three.js — keeps it unit-testable in node.
 */

export const TokenType = {
	STRING: 'string', // quoted string, quotes stripped
	NUMBER: 'number', // numeric literal, already parsed to Number
	WORD: 'word', // bare identifier (directive name, true/false)
	LBRACKET: '[',
	RBRACKET: ']'
};

const isWhitespace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
// A number can start with: digit / ".5" / "-1" / "-.5" / "+.5".
const isDigit = c => c >= '0' && c <= '9';
const isNumberStart = ( c, next, next2 ) => {

	if ( isDigit( c ) ) return true;
	if ( c === '.' && isDigit( next ) ) return true;
	if ( c === '-' || c === '+' ) {

		if ( isDigit( next ) ) return true;
		if ( next === '.' && isDigit( next2 ) ) return true;

	}

	return false;

};

/**
 * Tokenize a pbrt source string.
 * @param {string} src
 * @returns {Array<{type: string, value?: string|number}>}
 */
export function tokenize( src ) {

	const tokens = [];
	const n = src.length;
	let i = 0;

	while ( i < n ) {

		const c = src[ i ];

		// Whitespace
		if ( isWhitespace( c ) ) {

			i ++;
			continue;

		}

		// Comment to end of line
		if ( c === '#' ) {

			while ( i < n && src[ i ] !== '\n' ) i ++;
			continue;

		}

		// Brackets
		if ( c === '[' ) {

			tokens.push( { type: TokenType.LBRACKET } );
			i ++;
			continue;

		}

		if ( c === ']' ) {

			tokens.push( { type: TokenType.RBRACKET } );
			i ++;
			continue;

		}

		// Quoted string
		if ( c === '"' ) {

			i ++; // skip opening quote
			let start = i;
			while ( i < n && src[ i ] !== '"' ) i ++;
			if ( i >= n ) throw new Error( 'PBRT tokenizer: unterminated string literal' );
			tokens.push( { type: TokenType.STRING, value: src.slice( start, i ) } );
			i ++; // skip closing quote
			continue;

		}

		// Number
		if ( isNumberStart( c, src[ i + 1 ], src[ i + 2 ] ) ) {

			let start = i;
			i ++;
			while ( i < n ) {

				const ch = src[ i ];
				if ( ( ch >= '0' && ch <= '9' ) || ch === '.' || ch === 'e' || ch === 'E' ||
					ch === '-' || ch === '+' ) {

					i ++;

				} else break;

			}

			const text = src.slice( start, i );
			const num = Number( text );
			if ( Number.isNaN( num ) ) throw new Error( `PBRT tokenizer: invalid number "${text}"` );
			tokens.push( { type: TokenType.NUMBER, value: num } );
			continue;

		}

		// Bare word (directive, true/false, etc.)
		{

			let start = i;
			while ( i < n && ! isWhitespace( src[ i ] ) && src[ i ] !== '"' &&
				src[ i ] !== '[' && src[ i ] !== ']' && src[ i ] !== '#' ) i ++;
			tokens.push( { type: TokenType.WORD, value: src.slice( start, i ) } );

		}

	}

	return tokens;

}
