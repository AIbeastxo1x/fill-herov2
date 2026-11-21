// Builds the protected extension, runs the extension scenarios against it, and checks that
// the readable names of the sensitive logic are gone from the shipped files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension } from "../scripts/build-extension.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the protected build passes the same extension run scenarios", async () => {
  await buildExtension();
  const r = spawnSync(process.execPath, ["--test", "tests/extension-run.test.js"], {
    cwd: ROOT,
    env: { ...process.env, FH_EXTENSION_BUILD: "dist" },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

// The names of the licence check and the run logic are hidden. Data keys such as "sentHosts" are
// still visible, because renaming them would change what is saved in the browser.
test("the shipped files do not show the readable names of the licence and run logic", async () => {
  const bg = await fs.readFile(path.join(ROOT, "dist", "extension", "background.js"), "utf8");
  const popup = await fs.readFile(path.join(ROOT, "dist", "extension", "popup", "popup.js"), "utf8");
  for (const name of ["checkLicence", "stopRequested", "withTimeout", "processDomain", "licenceStatus"]) {
    assert.equal(bg.includes(name), false, `background.js still shows ${name}`);
  }
  assert.equal(popup.includes("setLicence"), false, "popup.js still shows the licence message name");
});
