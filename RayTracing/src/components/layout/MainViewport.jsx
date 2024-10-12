import { useState } from 'react';
import Viewport3D from './Viewport3D';
import { DEFAULT_STATE } from '@/engine/Processor/Constants';

const MainViewport = () => {
  const [stats, setStats] = useState({ timeElapsed: 0, samples: 0 });
  const [maxSamples, setMaxSamples] = useState(DEFAULT_STATE.maxSamples);
  const [isEditing, setIsEditing] = useState(false); // Track if maxSamples is being edited
  const [inputValue, setInputValue] = useState(maxSamples); // Local state for editing

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };

  const handleInputBlur = () => {
    setIsEditing(false);
    if (inputValue !== maxSamples) {
      const value = Number(inputValue);
      setMaxSamples(value); // Update maxSamples if the value changed
    if (window.pathTracerApp) {
      window.pathTracerApp.pathTracingPass.material.uniforms.maxFrames.value = value;
      window.pathTracerApp.reset();
    }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleInputBlur();
    }
  };

  return (
    <div className="flex flex-1">
      <div className="flex-1 relative">
        <Viewport3D onStatsUpdate={setStats} />
        <div className="absolute top-2 left-2 text-sm text-white bg-black bg-opacity-50 p-2 rounded">
          Time: {stats.timeElapsed.toFixed(2)}s | Samples: {stats.samples} /{' '}
          {isEditing ? (
            <input
              className="bg-transparent border-b border-white text-white w-12"
              type="number"
              value={inputValue}
              onChange={handleInputChange}
              onBlur={handleInputBlur}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          ) : (
            <span onClick={handleEditClick} className="cursor-pointer border-b border-dotted border-white group-hover:border-blue-400 transition-colors duration-300">
              {maxSamples}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default MainViewport;
