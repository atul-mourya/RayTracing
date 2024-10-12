/* eslint-disable react/prop-types */
import { useState, useEffect } from 'react';
import { Menu, Play, Pause, Save, FolderOpen, Undo, Redo, Copy, ClipboardPaste, ZoomIn, ZoomOut, Focus } from 'lucide-react';
import { ThemeToggle } from '../theme-toggle';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

const TopBar = () => {
  const [isPlaying, setIsPlaying] = useState(false);

  const handlePlayPauseClick = () => {
    setIsPlaying(!isPlaying);
    if (window.pathTracerApp) {
      if (isPlaying) {
        window.pathTracerApp.pauseRendering = true;
      } else {
        window.pathTracerApp.pauseRendering = false;
        window.pathTracerApp.reset();
      }
    }
  };

  useEffect(() => {
    const handleRenderComplete = () => {
      setIsPlaying(false);
    };

    const handleRenderReset = () => {
      setIsPlaying(true);
    };

    if (window.pathTracerApp) {
      window.pathTracerApp.addEventListener('RenderComplete', handleRenderComplete);
      window.pathTracerApp.addEventListener('RenderReset', handleRenderReset);

      return () => {
        window.pathTracerApp.removeEventListener('RenderComplete', handleRenderComplete);
        window.pathTracerApp.removeEventListener('RenderReset', handleRenderReset);
      };
    }
  }, []);

  const DropdownMenuItem = ({ children, icon: Icon, onSelect }) => (
    <DropdownMenu.Item
      className="group text-sm flex items-center px-2 py-2 cursor-pointer hover:bg-blue-500 hover:text-white"
      onSelect={onSelect}
    >
      {Icon && <Icon className="mr-2" size={16} />}
      {children}
    </DropdownMenu.Item>
  );

  return (
    <div className="flex items-center px-2 h-12 border-b border-[#4a4a4a]">
      <div className="flex items-center space-x-2 mr-4">
        <Menu size={18} />
        <span className="font-semibold">RayCanvas</span>
      </div>
      <div className="flex space-x-2 text-sm">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger disabled className="px-2 py-1 hover:bg-gray-700 rounded cursor-not-allowed">File</DropdownMenu.Trigger>
          <DropdownMenu.Content className="min-w-[8rem] bg-white dark:bg-gray-800 rounded-md shadow-lg ring-1 ring-black ring-opacity-5 p-1">
            <DropdownMenuItem icon={FolderOpen} onSelect={() => console.log('Open')}>Open</DropdownMenuItem>
            <DropdownMenuItem icon={Save} onSelect={() => console.log('Save')}>Save</DropdownMenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-gray-200 dark:bg-gray-700" />
            <DropdownMenuItem onSelect={() => console.log('Exit')}>Exit</DropdownMenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger disabled className="px-2 py-1 hover:bg-gray-700 rounded cursor-not-allowed">Edit</DropdownMenu.Trigger>
          <DropdownMenu.Content className="min-w-[8rem] bg-white dark:bg-gray-800 rounded-md shadow-lg ring-1 ring-black ring-opacity-5 p-1">
            <DropdownMenuItem icon={Undo} onSelect={() => console.log('Undo')}>Undo</DropdownMenuItem>
            <DropdownMenuItem icon={Redo} onSelect={() => console.log('Redo')}>Redo</DropdownMenuItem>
            <DropdownMenu.Separator className="my-1 h-px bg-gray-200 dark:bg-gray-700" />
            <DropdownMenuItem icon={Copy} onSelect={() => console.log('Copy')}>Copy</DropdownMenuItem>
            <DropdownMenuItem icon={ClipboardPaste} onSelect={() => console.log('Paste')}>Paste</DropdownMenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger disabled className="px-2 py-1 hover:bg-gray-700 rounded cursor-not-allowed">View</DropdownMenu.Trigger>
          <DropdownMenu.Content className="min-w-[8rem] bg-white dark:bg-gray-800 rounded-md shadow-lg ring-1 ring-black ring-opacity-5 p-1">
            <DropdownMenuItem icon={ZoomIn} onSelect={() => console.log('Zoom In')}>Zoom In</DropdownMenuItem>
            <DropdownMenuItem icon={ZoomOut} onSelect={() => console.log('Zoom Out')}>Zoom Out</DropdownMenuItem>
            <DropdownMenuItem icon={Focus} onSelect={() => console.log('Reset View')}>Reset View</DropdownMenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <div className="flex-grow" />

      <button
        className="flex items-center space-x-1 bg-blue-500 text-white px-3 py-1 rounded text-sm"
        onClick={handlePlayPauseClick}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        <span>{isPlaying ? 'Pause' : 'Play'}</span>
      </button>

      <div className="flex-grow" />
      <ThemeToggle />
    </div>
  );
};

export default TopBar;