import TopBar from '@/components/layout/TopBar';
import LeftSidebar from '@/components/layout/LeftSideBar';
import MainViewport from '@/components/layout/MainViewport';
import RightSidebar from '@/components/layout/RightSidebar';
import { ThemeProvider } from "@/components/theme-provider"

const App = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <div className="flex flex-col h-screen">
        <TopBar />
        <div className="flex flex-1 overflow-hidden">
          <LeftSidebar />
          <MainViewport />
          <RightSidebar />
        </div>
      </div>
    </ThemeProvider>
  );
};

export default App;