import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React frontend talks to the FastAPI backend (see backend/).
// During UI dev we run on mock data; when the backend is up, /api is proxied to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
