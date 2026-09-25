import { readFileSync } from "node:fs"
import { defineConfig } from "vite"

const version = (pkg: string) =>
  JSON.parse(readFileSync(new URL(`./node_modules/${pkg}/package.json`, import.meta.url), "utf8")).version as string

// relative asset paths: the host serves the build from the DotNS name's root.
// The SDK + papi versions are stamped into every log export.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  define: {
    __SDK_VERSION__: JSON.stringify(version("@parity/product-sdk-host")),
    __PAPI_VERSION__: JSON.stringify(version("polkadot-api")),
  },
})
