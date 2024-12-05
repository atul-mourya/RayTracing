import { create } from 'zustand';

export const useStore = create( ( set ) => ( {
	selectedObject: null,
	setSelectedObject: ( object ) => set( { selectedObject: object } ),
	isLoading: false,
	setIsLoading: ( isLoading ) => set( { isLoading } ),
} ) );
