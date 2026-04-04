import * as LaunchDarkly from "@launchdarkly/node-server-sdk";
import { Observability } from "@launchdarkly/observability-node";
import { loadConfig, getConfig } from "./config";
import { authenticate } from "./ego";
import { startWorkspace } from "./synapse";
import { matchRoute } from "./routes";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const ADMIN_TOKEN = process.env.HIVE_ADMIN_TOKEN;

const LD_SDK_KEY = process.env.LD_SDK_KEY;
export const ldClient = LD_SDK_KEY ? LaunchDarkly.init(LD_SDK_KEY, {
  plugins: [
    new Observability({
      serviceName: "hive",
      serviceVersion: "1.0.0",
      environment: "production",
    }),
  ],
}) : null;
export const ldContext: LaunchDarkly.LDContext = {
  kind: "service",
  key: "hive",
  name: "Hive",
};

async function startup() {
  console.log("Loading config...");
  loadConfig();

  if (ldClient) {
    console.log("Initializing LaunchDarkly...");
    await ldClient.waitForInitialization({ timeout: 10 });
    console.log("LaunchDarkly client ready.");
  } else {
    console.log("LD_SDK_KEY not set, skipping LaunchDarkly.");
  }

  console.log("Authenticating with Ego...");
  await authenticate();

  const config = getConfig();
  console.log(`Starting ${config.workspaces.filter((w) => w.enabled).length} enabled workspaces...`);

  for (const ws of config.workspaces) {
    if (ws.enabled) {
      try {
        await startWorkspace(ws.id);
        console.log(`  ✓ ${ws.name}`);
      } catch (e) {
        console.error(`  ✗ ${ws.name}: ${e}`);
      }
    }
  }

  console.log("Startup complete.");
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    // Auth check
    const auth = req.headers.get("Authorization");
    if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const match = matchRoute(req.method, req.url);
    if (!match) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    try {
      return await match.handler(req, match.params);
    } catch (e: any) {
      console.error("Request error:", e);
      return Response.json({ error: e.message ?? "Internal error" }, { status: 500 });
    }
  },
});

startup().catch((e) => {
  console.error("Startup failed:", e);
});

process.on("SIGINT", () => {
  ldClient?.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  ldClient?.close();
  process.exit(0);
});

console.log(`Hive listening on port ${PORT}`);
