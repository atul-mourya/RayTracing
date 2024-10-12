import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HDR_FILES } from '../../../../engine/Processor/Constants';

const HDRImageSelector = ({ selectedEnvironment, onEnvironmentChange }) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleImageSelect = (index) => {
    onEnvironmentChange(index.toString());
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <Button 
        onClick={() => setIsOpen(!isOpen)} 
        variant="outline" 
        className="w-full justify-between"
      >
        {HDR_FILES[selectedEnvironment].name}
        <ChevronDown className="ml-2 h-4 w-4" />
      </Button>
      {isOpen && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-auto">
          {HDR_FILES.map((hdr, index) => (
            <div
              key={hdr.name}
              className="flex items-center p-2 hover:bg-gray-100 cursor-pointer"
              onClick={() => handleImageSelect(index)}
            >
              <img
                src={`/path/to/${hdr.name}.jpg`}
                alt={hdr.name}
                className="w-12 h-12 object-cover rounded mr-2"
              />
              <span>{hdr.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default HDRImageSelector;