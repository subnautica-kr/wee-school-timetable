import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import App from './App.jsx';
import ErrorGate from './ErrorBoundary.jsx';
import './grid/print.css';

createRoot(document.getElementById('root')).render(
  <MantineProvider defaultColorScheme="light">
    <ErrorGate>
      <App />
    </ErrorGate>
  </MantineProvider>,
);
