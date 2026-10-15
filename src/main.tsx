import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('MemorySpy could not find #root to mount into.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
