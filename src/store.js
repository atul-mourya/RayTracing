import { create } from 'zustand';

export const useStore = create( ( set ) => ( {
	selectedObject: null,
	setSelectedObject: ( object ) => set( { selectedObject: object } ),
	loading: { isLoading: false, progress: 0, title: '', status: '' },
	setLoading: ( loadingState ) => set( ( state ) => ( { loading: { ...state.loading, ...loadingState } } ) ),
	resetLoading: () => set( { loading: { isLoading: false, progress: 0, title: '', status: '' } } ),
} ) );

