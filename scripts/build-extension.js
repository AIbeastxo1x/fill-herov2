// Builds the protected extension into dist/extension, ready to load in Chrome or to zip for a customer.
// The background script is bundled into one file and obfuscated; so are the popup and page script.
// The readable source stays in extension/ and is never shipped. Run `npm run build:extension` first.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "dist", "extension");

// Strong enough to stop casual reading and copying. It is not unbreakable: see HARNESS.md.
const OBFUSCATION = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: true, // renames the script's own top-level names; browser APIs such as chrome.* are not renamed
  rotateStringArray: true,
  shuffleStringArray: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 1, // every string literal is encoded, including message names
  selfDefending: false, // self-defending code can break under some browser versions
  debugProtection: false,
  disableConsoleOutput: false,
};

function obfuscate(code) {
  return JavaScriptObfuscator.obfuscate(code, OBFUSCATION).getObfuscatedCode();
}

export async function buildExtension() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, "popup"), { recursive: true });

  // One bundle for the service worker, with the shared matching code inside it.
  const bundled = await esbuild.build({
    entryPoints: [path.join(SRC, "background.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    target: "chrome120",
  });
  await fs.writeFile(path.join(OUT, "background.js"), obfuscate(bundled.outputFiles[0].text));

  await fs.writeFile(path.join(OUT, "content.js"), obfuscate(await fs.readFile(path.join(SRC, "content.js"), "utf8")));
  await fs.writeFile(path.join(OUT, "popup", "popup.js"), obfuscate(await fs.readFile(path.join(SRC, "popup", "popup.js"), "utf8")));
  await fs.copyFile(path.join(SRC, "popup", "popup.html"), path.join(OUT, "popup", "popup.html"));
  await fs.copyFile(path.join(SRC, "manifest.json"), path.join(OUT, "manifest.json"));
  return OUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildExtension();
  console.log(`protected extension built in ${path.relative(ROOT, out)}`);
}
