import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // The build drops the licence comments of the packages it bundles, and their licences ask
    // that the notice go wherever a copy does. So the licence of every bundled package is
    // written to one file, which is served beside the app. `index.html` says where it is.
    license: { fileName: "third-party-licenses.md" },
  },
  server: {
    port: 5173,
    // The API is the Worker, run by `wrangler dev` on its default port.
    proxy: { "/api": "http://localhost:8787" },
  },
});
