import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface EgoConfig {
  url: string;
  clientId: string;
  clientSecret: string;
}

export interface CortexConfig {
  url: string;
  sourceId: string;
  sourceSecret: string;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  machineUserId: string;
  machineUserClientId: string;
  machineUserClientSecret: string;
  enabled: boolean;
}

export interface HiveConfig {
  ego: EgoConfig;
  cortex: CortexConfig;
  defaultSubscriptions: string[];
  groupSubscriptions: Record<string, string[]>;
  workspaces: WorkspaceConfig[];
}

const CONFIG_PATH = join(process.cwd(), "hive.json");

let config: HiveConfig;

export function loadConfig(): HiveConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  config = JSON.parse(raw);
  return config;
}

export function getConfig(): HiveConfig {
  if (!config) return loadConfig();
  return config;
}

export function saveConfig(updated?: HiveConfig): void {
  if (updated) config = updated;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function getRedactedConfig(): object {
  const { ego, cortex, workspaces, ...rest } = getConfig();
  return {
    ego: {
      url: ego.url,
      clientId: ego.clientId,
      clientSecret: "***",
    },
    cortex: {
      url: cortex.url,
      sourceId: cortex.sourceId,
      sourceSecret: "***",
    },
    workspaces: workspaces.map((ws) => ({
      ...ws,
      machineUserClientSecret: "***",
    })),
    ...rest,
  };
}
