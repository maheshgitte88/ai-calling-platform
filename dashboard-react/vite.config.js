import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Quick tunnels (Cloudflare *.trycloudflare.com, ngrok, etc.) use a new hostname each time — listing each one is brittle.
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:4040",
        changeOrigin: true,
      },
    },
  },
});
