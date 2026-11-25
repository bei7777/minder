import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const outputDir = resolve(process.argv[2] ?? join(desktop, "lib"));
const config = resolve(process.argv[3] ?? join(desktop, "tsconfig.json"));
const require = createRequire(import.meta.url);

execFileSync(process.execPath, [
  require.resolve("typescript/bin/tsc"), "--project", config, "--outDir", outputDir, "--noEmitOnError",
], { cwd: desktop, stdio: "inherit" });

await build({
  absWorkingDir: desktop,
  entryPoints: ["src/renderer.ts"],
  outfile: join(outputDir, "renderer.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  legalComments: "inline",
});
