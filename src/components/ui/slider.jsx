/* eslint-disable react/prop-types */
import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";

const Slider = React.forwardRef(({ className, icon: Icon, ...props }, ref) => {
  const [isEditing, setIsEditing] = React.useState(false);
  const [inputValue, setInputValue] = React.useState(props.value);

  const handleEditClick = (e) => {
    e.stopPropagation(); // Prevent slider change when clicking on the value
    setIsEditing(true);
  };

  const handleInputBlur = () => {
    setIsEditing(false);
    if (inputValue !== props.value) {
      props.onValueChange(inputValue); // Ensure this triggers a prop update
    }
  };

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      handleInputBlur();
    }
  };

  return (
    <>
      <span className="opacity-50 text-xs truncate">{props.label}</span>
      <SliderPrimitive.Root
        ref={ref}
        className={cn("relative flex h-5 w-full touch-none select-none items-center max-w-32", className)}
        {...props}
      >
        <SliderPrimitive.Track className="relative h-full w-full grow overflow-hidden rounded-full bg-primary/20">
          {Icon && (
            <div className="absolute h-full left-1 inline-flex justify-start items-center">
              <Icon size={12} className="z-10" />
            </div>
          )}
          <SliderPrimitive.Range className="absolute h-full bg-primary" />
        </SliderPrimitive.Track>

        {/* Editable value */}
        {isEditing ? (
          <input
            className="text-xs absolute h-full text-right cursor-text text-foreground inline-flex items-center bg-transparent"
            type="number"
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        ) : (
          <span
            className="text-xs absolute h-full right-2 cursor-text text-foreground inline-flex items-center"
            onClick={handleEditClick}
          >
            {props.value}
          </span>
        )}
      </SliderPrimitive.Root>
    </>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
