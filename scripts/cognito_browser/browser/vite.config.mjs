import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  root: '/app/frontend', cacheDir: '/tmp/vite-cache', plugins: [react()],
  server: { host: '127.0.0.1', port: 4174, strictPort: true,
    proxy: { '/api': { target: 'http://api:8000' }, '/identity': { target: 'http://identity:8001' } } },
})
