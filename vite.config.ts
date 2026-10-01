import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()],
  optimizeDeps:{entries:['src/main.tsx']},
  server:{strictPort:true,proxy:{'/api':'http://127.0.0.1:3001'},
    watch:{ignored:['**/.venv/**','**/data/**','**/server/**']}},
  preview:{proxy:{'/api':'http://127.0.0.1:3001'}},
});
