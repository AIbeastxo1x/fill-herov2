// Checks the extension folder: its copies of the shared code match src/, and every file it names exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const SRC = path.join(ROOT, "src");

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

const exists = (p) => fs.access(p).then(() => true, () => false);

test("the extension's copies of lib/ and content.js match src/", async () => {
  const srcLib = await listFiles(path.join(SRC, "lib"));
  const extLib = await listFiles(path.join(EXT, "lib"));
  assert.deepEqual(extLib, srcLib);
  for (const f of srcLib) {
    const a = await fs.readFile(path.join(SRC, "lib", f));
    const b = await fs.readFile(path.join(EXT, "lib", f));
    assert.ok(a.equals(b), `extension/lib/${f} is out of date: run npm run sync:extension`);
  }
  const srcContent = await fs.readFile(path.join(SRC, "content.js"));
  const extContent = await fs.readFile(path.join(EXT, "content.js"));
  assert.ok(srcContent.equals(extContent), "extension/content.js is out of date: run npm run sync:extension");
});

test("every file the manifest and background script name exists in the extension folder", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(EXT, "manifest.json"), "utf8"));
  assert.ok(await exists(path.join(EXT, manifest.background.service_worker)), "service worker");
  assert.ok(await exists(path.join(EXT, manifest.action.default_popup)), "popup");

  const background = await fs.readFile(path.join(EXT, "background.js"), "utf8");
  const imports = [...background.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const rel of imports) assert.ok(await exists(path.join(EXT, rel)), `missing ${rel}`);

  const injected = [...background.matchAll(/files: \["([^"]+)"\]/g)].map((m) => m[1]);
  for (const rel of injected) assert.ok(await exists(path.join(EXT, rel)), `missing ${rel}`);
});

test("the server still uses the shared code in src/", async () => {
  const engine = await fs.readFile(path.join(ROOT, "server", "engine.js"), "utf8");
  assert.match(engine, /\.\.\/src\/lib\//);
  assert.match(engine, /path\.join\(HERE, "\.\.", "src", "content\.js"\)/);
});
