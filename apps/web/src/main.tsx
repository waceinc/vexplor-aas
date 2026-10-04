import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { tr } from './i18n.js';

const container = document.getElementById('root');
if (!container) throw new Error(tr('#root가 없습니다.'));
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
