import { useState, useEffect } from 'react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Proxy URL for Poly Haven API requests
const PROXY_URL = 'https://api.polyhaven.com';

const EnvironmentCatalog = ( { value, onValueChange } ) => {

	const [ environments, setEnvironments ] = useState( [] );
	const [ isLoading, setIsLoading ] = useState( true );
	const [ error, setError ] = useState( null );
	const [ selectedResolution, setSelectedResolution ] = useState( '1k' );
	const { toast } = useToast();

	useEffect( () => {

		const fetchEnvironments = async () => {

			try {

				// First, get list of HDRIs
				const response = await fetch( `${PROXY_URL}/assets?t=hdris` );
				const data = await response.json();

				// Transform the data into the format expected by ItemsCatalog
				const formattedData = Object.entries( data ).map( ( [ id, info ] ) => ( {
					id,
					name: info.name,
					// Use their CDN for thumbnails
					preview: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?height=170`,
					category: info.categories,
					tags: info.tags,
					redirection: `https://polyhaven.com/a/${id}`,
					// Construct HDR URL using their CDN
					url: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${selectedResolution}/${id}_${selectedResolution}.hdr`
				} ) );

				setEnvironments( formattedData );
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

		fetchEnvironments();

	}, [ toast, selectedResolution ] );

	const handleEnvironmentChange = ( index ) => {

		const selectedEnvironment = environments[ parseInt( index ) ];
		if ( selectedEnvironment ) {

			// Pass the full environment data to parent
			onValueChange( selectedEnvironment );

		}

	};

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center justify-between p-2">
				<Select value={selectedResolution} onValueChange={setSelectedResolution}>
					<span className="opacity-50 text-xs truncate">Resolution</span>
					<SelectTrigger className="max-w-24 h-5 rounded-full" >
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
