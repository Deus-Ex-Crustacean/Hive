import { spawn, type Subprocess } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfig } from "./config";
import { mergeSubscriptions } from "./subscriptions";
import { ldClient } from "./ld";

interface ManagedProcess {
  proc: Subprocess;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  logs: string[];
}

const processes = new Map<string, ManagedProcess>();
const intentionalStops = new Set<string>();

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

function persistLogsToConversation(workspacePath: string, logs: string[]): void {
  if (!logs.length) return;
  const convPath = join(workspacePath, "conversation.json");
  let conversation: any[] = [];
  try {
    conversation = JSON.parse(readFileSync(convPath, "utf-8"));
  } catch {}
  conversation.push({
    timestamp: Date.now(),
    type: "system",
    from: "system",
    message: `Previous run output:\n${logs.join("\n")}`,
  });
  writeFileSync(convPath, JSON.stringify(conversation, null, 2) + "\n");
}

async function watchForExit(workspaceId: string, managed: ManagedProcess, workspacePath: string): Promise<void> {
  const exitCode = await managed.proc.exited;
  if (intentionalStops.has(workspaceId)) {
    intentionalStops.delete(workspaceId);
    return;
  }
  // Unexpected exit — save buffered output as context for resume
  const logs = managed.logs.slice();
  processes.delete(workspaceId);
  console.error(`[${workspaceId}] Synapse exited unexpectedly (code ${exitCode}), saving output context and restarting...`);
  persistLogsToConversation(workspacePath, logs);
  // Restart if still enabled
  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === workspaceId);
  if (ws?.enabled) {
    try {
      await startWorkspace(workspaceId);
    } catch (e) {
      console.error(`[${workspaceId}] Failed to restart:`, e);
    }
  }
}

export async function startWorkspace(workspaceId: string): Promise<void> {
  if (processes.has(workspaceId)) return;

  const config = getConfig();
  const ws = config.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error(`Workspace ${workspaceId} not found`);

  const eventTypes = mergeSubscriptions(ws.id);

  const wsLdContext = { kind: "workspace" as const, key: ws.id, name: ws.name };
  const model = ldClient
    ? await ldClient.stringVariation("ai-model", wsLdContext, ws.model || "claude-haiku-4-5-20251001")
    : (ws.model || "claude-haiku-4-5-20251001");
  const effort = ws.effort || "low";

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
      CLAUDE_MODEL: model,
      CLAUDE_EFFORT: effort,
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
  watchForExit(workspaceId, managed, ws.path);
}

export async function stopWorkspace(workspaceId: string): Promise<void> {
  const managed = processes.get(workspaceId);
  if (!managed) return;
  intentionalStops.add(workspaceId);
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
