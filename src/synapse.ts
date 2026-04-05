import { spawn, type Subprocess } from "bun";
import { readFileSync } from "fs";
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

export async function startWorkspace(workspaceId: string): Promise<void> {
  if (processes.has(workspaceId)) return;

  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error(`Workspace ${workspaceId} not found`);

  const eventTypes = mergeSubscriptions(ws.id);

  const synapseEntry = join(process.env.HOME || "/home/brooswit", ".bun/install/global/node_modules/deus-ex-synapse/src/index.ts");
  const proc = spawn(["bun", "run", synapseEntry], {
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
      CLAUDE_MODEL: ws.model || "haiku",
      CLAUDE_EFFORT: ws.effort || "low",
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

export function injectLog(workspaceId: string, line: string): void {
  const managed = processes.get(workspaceId);
  if (managed) appendLog(managed, line);
}

export function getSynapseStatus(workspacePath: string): string {
  try {
    return readFileSync(join(workspacePath, "synapse.status"), "utf-8").trim();
  } catch {
    return "unknown";
  }
}
