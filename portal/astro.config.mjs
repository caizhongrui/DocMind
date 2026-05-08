import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://doc-web.boyobang.com",
  integrations: [tailwind()],
  build: {
    format: "directory",
  },
  compressHTML: true,
});
