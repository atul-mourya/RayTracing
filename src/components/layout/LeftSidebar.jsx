import Outliner from './Outliner';
import Results from './Results';
import { useStore } from '@/store';

const LeftSidebar = () => {

	const appMode = useStore( state => state.appMode );

	switch ( appMode ) {

		case 'interactive':
			return <Outliner />;
		case 'final':
			return <Outliner />;
		case 'results':
			return <Results />;
		default:
			return <Outliner />;

	}


};

export default LeftSidebar;
