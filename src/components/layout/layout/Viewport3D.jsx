/* eslint-disable react/prop-types */
import React, { useRef, useEffect, useState, useCallback } from 'react';
import PathTracerApp from '../../../engine/main';
import { Loader2, AlertCircle, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const Viewport3D = ({ onStatsUpdate }) => {
  const containerRef = useRef(null);
  const appRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (appRef.current) return;

    if (containerRef.current) {
      appRef.current = new PathTracerApp(containerRef.current);
      appRef.current.setOnStatsUpdate(onStatsUpdate);

      appRef.current.init().then(() => {
        setIsLoading(false);
      }).catch((err) => {
        console.error("Error initializing PathTracerApp:", err);
        setError("Failed to initialize 3D viewport. Please try refreshing the page.");
        setIsLoading(false);
      });
    }

    window.pathTracerApp = appRef.current;
  }, [onStatsUpdate]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.glb')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const arrayBuffer = event.target.result;
        if (appRef.current && appRef.current.loadGLBFromArrayBuffer) {
          appRef.current.loadGLBFromArrayBuffer(arrayBuffer)
            .catch((err) => {
              console.error("Error loading GLB file:", err);
              setError("Failed to load GLB file. Please try again.");
            });
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setError("Please drop a valid GLB file.");
    }
  }, []);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div 
      className={`relative w-full h-full ${isDragging ? 'bg-primary/10' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div ref={containerRef} className="w-full h-full" />
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center space-y-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-lg font-medium text-foreground">Loading...</p>
          </div>
        </div>
      )}
      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center space-y-4">
            <Upload className="h-16 w-16 text-primary" />
            <p className="text-xl font-medium text-foreground">Drop GLB file here</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(Viewport3D);