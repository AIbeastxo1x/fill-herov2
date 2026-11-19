// Copies the shared code from src/ into extension/. Chrome can only load files inside the extension
// folder, so the extension keeps its own copy of the matching modules and the page script.
// src/ stays the single source: edit it there, then run `npm run sync:extension`.
// tests/extension.test.js fails if the copies are out of date.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const EXT = path.join(ROOT, "extension");

export async function syncExtension() {
  await fs.rm(path.join(EXT, "lib"), { recursive: true, force: true });
  await fs.cp(path.join(SRC, "lib"), path.join(EXT, "lib"), { recursive: true });
  await fs.copyFile(path.join(SRC, "content.js"), path.join(EXT, "content.js"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncExtension();
  console.log("extension files synced from src/");
}
