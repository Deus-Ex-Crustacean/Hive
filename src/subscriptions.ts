import { getConfig } from "./config";

export function mergeSubscriptions(workspaceId: string, groupIds: string[] = []): string[] {
  const config = getConfig();
  const set = new Set<string>();

  // Workspace-specific channels
  set.add(`prompt.${workspaceId}`);
  set.add(`dm.${workspaceId}`);
  set.add(`emergency.${workspaceId}`);

  for (const sub of config.defaultSubscriptions) set.add(sub);
  for (const gid of groupIds) {
    const groupSubs = config.groupSubscriptions[gid];
    if (groupSubs) for (const sub of groupSubs) set.add(sub);
  }

  return [...set];
}
