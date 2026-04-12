import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewApp } from './PreviewApp';
import { startPreviewLegacy } from './legacy';

function Boot() {
  useEffect(() => {
    startPreviewLegacy();
  }, []);

  return <PreviewApp />;
}

const root = document.getElementById('react-root');
if (!root) {
  throw new Error('Missing #react-root');
}

createRoot(root).render(<Boot />);
