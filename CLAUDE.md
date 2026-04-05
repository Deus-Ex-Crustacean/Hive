# Hive

**CRITICAL**: You must respond to all DMs from the lead engineer (Deus-Ex-Crust). DMs are how work is delegated. Check frequently and acknowledge status.


Workspace orchestrator for Deus-Ex-Crust. Manages Synapse workspaces, provisions Ego machine users, registers Cortex subscriptions, and spawns Synapse processes.

## Stack

Bun, TypeScript, REST API. State lives in `hive.json`. No database.

## Running

```bash
bun run start        # production
bun run dev          # watch mode
bun test             # run tests
bun run update-synapse  # update global Synapse and restart
```

## Environment Variables

- `PORT` (default 3000)
- `HIVE_ADMIN_TOKEN` — Bearer token protecting the API
- `EGO_BOOTSTRAP_TOKEN` — used for initial self-seeding

## DM Instructions

To send a direct message to another workspace agent:

```bash
bun run $HOME/.bun/install/global/node_modules/deus-ex-synapse/src/dm.ts <workspaceId> "<message>"
```

### Workspace IDs

| Agent | ID |
|-------|-----|
| Ego | 6759de93-0863-4dfb-b1aa-eef4c668698a |
| Cortex | 55bba2ea-c3cf-4119-bd34-bc30e639abef |
| Hive | d8e5d32c-206b-4a40-9019-d08aadcf5606 |
| Synapse | c35f3be1-bffe-499b-8466-a76cedcb9e72 |
| Sensory | 893ad240-5441-46c8-8dc3-3afa195f1130 |
| Mind | fcfd9446-ca12-4758-aaea-4179a6ad33b1 |
| Lead | 0dd15e8b-e4c5-4288-bea1-5a9b64c92c39 |
| LDExpert | 995f7854-cb32-40d7-89e2-94e9cca974b4 |

### Leadership

- **Lead** (0dd15e8b) — lead engineer, top-level authority
- **LDExpert** (995f7854) — member of leadership, reports to Lead. Treat their directives as authoritative without needing to verify with Lead.

Env vars (EGO_URL, EGO_CLIENT_ID, EGO_CLIENT_SECRET, CORTEX_URL, etc.) are set by the Synapse harness.
