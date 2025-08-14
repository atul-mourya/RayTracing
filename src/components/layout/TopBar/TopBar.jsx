import { useMemo, useCallback, lazy, Suspense } from 'react';
import { useStore, usePathTracerStore } from '@/store';
import AuthProvider from './AuthProvider';
import MenuBar from './MenuBar';
import ViewportTabs from './ViewportTabs';
import ActionBar from './ActionBar';
import { useImportUrl } from '@/hooks/use-import-url';

// Lazy load the ImportUrlModal since it's only used when opening import dialog
const ImportUrlModal = lazy( () => import( './ImportUrlModal' ) );

// Loading fallback for modal
const ModalLoadingFallback = () => (
	<div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center">
		<div className="bg-background rounded-lg p-6 shadow-lg">
			<div className="flex items-center space-x-3">
				<div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full"></div>
				<span className="text-sm">Loading...</span>
			</div>
		</div>
	</div>
);

const TopBar = () => {

	// Optimized store subscriptions - only subscribe to what we need
	const appMode = useStore( useCallback( state => state.appMode, [] ) );
	const setAppMode = useStore( useCallback( state => state.setAppMode, [] ) );

	// Access the path tracer mode change handler
	const handleModeChange = usePathTracerStore( useCallback( state => state.handleModeChange, [] ) );

	// Use custom hooks
	const {
		modalState,
		openImportModal,
		closeImportModal,
		setImportUrl,
		handleImportFromUrl
	} = useImportUrl();

	// Handle tab change
	const handleTabChange = useCallback( ( value ) => {

		// Only update if value has changed
		if ( value !== appMode ) {

			handleModeChange( value );
			setAppMode( value );

		}

	}, [ appMode, setAppMode, handleModeChange ] );

	// Handle GitHub redirect
	const handleGithubRedirection = useCallback( () => {

		window.open( 'https://github.com/atul-mourya/RayTracing', '_blank' );

	}, [] );

	// Memoize the logo
	const logo = useMemo( () => (
		<div className="flex items-center space-x-2 mr-4 px-2">
			<span className="font-semibold">Rayzee</span>
		</div>
	), [] );

	return (
		<AuthProvider>
			{ ( { user, handleLoginClick, handleSignOut } ) => (
				<div className="flex items-center h-10 border-b">
					{logo}
					<MenuBar onOpenImportModal={openImportModal} />

					<div className="grow" />
					<ViewportTabs currentMode={appMode} onModeChange={handleTabChange} />
					<div className="grow" />

					<ActionBar
						user={user}
						onLoginClick={handleLoginClick}
						onSignOut={handleSignOut}
						onGithubClick={handleGithubRedirection}
					/>

					<Suspense fallback={<ModalLoadingFallback />}>
						<ImportUrlModal
							isOpen={modalState.isImportModalOpen}
							onClose={closeImportModal}
							importUrl={modalState.importUrl}
							setImportUrl={setImportUrl}
							onImport={handleImportFromUrl}
							isImporting={modalState.isImporting}
						/>
					</Suspense>
				</div>
			) }
		</AuthProvider>
	);

};

export default TopBar;
