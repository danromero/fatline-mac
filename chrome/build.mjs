// Builds the extension into dist/. `--test` builds dist-test/, which also runs on a local test page.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const testing = process.argv.includes("--test");
const out = testing ? "dist-test" : "dist";

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp("static", out, { recursive: true });

await build({
  entryPoints: {
    sw: "src/background/sw.ts",
    content: "src/content/content.ts",
    rail: "src/rail/main.tsx",
    setup: "src/setup/main.tsx",
  },
  outdir: out,
  bundle: true,
  format: "iife",
  target: "chrome137",
  charset: "utf8",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
});

if (testing) {
  const manifest = JSON.parse(await readFile(`${out}/manifest.json`, "utf8"));
  manifest.name = "Fatline Test";
  manifest.content_scripts[0].matches.push("http://localhost/*");
  manifest.web_accessible_resources[0].matches.push("http://localhost/*");
  manifest.host_permissions.push("https://localhost/*");
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace("frame-ancestors https://x.com", "frame-ancestors https://x.com http://localhost:*");
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
}
