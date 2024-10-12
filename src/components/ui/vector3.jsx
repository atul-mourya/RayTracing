/* eslint-disable react/prop-types */
import { useState } from "react";

const Vector3Component = ({ onValueChange, ...props }) => {
  const [vector, setVector] = useState(props.value || [0, 0, 0]);

  // Handle input change and notify parent
  const handleInputChange = (index) => (e) => {
    const value = parseFloat(e.target.value);
    const newVector = [...vector];
    newVector[index] = value;

    setVector(newVector);

    if (onValueChange) {
      onValueChange(newVector);
    }
  };

  return (
    <>
        <span className="opacity-50 text-xs truncate">{props.label}</span>
        <div className="flex space-x-1.5 items-center justify-between">
            {/* X component */}
            <div className="text-foreground">
                <span className="text-sm pr-1 text-red-500">X</span>
                <input
                type="number"
                value={vector[0]}
                onChange={handleInputChange(0)}
                className="pl-2 rounded-full w-14 h-full bg-input text-right"
                />
            </div>
            {/* Y component */}
            <div className="text-foreground">
                <span className="text-sm pr-1 text-green-500">Y</span>
                <input
                type="number"
                value={vector[1]}
                onChange={handleInputChange(1)}
                className="pl-2 rounded-full w-14 h-full bg-input text-right"
                />
            </div>
            {/* Z component */}
            <div className="text-foreground">
                <span className="text-sm pr-1 text-blue-500">Z</span>
                <input
                type="number"
                value={vector[2]}
                onChange={handleInputChange(2)}
                className="pl-2 rounded-full w-14 h-full bg-input text-right"
                />
            </div>
        </div>
    </>
  );
};

export { Vector3Component };