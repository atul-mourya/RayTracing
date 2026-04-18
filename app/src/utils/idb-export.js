// ─── EXPORT ──────────────────────────────────────────────────────────────────
// Paste this in the browser console to download a backup JSON file.

( async () => {

	const DATABASES = [
		{ name: 'RenderResultsDB', version: 2, stores: [ 'renders' ] },
		{ name: 'RayTracingAIResults', version: 1, stores: [ 'aiResults' ] },
	];
	const LS_KEYS = [ 'vite-ui-theme', 'rayzee-favorites', 'gemini_api_key' ];

	const openDB = ( name, version ) => new Promise( ( res, rej ) => {

		const req = indexedDB.open( name, version );
		req.onsuccess = () => res( req.result );
		req.onerror = () => rej( req.error );

	} );

	const readAll = ( db, store ) => new Promise( ( res, rej ) => {

		const req = db.transaction( store, 'readonly' ).objectStore( store ).getAll();
		req.onsuccess = () => res( req.result );
		req.onerror = () => rej( req.error );

	} );

	const backup = { version: 1, exportedAt: new Date().toISOString(), indexedDB: {}, localStorage: {} };

	for ( const { name, version, stores } of DATABASES ) {

		try {

			const db = await openDB( name, version );
			backup.indexedDB[ name ] = {};
			for ( const s of stores ) backup.indexedDB[ name ][ s ] = await readAll( db, s );
			db.close();
			console.log( `✓ ${name}` );

		} catch ( e ) {

			console.warn( `⚠ Skipped ${name}:`, e.message );

		}

	}

	for ( const k of LS_KEYS ) {

		const v = localStorage.getItem( k ); if ( v ) backup.localStorage[ k ] = v;

	}

	const json = JSON.stringify( backup, null, 2 );
	const blob = new Blob( [ json ], { type: 'application/json' } );
	const filename = `rayzee-backup-${new Date().toISOString().slice( 0, 19 ).replace( /[:.]/g, '-' )}.json`;

	if ( window.showSaveFilePicker ) {

		const handle = await window.showSaveFilePicker( { suggestedName: filename, types: [ { description: 'JSON', accept: { 'application/json': [ '.json' ] } } ] } );
		const writable = await handle.createWritable();
		await writable.write( blob );
		await writable.close();

	} else {

		// Fallback: open in new tab, then Cmd+S / Ctrl+S to save
		const url = URL.createObjectURL( blob );
		window.open( url, '_blank' );
		console.log( 'Opened in new tab — press Cmd+S / Ctrl+S to save' );

	}

	console.log( '✓ Done' );

} )();


// ─── IMPORT ──────────────────────────────────────────────────────────────────
// Paste this in the browser console to restore from a backup JSON file.

( async () => {

	const DATABASES = [
		{ name: 'RenderResultsDB', version: 2, stores: [ 'renders' ],
		  upgrade: db => {

		    if ( ! db.objectStoreNames.contains( 'renders' ) ) {

		      db.createObjectStore( 'renders', { keyPath: 'id', autoIncrement: true } )
		        .createIndex( 'timestamp', 'timestamp', { unique: false } );

				}

			}
		},
		{ name: 'RayTracingAIResults', version: 1, stores: [ 'aiResults' ],
		  upgrade: db => {

		    if ( ! db.objectStoreNames.contains( 'aiResults' ) ) {

		      const s = db.createObjectStore( 'aiResults', { keyPath: 'id', autoIncrement: true } );
		      s.createIndex( 'timestamp', 'timestamp', { unique: false } );
		      s.createIndex( 'prompt', 'prompt', { unique: false } );

				}

			}
		},
	];

	const file = await new Promise( res => {

		const i = Object.assign( document.createElement( 'input' ), { type: 'file', accept: '.json' } );
		i.onchange = () => res( i.files[ 0 ] ?? null );
		i.click();

	} );
	if ( ! file ) return console.log( 'No file selected' );

	const backup = JSON.parse( await file.text() );
	if ( backup.version !== 1 ) throw new Error( 'Unknown backup version: ' + backup.version );

	const openDB = ( { name, version, upgrade } ) => new Promise( ( res, rej ) => {

		const req = indexedDB.open( name, version );
		req.onupgradeneeded = e => upgrade( e.target.result );
		req.onsuccess = () => res( req.result );
		req.onerror = () => rej( req.error );

	} );

	for ( const dbDef of DATABASES ) {

		const dbData = backup.indexedDB?.[ dbDef.name ];
		if ( ! dbData ) continue;
		const db = await openDB( dbDef );
		for ( const storeName of dbDef.stores ) {

			const records = dbData[ storeName ];
			if ( ! records?.length ) continue;
			await new Promise( ( res, rej ) => {

				const tx = db.transaction( storeName, 'readwrite' );
				const store = tx.objectStore( storeName );
				for ( const r of records ) {

					const { id: _dropped, ...record } = r;
					store.add( record );

				}

				tx.oncomplete = res;
				tx.onerror = () => rej( tx.error );

			} );
			console.log( `✓ Restored ${records.length} records → ${dbDef.name}/${storeName}` );

		}

		db.close();

	}

	for ( const [ k, v ] of Object.entries( backup.localStorage ?? {} ) ) localStorage.setItem( k, v );
	console.log( '✓ Done — reloading…' );
	location.reload();

} )();
