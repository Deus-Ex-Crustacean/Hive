import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfig } from "./config";
import { mergeSubscriptions } from "./subscriptions";

interface ManagedProcess {
  proc: Subprocess;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  logs: string[];
}

const processes = new Map<string, ManagedProcess>();

const MAX_LOG_LINES = 5000;

function appendLog(managed: ManagedProcess, line: string) {
  managed.logs.push(line);
  if (managed.logs.length > MAX_LOG_LINES) {
    managed.logs.splice(0, managed.logs.length - MAX_LOG_LINES);
  }
}

async function pipeStream(stream: ReadableStream<Uint8Array>, managed: ManagedProcess) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (line) appendLog(managed, line);
      }
    }
  } catch (e) {
    console.error("Stream pipe error:", e);
  }
}

export async function installSynapse(workspacePath: string): Promise<void> {
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  // Add synapse dep to existing or new package.json
  const pkgPath = join(workspacePath, "package.json");
  let pkg: any = {};
  if (existsSync(pkgPath)) {
    pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
  }
  if (!pkg.dependencies) pkg.dependencies = {};
  if (!pkg.dependencies["deus-ex-synapse"]) {
    pkg.dependencies["deus-ex-synapse"] = "github:Deus-Ex-Crustacean/Synapse";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  const proc = spawn(["bun", "install"], {
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Synapse install failed in ${workspacePath}`);
}

export async function startWorkspace(workspaceId: string): Promise<void> {
  if (processes.has(workspaceId)) return;

  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error(`Workspace ${workspaceId} not found`);

  const eventTypes = mergeSubscriptions(ws.id);

  const proc = spawn(["bun", "run", "node_modules/deus-ex-synapse/src/index.ts"], {
    cwd: ws.path,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      EGO_URL: config.ego.url,
      EGO_CLIENT_ID: ws.machineUserClientId,
      EGO_CLIENT_SECRET: ws.machineUserClientSecret,
      CORTEX_URL: config.cortex.url,
      EVENT_TYPES: eventTypes.join(","),
      WORKSPACE_ID: ws.id,
      WORKSPACE_NAME: ws.name,
    },
  });

  const managed: ManagedProcess = {
    proc,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    logs: [],
  };

  pipeStream(managed.stdout, managed);
  pipeStream(managed.stderr, managed);

  processes.set(workspaceId, managed);
}

export async function stopWorkspace(workspaceId: string): Promise<void> {
  const managed = processes.get(workspaceId);
  if (!managed) return;
  managed.proc.kill();
  await managed.proc.exited;
  processes.delete(workspaceId);
}

export function isRunning(workspaceId: string): boolean {
  return processes.has(workspaceId);
}

export function getWorkspaceLogs(workspaceId: string): string[] {
  return processes.get(workspaceId)?.logs ?? [];
}

export function getProcess(workspaceId: string): ManagedProcess | undefined {
  return processes.get(workspaceId);
}
