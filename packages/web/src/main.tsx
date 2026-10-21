import { createRoot } from 'react-dom/client';
// Webfont css first so the tokens in styles.css resolve against loaded faces.
import '@fontsource-variable/inter';
import '@fontsource-variable/archivo';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import App from './App';

const el = document.getElementById('root');
if (el === null) throw new Error('#root element not found');
createRoot(el).render(<App />);
