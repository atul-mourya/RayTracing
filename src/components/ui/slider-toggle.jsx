/* eslint-disable react/prop-types */
import { forwardRef, useState } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Power, PowerOff } from "lucide-react";

const SliderToggle = forwardRef(({ className, enabled, icon: Icon, onToggleChange, ...props }, ref) => {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(props.value);
  const [isPowerOn, setIsPowerOn] = useState(enabled);

  const handleEditClick = (e) => {
    e.stopPropagation();
    setIsEditing(true);
  };

  const handleInputBlur = () => {
    setIsEditing(false);
    if (inputValue !== props.value) {
      props.onValueChange(inputValue);
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

  const togglePower = () => {
    setIsPowerOn(!isPowerOn);
    onToggleChange(!isPowerOn);
  };

  return (
    <>
      <span className="opacity-50 text-xs truncate">{props.label}</span>
      <span className="flex items-center max-w-32 w-full justify-end">
        <div className="relative flex h-5 w-full overflow-hidden">
          <div
            className={cn(
              "absolute inset-0 transition-transform duration-300 ease-in-out",
              isPowerOn ? "translate-x-0" : "translate-x-full"
            )}
          >
            <SliderPrimitive.Root
              ref={ref}
              className={cn(
                "relative flex h-5 w-full touch-none select-none items-center",
                className
              )}
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
          </div>
        </div>
        <Button className="h-full px-1 py-1 text-xs rounded-full ml-2" onClick={togglePower}>
          {isPowerOn ? <Power size={12} className="text-foreground"/> : <PowerOff size={12} className="text-secondary"/>}
        </Button>
      </span>
    </>
  );
});

SliderToggle.displayName = SliderPrimitive.Root.displayName;

export { SliderToggle };