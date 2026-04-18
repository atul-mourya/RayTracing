import { useCallback } from 'react';
import { useLocalStorage } from '@uidotdev/usehooks';

const MAX_RECENT_SEARCHES = 10;

/**
 * Custom hook for managing recent search history
 * @param {string} catalogType - Type of catalog (models, materials, environments, etc.)
 * @returns {Object} Recent searches state and handlers
 */
export const useRecentSearches = ( catalogType = 'default' ) => {

	const [ recentSearches, setRecentSearches ] = useLocalStorage( `raytracer-recent-searches-${catalogType}`, [] );

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

			return updated;

		} );

	}, [ setRecentSearches ] );

	// Remove a specific search term
	const removeRecentSearch = useCallback( ( searchTerm ) => {

		setRecentSearches( ( prev ) => prev.filter( term => term !== searchTerm ) );

	}, [ setRecentSearches ] );

	// Clear all recent searches
	const clearRecentSearches = useCallback( () => {

		setRecentSearches( [] );

	}, [ setRecentSearches ] );

	return {
		recentSearches,
		addRecentSearch,
		removeRecentSearch,
		clearRecentSearches,
		hasRecentSearches: recentSearches.length > 0
	};

};
