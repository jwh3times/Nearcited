import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is the Worker, run by `wrangler dev` on its default port.
    proxy: { "/api": "http://localhost:8787" },
  },
});
