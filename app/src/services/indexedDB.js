class AIResultsDB {

	constructor() {

		this.dbName = 'RayTracingAIResults';
		this.version = 1;
		this.storeName = 'aiResults';
		this.db = null;

	}

	async init() {

		return new Promise( ( resolve, reject ) => {

			const request = indexedDB.open( this.dbName, this.version );

			request.onerror = () => reject( request.error );
			request.onsuccess = () => {

				this.db = request.result;
				resolve();

			};

			request.onupgradeneeded = ( event ) => {

				const db = event.target.result;

				// Create object store if it doesn't exist
				if ( ! db.objectStoreNames.contains( this.storeName ) ) {

					const store = db.createObjectStore( this.storeName, {
						keyPath: 'id',
						autoIncrement: true
					} );

					// Create indexes
					store.createIndex( 'timestamp', 'timestamp', { unique: false } );
					store.createIndex( 'prompt', 'prompt', { unique: false } );

				}

			};

		} );

	}

	async saveAIResult( prompt, resultImage, inputImage = null ) {

		if ( ! this.db ) await this.init();

		const transaction = this.db.transaction( [ this.storeName ], 'readwrite' );
		const store = transaction.objectStore( this.storeName );

		const aiResult = {
			prompt: prompt,
			result: resultImage,
			inputImage: inputImage,
			timestamp: Date.now(),
			createdAt: new Date().toISOString()
		};

		return new Promise( ( resolve, reject ) => {

			const request = store.add( aiResult );
			request.onsuccess = () => resolve( request.result );
			request.onerror = () => reject( request.error );

		} );

	}

	async getAllAIResults() {

		if ( ! this.db ) await this.init();

		const transaction = this.db.transaction( [ this.storeName ], 'readonly' );
		const store = transaction.objectStore( this.storeName );

		return new Promise( ( resolve, reject ) => {

			const request = store.getAll();
			request.onsuccess = () => resolve( request.result );
			request.onerror = () => reject( request.error );

		} );

	}

	async deleteAIResult( id ) {

		if ( ! this.db ) await this.init();

		const transaction = this.db.transaction( [ this.storeName ], 'readwrite' );
		const store = transaction.objectStore( this.storeName );

		return new Promise( ( resolve, reject ) => {

			const request = store.delete( id );
			request.onsuccess = () => resolve();
			request.onerror = () => reject( request.error );

		} );

	}

	async clearAllAIResults() {

		if ( ! this.db ) await this.init();

		const transaction = this.db.transaction( [ this.storeName ], 'readwrite' );
		const store = transaction.objectStore( this.storeName );

		return new Promise( ( resolve, reject ) => {

			const request = store.clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject( request.error );

		} );

	}

}

export const aiResultsDB = new AIResultsDB();
