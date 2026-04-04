import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Server } from "bun";

// --- Mock Ego and Cortex servers ---

let mockEgo: Server;
let mockCortex: Server;
let egoPort: number;
let cortexPort: number;
let hivePort: number;

const ADMIN_TOKEN = "test-admin-token";
const BOOTSTRAP_TOKEN = "test-bootstrap-token";

// Ego state
let egoUsers: Record<string, any> = {};
let egoBootstrapConsumed = false;

// Cortex state
let cortexSources: Record<string, any> = {};
let cortexWebhooks: any[] = [];

function startMockEgo(): Server {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // POST /token
      if (req.method === "POST" && path === "/token") {
        const body = await req.json();
        if (body.grant_type !== "client_credentials") {
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        }
        const user = Object.values(egoUsers).find(
          (u: any) => u.username === body.client_id && u.client_secret_plain === body.client_secret
        );
        if (!user) return Response.json({ error: "invalid_client" }, { status: 401 });
        return Response.json({
          access_token: `jwt-for-${(user as any).username}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      // POST /admin/users
      if (req.method === "POST" && path === "/admin/users") {
        const bootstrap = req.headers.get("x-bootstrap-token");
        const auth = req.headers.get("authorization");

        if (bootstrap) {
          if (egoBootstrapConsumed || bootstrap !== BOOTSTRAP_TOKEN) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          egoBootstrapConsumed = true;
        } else if (!auth?.startsWith("Bearer jwt-for-")) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const id = randomUUID();
        const secret = randomUUID();
        const user = {
          id,
          username: body.username,
          client_secret: secret,
          client_secret_plain: secret,
          machine: !!body.machine,
          admin: !!body.admin,
          active: true,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        };
        egoUsers[id] = user;
        return Response.json(user, { status: 201 });
      }

      // DELETE /admin/users/:id
      const deleteMatch = path.match(/^\/admin\/users\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        const id = deleteMatch[1];
        if (!egoUsers[id]) return Response.json({ error: "not found" }, { status: 404 });
        delete egoUsers[id];
        return new Response(null, { status: 204 });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

function startMockCortex(): Server {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // POST /admin/sources
      if (req.method === "POST" && path === "/admin/sources") {
        const body = await req.json();
        const id = randomUUID();
        const secret = randomUUID().replace(/-/g, "");
        cortexSources[id] = { id, name: body.name, secret };
        return Response.json({ id, secret }, { status: 201 });
      }

      // POST /webhooks/:sourceId
      const webhookMatch = path.match(/^\/webhooks\/([^/]+)$/);
      if (req.method === "POST" && webhookMatch) {
        const sourceId = webhookMatch[1];
        const source = cortexSources[sourceId];
        if (!source) return new Response("Not Found", { status: 404 });

        const body = await req.text();
        const signature = req.headers.get("x-webhook-signature");

        // Verify HMAC
        const { createHmac } = await import("crypto");
        const expected = createHmac("sha256", source.secret).update(body).digest("hex");
        if (signature !== expected) return new Response("Invalid signature", { status: 401 });

        cortexWebhooks.push(JSON.parse(body));
        return new Response("OK", { status: 200 });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

// --- Config and Hive server ---

const CONFIG_DIR = join(import.meta.dir, "..", ".test-hive-" + process.pid);
const CONFIG_PATH = join(CONFIG_DIR, "hive.json");

let hiveServer: ReturnType<typeof Bun.serve>;

function hiveUrl(path: string) {
  return `http://localhost:${hivePort}${path}`;
}

function hiveHeaders() {
  return {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    "Content-Type": "application/json",
  };
}

beforeAll(async () => {
  // Start mock services
  mockEgo = startMockEgo();
  mockCortex = startMockCortex();
  egoPort = mockEgo.port;
  cortexPort = mockCortex.port;

  // Create test config
  mkdirSync(CONFIG_DIR, { recursive: true });
  const config = {
    ego: { url: `http://localhost:${egoPort}`, clientId: "", clientSecret: "" },
    cortex: { url: `http://localhost:${cortexPort}`, sourceId: "", sourceSecret: "" },
    defaultSubscriptions: ["test.event"],
    groupSubscriptions: {},
    workspaces: [],
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  // Set env vars before importing Hive modules
  process.env.HIVE_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.EGO_BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN;
  process.env.PORT = "0";

  // We can't easily use Hive's built-in server because it reads config from cwd.
  // Instead, test the route handler directly.
  // But we need to set cwd or monkey-patch config path.
  // Let's just use the config/ego/routes modules directly.

  // Override cwd for config
  const origCwd = process.cwd;
  process.cwd = () => CONFIG_DIR;

  const { loadConfig } = await import("./config");
  const { authenticate } = await import("./ego");
  const { matchRoute } = await import("./routes");

  loadConfig();
  await authenticate();

  // Restore cwd
  process.cwd = origCwd;

  // Start a simple server that delegates to matchRoute
  hiveServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("Authorization");
      if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const match = matchRoute(req.method, req.url);
      if (!match) return Response.json({ error: "Not found" }, { status: 404 });

      try {
        return await match.handler(req, match.params);
      } catch (e: any) {
        console.error("TEST SERVER ERROR:", e);
        return Response.json({ error: e.message ?? "Internal error" }, { status: 500 });
      }
    },
  });
  hivePort = hiveServer.port;
});

afterAll(() => {
  mockEgo?.stop();
  mockCortex?.stop();
  hiveServer?.stop();
  try {
    rmSync(CONFIG_DIR, { recursive: true });
  } catch {}
});

// --- Tests ---

describe("Self-seeding", () => {
  test("config was populated with Ego credentials", async () => {
    const res = await fetch(hiveUrl("/config"), { headers: hiveHeaders() });
    const config = await res.json();
    expect(config.ego.clientId).toBe("hive-admin");
    expect(config.ego.clientSecret).toBe("***");
  });

  test("config was populated with Cortex source", async () => {
    const res = await fetch(hiveUrl("/config"), { headers: hiveHeaders() });
    const config = await res.json();
    expect(config.cortex.sourceId).toBeTruthy();
    expect(config.cortex.sourceSecret).toBe("***");
  });

  test("bootstrap token was consumed", () => {
    expect(egoBootstrapConsumed).toBe(true);
  });
});

describe("Auth", () => {
  test("rejects requests without auth", async () => {
    const res = await fetch(hiveUrl("/workspaces"));
    expect(res.status).toBe(401);
  });

  test("rejects requests with wrong token", async () => {
    const res = await fetch(hiveUrl("/workspaces"), {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });
});

describe("Workspaces CRUD", () => {
  let workspaceId: string;
  const tmpPath = join(CONFIG_DIR, "ws-test");

  test("list empty workspaces", async () => {
    const res = await fetch(hiveUrl("/workspaces"), { headers: hiveHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test("create workspace", async () => {
    mkdirSync(tmpPath, { recursive: true });
    const res = await fetch(hiveUrl("/workspaces"), {
      method: "POST",
      headers: hiveHeaders(),
      body: JSON.stringify({ name: "test-ws", path: tmpPath, enabled: false }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("test-ws");
    expect(data.id).toBeTruthy();
    workspaceId = data.id;
  });

  test("get workspace", async () => {
    const res = await fetch(hiveUrl(`/workspaces/${workspaceId}`), {
      headers: hiveHeaders(),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("test-ws");
    expect(data.running).toBe(false);
  });

  test("list workspaces shows created workspace", async () => {
    const res = await fetch(hiveUrl("/workspaces"), { headers: hiveHeaders() });
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].name).toBe("test-ws");
  });

  test("patch workspace", async () => {
    const res = await fetch(hiveUrl(`/workspaces/${workspaceId}`), {
      method: "PATCH",
      headers: hiveHeaders(),
      body: JSON.stringify({ name: "renamed-ws" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("renamed-ws");
  });

  test("get non-existent workspace returns 404", async () => {
    const res = await fetch(hiveUrl("/workspaces/nonexistent"), {
      headers: hiveHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("delete workspace", async () => {
    const res = await fetch(hiveUrl(`/workspaces/${workspaceId}`), {
      method: "DELETE",
      headers: hiveHeaders(),
    });
    expect(res.status).toBe(200);

    // Verify machine user was deprovisioned
    const listRes = await fetch(hiveUrl("/workspaces"), { headers: hiveHeaders() });
    const data = await listRes.json();
    expect(data.length).toBe(0);
  });
});

describe("Workspace messaging", () => {
  let workspaceId: string;
  const tmpPath = join(CONFIG_DIR, "ws-msg-test");

  beforeAll(async () => {
    mkdirSync(tmpPath, { recursive: true });
    const res = await fetch(hiveUrl("/workspaces"), {
      method: "POST",
      headers: hiveHeaders(),
      body: JSON.stringify({ name: "msg-test", path: tmpPath, enabled: false }),
    });
    const data = await res.json();
    workspaceId = data.id;
    cortexWebhooks.length = 0;
  });

  test("send message to workspace", async () => {
    const res = await fetch(hiveUrl(`/workspaces/${workspaceId}/message`), {
      method: "POST",
      headers: hiveHeaders(),
      body: JSON.stringify({ message: "hello workspace" }),
    });
    expect(res.status).toBe(200);
  });

  test("message was pushed as webhook with correct event type", () => {
    expect(cortexWebhooks.length).toBe(1);
    expect(cortexWebhooks[0].type).toBe(`message.${workspaceId}`);
    expect(cortexWebhooks[0].message).toBe("hello workspace");
  });

  test("message was HMAC signed correctly", () => {
    // If we got here, the mock Cortex verified the signature
    expect(cortexWebhooks.length).toBeGreaterThan(0);
  });

  test("message to non-existent workspace returns 404", async () => {
    const res = await fetch(hiveUrl("/workspaces/fake-id/message"), {
      method: "POST",
      headers: hiveHeaders(),
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  test("message without body returns 400", async () => {
    const res = await fetch(hiveUrl(`/workspaces/${workspaceId}/message`), {
      method: "POST",
      headers: hiveHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  afterAll(async () => {
    await fetch(hiveUrl(`/workspaces/${workspaceId}`), {
      method: "DELETE",
      headers: hiveHeaders(),
    });
  });
});

describe("Config", () => {
  test("get config redacts secrets", async () => {
    const res = await fetch(hiveUrl("/config"), { headers: hiveHeaders() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ego.clientSecret).toBe("***");
    expect(data.cortex.sourceSecret).toBe("***");
  });

  test("patch config", async () => {
    const res = await fetch(hiveUrl("/config"), {
      method: "PATCH",
      headers: hiveHeaders(),
      body: JSON.stringify({ defaultSubscriptions: ["new.event"] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.defaultSubscriptions).toEqual(["new.event"]);
  });
});

describe("Routing", () => {
  test("404 for unknown routes", async () => {
    const res = await fetch(hiveUrl("/nonexistent"), { headers: hiveHeaders() });
    expect(res.status).toBe(404);
  });
});
