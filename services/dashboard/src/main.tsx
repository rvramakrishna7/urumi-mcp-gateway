import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import { App } from './App';
import { ThemeProvider } from './theme/ThemeProvider';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });

const root = document.getElementById('root');
if (!root) throw new Error('the page has no #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
