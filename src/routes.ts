import { randomUUID } from "crypto";
import {
  getConfig,
  saveConfig,
  getRedactedConfig,
  type WorkspaceConfig,
  type HiveConfig,
} from "./config";
import { provisionMachineUser, deprovisionMachineUser } from "./ego";
import { pushEvent } from "./cortex";
import {
  startWorkspace,
  stopWorkspace,
  isRunning,
  getWorkspaceLogs,
  getProcess,
  injectLog,
  getSynapseStatus,
} from "./synapse";

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler) {
  routes.push({
    method,
    pattern: new URLPattern({ pathname: path }),
    handler,
  });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function err(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

// --- Workspaces ---

route("GET", "/workspaces", () => {
  const config = getConfig();
  return json(
    config.workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      path: ws.path,
      enabled: ws.enabled,
      running: isRunning(ws.id),
      status: isRunning(ws.id) ? getSynapseStatus(ws.path) : "stopped",
    }))
  );
});

route("POST", "/workspaces", async (req) => {
  const body = (await req.json()) as {
    name: string;
    path: string;
    enabled?: boolean;
  };

  if (!body.name || !body.path) return err("name and path are required");

  const config = getConfig();
  const machineUser = await provisionMachineUser(body.name);

  const workspace: WorkspaceConfig = {
    id: randomUUID(),
    name: body.name,
    path: body.path,
    machineUserId: machineUser.id,
    machineUserClientId: machineUser.username,
    machineUserClientSecret: machineUser.client_secret,
    enabled: body.enabled ?? true,
  };

  config.workspaces.push(workspace);
  saveConfig();

  if (workspace.enabled) {
    await startWorkspace(workspace.id);
  }

  return json(
    {
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      enabled: workspace.enabled,
      running: isRunning(workspace.id),
    },
    201
  );
});

route("GET", "/workspaces/:id", (_req, params) => {
  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === params.id);
  if (!ws) return err("Workspace not found", 404);
  return json({ id: ws.id, name: ws.name, path: ws.path, enabled: ws.enabled, running: isRunning(ws.id), status: isRunning(ws.id) ? getSynapseStatus(ws.path) : "stopped" });
});

route("PATCH", "/workspaces/:id", async (req, params) => {
  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === params.id);
  if (!ws) return err("Workspace not found", 404);

  const body = (await req.json()) as {
    name?: string;
    path?: string;
    enabled?: boolean;
  };

  if (body.name !== undefined) ws.name = body.name;
  if (body.path !== undefined) ws.path = body.path;
  if (body.enabled !== undefined) ws.enabled = body.enabled;

  saveConfig();
  return json({ id: ws.id, name: ws.name, path: ws.path, enabled: ws.enabled, running: isRunning(ws.id) });
});

route("DELETE", "/workspaces/:id", async (_req, params) => {
  const config = getConfig();
  const idx = config.workspaces.findIndex((w) => w.id === params.id);
  if (idx === -1) return err("Workspace not found", 404);

  const ws = config.workspaces[idx];
  await stopWorkspace(ws.id);
  await deprovisionMachineUser(ws.machineUserId);
  config.workspaces.splice(idx, 1);
  saveConfig();

  return json({ ok: true });
});

// --- Start / Stop ---

route("POST", "/workspaces/:id/start", async (_req, params) => {
  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === params.id);
  if (!ws) return err("Workspace not found", 404);

  await startWorkspace(ws.id);
  ws.enabled = true;
  saveConfig();
  return json({ ok: true });
});

route("POST", "/workspaces/:id/stop", async (_req, params) => {
  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === params.id);
  if (!ws) return err("Workspace not found", 404);

  await stopWorkspace(ws.id);
  ws.enabled = false;
  saveConfig();
  return json({ ok: true });
});

// --- Logs (SSE) ---

route("GET", "/workspaces/:id/logs", (_req, params) => {
  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === params.id);
  if (!ws) return err("Workspace not found", 404);

  const logs = getWorkspaceLogs(ws.id);
  const managed = getProcess(ws.id);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // Send existing logs
      for (const line of logs) {
        send(line);
      }

      if (!managed) {
        send("[process not running]");
        controller.close();
        return;
      }

      // Tail new logs
      let lastSentIndex = logs.length;
      const interval = setInterval(() => {
        if (!isRunning(ws.id)) {
          send("[process exited]");
          clearInterval(interval);
          clearInterval(checkAlive);
          controller.close();
          return;
        }
        const current = getWorkspaceLogs(ws.id);
        for (let i = lastSentIndex; i < current.length; i++) {
          send(current[i]);
        }
        lastSentIndex = current.length;
      }, 500);

      // Clean up when client disconnects
      const checkAlive = setInterval(() => {
        try {
          controller.enqueue(new Uint8Array(0));
        } catch {
          clearInterval(interval);
          clearInterval(checkAlive);
        }
      }, 5000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// --- Message ---

route("POST", "/workspaces/:id/message", async (req, params) => {
  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === params.id);
  if (!ws) return err("Workspace not found", 404);

  const body = (await req.json()) as { message: string };
  if (!body.message) return err("message is required");

  injectLog(ws.id, `▶ You: ${body.message}`);

  await pushEvent(`message.${ws.id}`, {
    workspaceId: ws.id,
    workspaceName: ws.name,
    message: body.message,
  });

  return json({ ok: true });
});

// --- Config ---

route("GET", "/config", () => {
  return json(getRedactedConfig());
});

route("PATCH", "/config", async (req) => {
  const body = (await req.json()) as Partial<
    Pick<HiveConfig, "defaultSubscriptions" | "groupSubscriptions" | "ego" | "cortex">
  >;
  const config = getConfig();

  if (body.defaultSubscriptions !== undefined)
    config.defaultSubscriptions = body.defaultSubscriptions;
  if (body.groupSubscriptions !== undefined)
    config.groupSubscriptions = body.groupSubscriptions;
  if (body.ego !== undefined) Object.assign(config.ego, body.ego);
  if (body.cortex !== undefined) Object.assign(config.cortex, body.cortex);

  saveConfig();
  return json(getRedactedConfig());
});

// --- Router ---

export function matchRoute(
  method: string,
  url: string
): { handler: Handler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(url);
    if (match) {
      return {
        handler: route.handler,
        params: (match.pathname.groups as Record<string, string>) ?? {},
      };
    }
  }
  return null;
}
