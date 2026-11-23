import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: 'es' }, // 생성 워커가 코드 분할돼 iife 불가
  server: { fs: { allow: ['..'] }, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
