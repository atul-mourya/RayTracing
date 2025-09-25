import { useState, useCallback, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Save, X, Settings, Image as ImageIcon } from "lucide-react";
import { geminiImageGenerator } from '@/services/geminiApi';
import { aiResultsDB } from '@/services/indexedDB';
import { useStore } from '@/store';

const AITab = () => {

	const [ apiKey, setApiKey ] = useState( '' );
	const [ prompt, setPrompt ] = useState( '' );
	const [ isGenerating, setIsGenerating ] = useState( false );
	const [ generatedResult, setGeneratedResult ] = useState( null );
	const [ showApiKeyInput, setShowApiKeyInput ] = useState( false );
	const [ aiResults, setAiResults ] = useState( [] );

	// Get selected result from store (image selected in Results viewport)
	const selectedResult = useStore( useCallback( state => state.selectedResult, [] ) );

	useEffect( () => {

		// Load saved API key from localStorage
		const savedApiKey = localStorage.getItem( 'gemini_api_key' );
		if ( savedApiKey ) {

			setApiKey( savedApiKey );
			geminiImageGenerator.initialize( savedApiKey );

		} else {

			setShowApiKeyInput( true );

		}

		// Load saved AI results
		loadAIResults();

	}, [] );

	const loadAIResults = async () => {

		try {

			const results = await aiResultsDB.getAllAIResults();
			setAiResults( results.reverse() ); // Show newest first

		} catch ( error ) {

			console.error( 'Error loading AI results:', error );

		}

	};

	const handleApiKeySubmit = async () => {

		if ( ! apiKey.trim() ) return;

		const success = await geminiImageGenerator.initialize( apiKey );
		if ( success ) {

			localStorage.setItem( 'gemini_api_key', apiKey );
			setShowApiKeyInput( false );

		} else {

			alert( 'Failed to initialize Gemini API. Please check your API key.' );

		}

	};

	const handleGenerate = async () => {

		if ( ! prompt.trim() ) return;

		setIsGenerating( true );
		try {

			// Use selected result image from Results viewport
			const inputImage = selectedResult?.image || null;

			const result = await geminiImageGenerator.generateImage( prompt, inputImage );

			if ( result.success ) {

				setGeneratedResult( {
					prompt: prompt,
					result: result.imageUrl,
					text: result.text,
					inputImage: inputImage
				} );

			} else {

				// Handle different types of errors
				if ( result.quotaError ) {

					const retryMessage = result.retryAfter
						? `Please wait ${Math.ceil( result.retryAfter )} seconds before trying again.`
						: 'Please wait a few minutes before trying again.';

					alert( `Quota Limit Reached\n\n${result.message}\n\n${retryMessage}` );

				} else {

					alert( `Error: ${result.error}` );

				}

			}

		} catch ( error ) {

			console.error( 'Generation error:', error );
			alert( `Error: ${error.message}` );

		} finally {

			setIsGenerating( false );

		}

	};

	const handleSave = async () => {

		if ( ! generatedResult ) return;

		try {

			await aiResultsDB.saveAIResult(
				generatedResult.prompt,
				generatedResult.result,
				generatedResult.inputImage
			);

			// Refresh the results list
			await loadAIResults();

			// Clear the current result
			setGeneratedResult( null );
			setPrompt( '' );

		} catch ( error ) {

			console.error( 'Error saving result:', error );
			alert( 'Error saving result' );

		}

	};

	const handleDiscard = () => {

		setGeneratedResult( null );
		setPrompt( '' );

	};


	if ( showApiKeyInput ) {

		return (
			<div className="p-4 space-y-4">
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Settings size={20} />
							Gemini API Setup
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div>
							<Label htmlFor="apiKey">API Key</Label>
							<Input
								id="apiKey"
								type="password"
								value={apiKey}
								onChange={( e ) => setApiKey( e.target.value )}
								placeholder="Enter your Gemini API key"
							/>
							<p className="text-xs text-muted-foreground mt-1">
								Get your API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="underline">Google AI Studio</a>
							</p>
						</div>
						<Button onClick={handleApiKeySubmit} className="w-full">
							Initialize API
						</Button>
					</CardContent>
				</Card>
			</div>
		);

	}

	return (
		<>
			{/* Input Section */}
			<Card>
				<CardHeader className="p-3">
					<CardTitle className="text-sm">AI Image Generation</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2 p-3">
					{/* Selected Image from Results Viewport */}
					<div>
						<Label>Selected Image</Label>
						{selectedResult ? (
							<div className="mt-2">
								<img
									src={selectedResult.image}
									alt="Selected from Results"
									className="w-full h-32 object-cover rounded border"
								/>
								<p className="text-xs text-muted-foreground mt-1">
									Using selected image from Results viewport
								</p>
							</div>
						) : (
							<div className="mt-2 p-4 border-2 border-dashed border-muted-foreground/25 rounded text-center">
								<p className="text-sm text-muted-foreground">
									No image selected. Select an image in the Results viewport to use as input.
								</p>
							</div>
						)}
					</div>

					{/* Prompt Input */}
					<div>
						<Label htmlFor="prompt">Prompt</Label>
						<Textarea
							id="prompt"
							value={prompt}
							onChange={( e ) => setPrompt( e.target.value )}
							placeholder="Describe how you want to modify or enhance the image..."
							rows={3}
						/>
					</div>

					<Button
						onClick={handleGenerate}
						disabled={! prompt.trim() || isGenerating}
						className="w-full"
					>
						{isGenerating ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Generating...
							</>
						) : (
							<>
								<ImageIcon className="mr-2 h-4 w-4" />
								Generate
							</>
						)}
					</Button>
				</CardContent>
			</Card>

			{/* Generated Result */}
			{generatedResult && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Generated Result</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">

						{generatedResult.result && (
							<div>
								<img
									src={generatedResult.result}
									alt="Generated"
									className="w-full h-48 object-cover rounded border"
								/>
							</div>
						)}

						{generatedResult.text && (
							<div className="bg-muted/50 p-3 rounded">
								<p className="text-sm">{generatedResult.text}</p>
							</div>
						)}

						<div className="flex gap-2">
							<Button onClick={handleSave} variant="default" className="flex-1">
								<Save className="mr-2 h-4 w-4" />
								Save
							</Button>
							<Button onClick={handleDiscard} variant="outline" className="flex-1">
								<X className="mr-2 h-4 w-4" />
								Discard
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Saved Results */}
			{aiResults.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Saved Results</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-3">
							{aiResults.slice( 0, 5 ).map( ( result ) => (
								<div key={result.id} className="border rounded p-3 space-y-2">
									{result.result && (
										<img
											src={result.result}
											alt="Saved result"
											className="w-full h-24 object-cover rounded"
										/>
									)}
									<p className="text-sm text-muted-foreground">
										"{result.prompt}"
									</p>
									<p className="text-xs text-muted-foreground">
										{new Date( result.createdAt ).toLocaleDateString()}
									</p>
								</div>
							) )}
							{aiResults.length > 5 && (
								<p className="text-sm text-muted-foreground text-center">
									And {aiResults.length - 5} more results...
								</p>
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{/* API Key Management */}
			<div className="flex justify-center">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setShowApiKeyInput( true )}
				>
					<Settings className="mr-2 h-4 w-4" />
					Change API Key
				</Button>
			</div>
		</>
	);

};

export default AITab;
