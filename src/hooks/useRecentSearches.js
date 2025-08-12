import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'raytracer-recent-searches';
const MAX_RECENT_SEARCHES = 10;

/**
 * Custom hook for managing recent search history
 * @param {string} catalogType - Type of catalog (models, materials, environments, etc.)
 * @returns {Object} Recent searches state and handlers
 */
export const useRecentSearches = ( catalogType = 'default' ) => {

	const [ recentSearches, setRecentSearches ] = useState( [] );

	// Load recent searches from localStorage on mount
	useEffect( () => {

		const loadRecentSearches = () => {

			try {

				const stored = localStorage.getItem( `${STORAGE_KEY}-${catalogType}` );
				if ( stored ) {

					const parsed = JSON.parse( stored );
					if ( Array.isArray( parsed ) ) {

						setRecentSearches( parsed );

					}

				}

			} catch ( error ) {

				console.warn( 'Failed to load recent searches:', error );

			}

		};

		loadRecentSearches();

	}, [ catalogType ] );

	// Save recent searches to localStorage
	const saveToStorage = useCallback( ( searches ) => {

		try {

			localStorage.setItem( `${STORAGE_KEY}-${catalogType}`, JSON.stringify( searches ) );

		} catch ( error ) {

			console.warn( 'Failed to save recent searches:', error );

		}

	}, [ catalogType ] );

	// Add a new search term to recent searches
	const addRecentSearch = useCallback( ( searchTerm ) => {

		if ( ! searchTerm || searchTerm.trim().length < 2 ) {

			return;

		}

		const trimmedTerm = searchTerm.trim();

		setRecentSearches( ( prev ) => {

			// Check if we already have a very similar or longer search term
			const existingSimilar = prev.find( existing => {

				const lower = existing.toLowerCase();
				const newLower = trimmedTerm.toLowerCase();

				// Don't add if exact match exists
				if ( lower === newLower ) return true;

				// Don't add if we already have a longer version of this search
				if ( lower.includes( newLower ) && lower.length > newLower.length ) return true;

				return false;

			} );

			if ( existingSimilar ) {

				return prev; // Don't add duplicate or shorter version

			}

			// Remove any shorter versions of this search
			const filtered = prev.filter( existing => {

				const lower = existing.toLowerCase();
				const newLower = trimmedTerm.toLowerCase();

				// Remove if the new search is longer and contains the existing one
				return ! ( newLower.includes( lower ) && newLower.length > lower.length );

			} );

			// Add to beginning
			const updated = [ trimmedTerm, ...filtered ].slice( 0, MAX_RECENT_SEARCHES );

			// Save to storage
			saveToStorage( updated );

			return updated;

		} );

	}, [ saveToStorage ] );

	// Remove a specific search term
	const removeRecentSearch = useCallback( ( searchTerm ) => {

		setRecentSearches( ( prev ) => {

			const updated = prev.filter( term => term !== searchTerm );
			saveToStorage( updated );
			return updated;

		} );

	}, [ saveToStorage ] );

	// Clear all recent searches
	const clearRecentSearches = useCallback( () => {

		setRecentSearches( [] );
		saveToStorage( [] );

	}, [ saveToStorage ] );

	return {
		recentSearches,
		addRecentSearch,
		removeRecentSearch,
		clearRecentSearches,
		hasRecentSearches: recentSearches.length > 0
	};

};
