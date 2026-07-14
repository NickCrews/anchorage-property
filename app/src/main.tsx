import {ThemeProvider} from '@sqlrooms/ui';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Room} from './room';
import {roomStore} from './store';
import './index.css';

if (import.meta.env.DEV) {
  // Poke at live state from the browser console: roomStore.getState()
  (window as unknown as {roomStore: typeof roomStore}).roomStore = roomStore;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="light" storageKey="sqlrooms-ui-theme">
      <Room />
    </ThemeProvider>
  </StrictMode>,
);
