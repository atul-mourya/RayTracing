import { useMemo, useCallback } from 'react';
import { Menu } from 'lucide-react';
import { useStore, usePathTracerStore } from '@/store';
import AuthProvider from './AuthProvider';
import MenuBar from './MenuBar';
import ViewportTabs from './ViewportTabs';
import ActionBar from './ActionBar';
import ImportUrlModal from './ImportUrlModal';
import { useImportUrl } from '@/hooks/use-import-url';

const TopBar = () => {

	// Get the store values and actions
	const appMode = useStore( state => state.appMode );
	const setAppMode = useStore( state => state.setAppMode );

	// Access the path tracer mode change handler
	const handleModeChange = usePathTracerStore( state => state.handleModeChange );

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

					<ImportUrlModal
						isOpen={modalState.isImportModalOpen}
						onClose={closeImportModal}
						importUrl={modalState.importUrl}
						setImportUrl={setImportUrl}
						onImport={handleImportFromUrl}
						isImporting={modalState.isImporting}
					/>
				</div>
			) }
		</AuthProvider>
	);

};

export default TopBar;
