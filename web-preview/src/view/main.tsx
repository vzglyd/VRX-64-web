import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PlayerApp } from './PlayerApp';
import { startPlayerLegacy } from './legacy';

function Boot() {
  useEffect(() => {
    startPlayerLegacy();
  }, []);

  return <PlayerApp />;
}

const root = document.getElementById('react-root');
if (!root) {
  throw new Error('Missing #react-root');
}

createRoot(root).render(<Boot />);
