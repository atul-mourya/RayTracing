import { useEffect } from 'react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEnvironmentStore } from '@/store';

// Proxy URL for Poly Haven API requests
const PROXY_URL = 'https://api.polyhaven.com';

const EnvironmentCatalog = ( { value, onValueChange } ) => {

	const { toast } = useToast();
	const {
		apiData,
		environments,
		isLoading,
		error,
		selectedResolution,
		setApiData,
		setEnvironments,
		setIsLoading,
		setError,
		setSelectedResolution,
	} = useEnvironmentStore();

	useEffect( () => {

		const fetchEnvironments = async () => {

			try {

				// First, get list of HDRIs
				const response = await fetch( `${PROXY_URL}/assets?t=hdris` );
				const data = await response.json();
				setApiData( data ); // Store the API response

				// Transform the data into the format expected by ItemsCatalog
				const formattedData = Object.entries( data ).map( ( [ id, info ] ) => ( {
					id,
					name: info.name,
					preview: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?height=170`,
					category: info.categories,
					tags: info.tags,
					redirection: `https://polyhaven.com/a/${id}`,
					url: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${selectedResolution}/${id}_${selectedResolution}.hdr`
				} ) );

				// Add placeholder with proper preview SVG
				const placeholder = {
					id: 'custom-upload',
					name: 'Upload Custom HDRI',
					// Create an embedded SVG for the preview that includes both icon and text
					preview: `data:image/svg+xml;charset=utf-8,${encodeURIComponent( `
                        <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 100 100">
                            <rect width="98%" height="98%" x="1" y="1" fill="transparent" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4" rx="4"/>
                            <g transform="translate(50,50)">
                                <path transform="translate(-12,-12)" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5l5-5l5 5m-5-5v12" 
                                fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" 
                                stroke-linejoin="round"/>
                            </g>
                        </svg>
                    ` )}`,
					category: [],
					tags: [],
					redirection: '',
					url: ''
				};

				setEnvironments( [ placeholder, ...formattedData ] );
				setIsLoading( false );

			} catch ( error ) {

				console.error( 'Error fetching environments:', error );
				setError( 'Failed to load environments. Please try again later.' );
				toast( {
					title: "Error Loading Environments",
					description: "Failed to fetch environment data from API",
					variant: "destructive",
				} );
				setIsLoading( false );

			}

		};

		if ( ! apiData ) {

			fetchEnvironments();

		} else {

			// Use stored API data to format environments
			const formattedData = Object.entries( apiData ).map( ( [ id, info ] ) => ( {
				id,
				name: info.name,
				preview: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?height=170`,
				category: info.categories,
				tags: info.tags,
				redirection: `https://polyhaven.com/a/${id}`,
				url: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${selectedResolution}/${id}_${selectedResolution}.hdr`
			} ) );

			// Add placeholder with proper preview SVG
			const placeholder = {
				id: 'custom-upload',
				name: 'Upload Custom HDRI',
				// Create an embedded SVG for the preview that includes both icon and text
				preview: `data:image/svg+xml;charset=utf-8,${encodeURIComponent( `
                    <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 100 100">
                        <rect width="98%" height="98%" x="1" y="1" fill="transparent" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4" rx="4"/>
                        <g transform="translate(50,50)">
                            <path transform="translate(-12,-12)" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5l5-5l5 5m-5-5v12" 
                            fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" 
                            stroke-linejoin="round"/>
                        </g>
                    </svg>
                ` )}`,
				category: [],
				tags: [],
				redirection: '',
				url: ''
			};

			setEnvironments( [ placeholder, ...formattedData ] );
			setIsLoading( false );

		}

	}, [ toast, selectedResolution, apiData ] );

	const handleEnvironmentChange = ( index ) => {

		const selectedEnvironment = environments[ parseInt( index ) ];
		if ( selectedEnvironment ) {

			if ( selectedEnvironment.id === 'custom-upload' ) {

				const input = document.createElement( 'input' );
				input.type = 'file';
				input.accept = '.hdr,.exr,.png,.jpeg,.jpg,.webp';
				input.onchange = ( event ) => {

					const file = event.target.files[ 0 ];
					if ( file ) {

						const url = URL.createObjectURL( file );

						// Store the file information for reference when loading
						window.uploadedEnvironmentFileInfo = {
							name: file.name,
							type: file.type,
							size: file.size
						};

						const customEnv = {
							id: 'custom-upload',
							name: file.name,
							preview: null,
							category: [],
							tags: [],
							redirection: '',
							url: url
						};
						onValueChange( customEnv );

					}

				};

				input.click();

			} else {

				onValueChange( selectedEnvironment );

			}

		}

	};

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center justify-between p-2">
				<Select value={selectedResolution} onValueChange={setSelectedResolution}>
					<span className="opacity-50 text-xs truncate">Resolution</span>
					<SelectTrigger className="max-w-24 h-5 rounded-full">
						<SelectValue placeholder="Select resolution" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="1k">1K</SelectItem>
						<SelectItem value="2k">2K</SelectItem>
						<SelectItem value="4k">4K</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div className="flex-1">
				<ItemsCatalog
					data={environments}
					value={value}
					onValueChange={handleEnvironmentChange}
					isLoading={isLoading}
					error={error}
				/>
			</div>
		</div>
	);

};

export { EnvironmentCatalog };
