'use client';

import { useEffect } from 'react';

export function MonacoSetup() {
  useEffect(() => {
    // Configure Monaco environment to prevent worker errors in Next.js
    if (typeof window !== 'undefined') {
      const win = window as unknown as {
        MonacoEnvironment?: {
          getWorker?: () => null;
          getWorkerUrl?: () => string;
        }
      };

      // Set up Monaco environment before any Monaco imports
      if (!win.MonacoEnvironment) {
        win.MonacoEnvironment = {
          getWorker: () => null,
          getWorkerUrl: () => '',
        };
      }
    }
  }, []);

  return null;
}
