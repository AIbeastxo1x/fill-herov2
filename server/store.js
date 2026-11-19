// Persistent storage for the server: one JSON file in DATA_DIR.
// Reads come from memory. Writes are queued one at a time and replace the file atomically,
// so a crash mid-write cannot leave a half-written file behind.
import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_PROFILE = {
  firstName: "",
  lastName: "",
  company: "",
  email: "",
  phone: "",
  subject: "",
  jobTitle: "",
  country: "",
  address: "",
  city: "",
  state: "",
  zip: "",
  template: "Hello {domain} team,\n\n",
};

export const DEFAULTS = {
  log: [],
  queue: [],
  emails: [],
  captchaDomains: [],
  sentHosts: [], // hosts we have submitted to; kept by Clear all, so they are never contacted again
  profile: DEFAULT_PROFILE,
  dailyCount: 0,
  dailyDate: "",
  lastSubmitAt: 0,
  dryRun: true, // safe default: fill but never submit
};

export function createStore(dir) {
  const file = path.join(dir, "store.json");
  let data = { ...DEFAULTS };
  let chain = Promise.resolve();

  return {
    async load() {
      await fs.mkdir(dir, { recursive: true });
      try {
        data = { ...DEFAULTS, ...JSON.parse(await fs.readFile(file, "utf8")) };
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      return data;
    },
    get() {
      return data;
    },
    // Merges a patch into memory now, and writes the file in order behind any earlier write.
    set(patch) {
      data = { ...data, ...patch };
      const snapshot = JSON.stringify(data);
      chain = chain
        .then(async () => {
          const tmp = `${file}.tmp`;
          await fs.writeFile(tmp, snapshot);
          await fs.rename(tmp, file);
        })
        .catch((err) => console.error("store write failed:", err.message));
      return chain;
    },
    // Resolves once every queued write has finished.
    flush() {
      return chain;
    },
  };
}
