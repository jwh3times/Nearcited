import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // The licences of the packages the build bundles ask that their notice go wherever a copy
    // does. So the licence of every bundled package is written to one file, which is served
    // beside the app, and `index.html` says where it is.
    license: { fileName: "third-party-licenses.md" },
    // A minified build drops every comment, the short licence notices in a package's own code
    // among them. Those are kept: some name code inside a package that the package's licence
    // file does not, so the file above would not carry them.
    rolldownOptions: { output: { comments: { legal: true } } },
  },
  server: {
    port: 5173,
    // The API is the Worker, run by `wrangler dev` on its default port.
    proxy: { "/api": "http://localhost:8787" },
  },
});
