import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp } from './EditorApp';
import { startEditorLegacy } from './legacy';

function Boot() {
  useEffect(() => {
    startEditorLegacy();
  }, []);

  return <EditorApp />;
}

const root = document.getElementById('react-root');
if (!root) {
  throw new Error('Missing #react-root');
}

createRoot(root).render(<Boot />);
