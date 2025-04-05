import Outliner from './Outliner';
import Results from './Results';
import { useStore } from '@/store';

const LeftSidebar = () => {

	const appMode = useStore( state => state.appMode );

	return appMode === 'interactive' ? <Outliner /> : <Results />;

};

export default LeftSidebar;
