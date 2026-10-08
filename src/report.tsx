// Entry point of the standalone report written by the CLI (src/cli/main.ts).
// The CLI inlines this bundle and the parsed dataset into a single HTML file,
// so the report opens from disk with no server and no upload.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from './Dashboard';
import { Footer, TooltipProvider } from './components/ui';
import { toolTitle } from './core/aggregate';
import type { Dataset } from './core/types';
import { applyTheme, currentTheme, type Theme } from './theme';
import './styles.css';

function readDataset(): Dataset | null {
  try {
    return JSON.parse(document.getElementById('dataset')?.textContent ?? '') as Dataset;
  } catch {
    return null;
  }
}

function Report({ dataset }: { dataset: Dataset }) {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const changeTheme = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  return (
    <TooltipProvider>
      <Dashboard dataset={dataset} theme={theme} onTheme={changeTheme} />
      <Footer />
    </TooltipProvider>
  );
}

const dataset = readDataset();
if (dataset && dataset.sources.length > 0) document.title = `${toolTitle(dataset.sources)} Analytics report`;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {dataset ? (
      <Report dataset={dataset} />
    ) : (
      <div className="app">
        <div className="error">This page has no report data. Generate a report with the claude-log CLI.</div>
      </div>
    )}
  </StrictMode>,
);
