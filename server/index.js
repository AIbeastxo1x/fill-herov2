// Entry point. Configuration comes from environment variables:
//   FILLHERO_TOKEN    required, at least 24 characters. The API refuses to start without it.
//   ALLOWED_ORIGINS   comma-separated front-end origins, e.g. https://your-site.netlify.app
//   DATA_DIR          where store.json is kept (mount a persistent disk here). Default ./data
//   PORT              default 8080
import path from "node:path";
import { createStore } from "./store.js";
import { Engine } from "./engine.js";
import { createApp } from "./app.js";
import { CampaignRunner, campaignLimitsFromEnv } from "./campaign.js";
import { makeMailerSource } from "./mailer.js";

const token = process.env.FILLHERO_TOKEN || "";
if (token.length < 24) {
  console.error("FILLHERO_TOKEN must be set to at least 24 characters. Refusing to start.");
  process.exit(1);
}

const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const port = Number(process.env.PORT || 8080);

const store = createStore(dataDir);
await store.load();
const engine = new Engine(store, {
  launchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] }, // needed inside most containers
});
// The relay is read from the saved settings, falling back to environment variables.
// PUBLIC_BASE_URL is the site address used in unsubscribe links, for example https://your-site.netlify.app
const campaigns = new CampaignRunner(store, {
  mailer: makeMailerSource(store, { token }),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  unsubscribeSecret: token,
  ...campaignLimitsFromEnv(),
});
// APPROVED_BUILDS: comma-separated fingerprints from `npm run build:extension`. Empty = accept any build.
const approvedBuilds = (process.env.APPROVED_BUILDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const app = createApp({ store, engine, token, origins, campaigns, approvedBuilds });

const server = app.listen(port, () => {
  console.log(`Fill Hero API listening on port ${port}; data in ${dataDir}; origins: ${origins.join(", ") || "none"}`);
});

// On shutdown, stop the run, let pending writes finish, then exit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    engine.stop();
    campaigns.stop();
    server.close();
    await store.flush();
    process.exit(0);
  });
}
