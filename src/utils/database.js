// database.js
const DB_NAME = 'RenderResultsDB';
const DB_VERSION = 1;
const STORE_NAME = 'renders';

// Single instance of DB connection to avoid multiple open requests
let dbInstance = null;
let dbInitPromise = null;

/**
 * Initialize and open the database, ensuring schema is correct
 * This should be called once at app startup
 */
export const initDatabase = () => {

	if ( ! dbInitPromise ) {

		dbInitPromise = new Promise( ( resolve, reject ) => {

			// Check if IndexedDB is supported
			if ( ! window.indexedDB ) {

				console.error( "Your browser doesn't support IndexedDB" );
				reject( "IndexedDB not supported" );
				return;

			}

			console.log( "Opening database to load previous renders..." );
			const openRequest = indexedDB.open( DB_NAME, DB_VERSION );

			openRequest.onupgradeneeded = ( event ) => {

				console.log( "Database upgrade needed, creating schema" );
				const db = event.target.result;

				// Create object store if it doesn't exist
				if ( ! db.objectStoreNames.contains( STORE_NAME ) ) {

					const objectStore = db.createObjectStore( STORE_NAME, {
						keyPath: 'id',
						autoIncrement: true
					} );

					// Create indices
					objectStore.createIndex( 'timestamp', 'timestamp', { unique: false } );
					console.log( "Created object store and indices" );

				}

			};

			openRequest.onsuccess = ( event ) => {

				console.log( "Database opened successfully" );
				dbInstance = event.target.result;

				// Check if the expected store exists
				if ( ! dbInstance.objectStoreNames.contains( STORE_NAME ) ) {

					console.warn( "Database opened but the renders store is missing. Recreating the database..." );
					dbInstance.close();

					// Recreate the database with a new version to force schema update
					const newVersion = DB_VERSION + 1;
					console.log( `Reopening database with new version ${newVersion}` );

					const reopenRequest = indexedDB.open( DB_NAME, newVersion );

					reopenRequest.onupgradeneeded = ( event ) => {

						console.log( "Recreating database schema" );
						const db = event.target.result;

						// Create the store
						const objectStore = db.createObjectStore( STORE_NAME, {
							keyPath: 'id',
							autoIncrement: true
						} );

						// Create indices
						objectStore.createIndex( 'timestamp', 'timestamp', { unique: false } );
						console.log( "Recreated object store and indices" );

					};

					reopenRequest.onsuccess = ( event ) => {

						console.log( "Database reopened successfully" );
						dbInstance = event.target.result;
						resolve( dbInstance );

					};

					reopenRequest.onerror = ( event ) => {

						console.error( "Error reopening database:", event.target.error );
						reject( event.target.error );

					};

				} else {

					console.log( "Database structure verified, ready to use" );
					resolve( dbInstance );

				}

			};

			openRequest.onerror = ( event ) => {

				console.error( "Error opening database:", event.target.error );
				reject( event.target.error );

			};

		} );

	}

	return dbInitPromise;

};

/**
 * Get the database instance, initializing if necessary
 */
export const getDatabase = async () => {

	if ( dbInstance ) {

		return dbInstance;

	}

	return initDatabase();

};

/**
 * Save a rendered image to the database
 */
export const saveRender = async ( imageData ) => {

	try {

		const db = await getDatabase();

		return new Promise( ( resolve, reject ) => {

			// Create a new transaction for this operation
			const transaction = db.transaction( STORE_NAME, 'readwrite' );
			const store = transaction.objectStore( STORE_NAME );

			// Add the new render to the store
			const request = store.add( {
				image: imageData,
				colorCorrection: {
					brightness: 0,
					contrast: 0,
					saturation: 0,
					hue: 0,
					exposure: 0,
			 	},
				timestamp: new Date(),
				isEdited: false,
			} );

			request.onsuccess = () => {

				console.log( "Render saved with ID:", request.result );
				resolve( request.result );

			};

			request.onerror = ( event ) => {

				console.error( "Error saving render:", event.target.error );
				reject( event.target.error );

			};

			transaction.oncomplete = () => {

				console.log( 'Transaction completed successfully' );

			};

			transaction.onerror = ( event ) => {

				console.error( 'Transaction error:', event.target.error );
				reject( event.target.error );

			};

		} );

	} catch ( error ) {

		console.error( 'Error in saveRender:', error );
		throw error;

	}

};

/**
 * Get all renders from the database
 */
export const getAllRenders = async () => {

	try {

		const db = await getDatabase();

		return new Promise( ( resolve, reject ) => {

			const transaction = db.transaction( STORE_NAME, 'readonly' );
			const store = transaction.objectStore( STORE_NAME );

			// Get all records and sort by timestamp (newest first)
			const request = store.getAll();

			request.onsuccess = () => {

				const results = request.result;
				console.log( `Retrieved ${results.length} renders from database` );

				// Check for data integrity and sort by timestamp (newest first)
				if ( results && results.length > 0 ) {

					// Log the first result for debugging
					if ( results[ 0 ] ) {

						console.log( 'Sample render data:', {
							hasImage: Boolean( results[ 0 ].image ),
							imageType: typeof results[ 0 ].image,
							imageLength: typeof results[ 0 ].image === 'string' ? results[ 0 ].image.length : 'N/A',
							hasTimestamp: Boolean( results[ 0 ].timestamp ),
							timestamp: results[ 0 ].timestamp ? new Date( results[ 0 ].timestamp ).toISOString() : 'N/A'
						} );

					}

					// Sort by timestamp (newest first)
					const sortedResults = results
						.filter( item => item && item.image && item.timestamp )
						.sort( ( a, b ) => new Date( b.timestamp ) - new Date( a.timestamp ) );

					console.log( `After filtering and sorting: ${sortedResults.length} renders` );
					resolve( sortedResults );

				} else {

					console.log( 'No renders found in database' );
					resolve( [] );

				}

			};

			request.onerror = ( event ) => {

				console.error( "Error getting renders:", event.target.error );
				reject( event.target.error );

			};

			transaction.onerror = ( event ) => {

				console.error( "Transaction error in getAllRenders:", event.target.error );
				reject( event.target.error );

			};

		} );

	} catch ( error ) {

		console.error( 'Error in getAllRenders:', error );
		return [];

	}

};
// Add this function to your database.js file

/**
 * Delete a render from the database by ID
 */
export const deleteRender = async ( id ) => {

	try {

	  const db = await getDatabase();

	  return new Promise( ( resolve, reject ) => {

			const transaction = db.transaction( STORE_NAME, 'readwrite' );
			const store = transaction.objectStore( STORE_NAME );

			// Delete the render with the given ID
			const request = store.delete( id );

			request.onsuccess = () => {

		  console.log( `Render with ID ${id} deleted successfully` );
		  resolve( true );

			};

			request.onerror = ( event ) => {

		  console.error( `Error deleting render with ID ${id}:`, event.target.error );
		  reject( event.target.error );

			};

			transaction.oncomplete = () => {

		  console.log( 'Delete transaction completed successfully' );

			};

			transaction.onerror = ( event ) => {

		  console.error( 'Delete transaction error:', event.target.error );
		  reject( event.target.error );

			};

		} );

	} catch ( error ) {

	  console.error( 'Error in deleteRender:', error );
	  throw error;

	}

};
