import { getConfig, saveConfig } from "./config";

let accessToken: string | null = null;

export async function authenticate(): Promise<void> {
  const config = getConfig();

  // Step 1: Seed admin user if needed
  if (!config.ego.clientId) {
    const bootstrapToken = process.env.EGO_BOOTSTRAP_TOKEN;
    if (!bootstrapToken) {
      throw new Error(
        "No Ego credentials in config and EGO_BOOTSTRAP_TOKEN not set. " +
        "Start Ego first, then pass its bootstrap token."
      );
    }

    console.log("Seeding: creating admin user on Ego...");
    const res = await fetch(`${config.ego.url}/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bootstrap-token": bootstrapToken,
      },
      body: JSON.stringify({ username: "hive-admin", admin: true }),
    });

    if (!res.ok) throw new Error(`Ego seed failed: ${res.status} ${await res.text()}`);

    const user = (await res.json()) as {
      id: string;
      username: string;
      client_secret: string;
    };

    config.ego.clientId = user.username;
    config.ego.clientSecret = user.client_secret;
    saveConfig();
    console.log("Seeding: admin user created and saved to config.");
  }

  // Step 2: Authenticate
  const res = await fetch(`${config.ego.url}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: config.ego.clientId,
      client_secret: config.ego.clientSecret,
    }),
  });

  if (!res.ok) throw new Error(`Ego auth failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { access_token: string };
  accessToken = data.access_token;

  // Step 3: Verify Cortex source still exists, re-register if needed
  if (config.cortex.sourceId) {
    const verifyRes = await fetch(`${config.cortex.url}/admin/sources`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (verifyRes.ok) {
      const sources = (await verifyRes.json()) as { id: string }[];
      const found = sources.some((s) => s.id === config.cortex.sourceId);
      if (!found) {
        console.log("Cortex source not found (DB reset?), re-registering...");
        config.cortex.sourceId = "";
        config.cortex.sourceSecret = "";
        saveConfig();
      }
    }
  }

  if (!config.cortex.sourceId) {
    console.log("Seeding: registering as webhook source on Cortex...");
    const srcRes = await fetch(`${config.cortex.url}/admin/sources`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "hive" }),
    });

    if (!srcRes.ok) throw new Error(`Cortex source registration failed: ${srcRes.status} ${await srcRes.text()}`);

    const source = (await srcRes.json()) as { id: string; secret: string };
    config.cortex.sourceId = source.id;
    config.cortex.sourceSecret = source.secret;
    saveConfig();
    console.log("Seeding: webhook source registered and saved to config.");
  }

  // Ensure all workspace machine users exist on Cortex
  for (const ws of config.workspaces) {
    const scimRes = await fetch(`${config.cortex.url}/scim/v2/Users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        id: ws.machineUserId,
        userName: ws.machineUserClientId,
        active: true,
      }),
    });
    // 201 = created, 409 = already exists — both fine
    if (!scimRes.ok && scimRes.status !== 409) {
      console.error(`Warning: failed to SCIM-provision ${ws.name} on Cortex: ${scimRes.status}`);
    }
  }
}

function authHeaders(): Record<string, string> {
  if (!accessToken) throw new Error("Not authenticated with Ego");
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export async function provisionMachineUser(
  username: string
): Promise<{ id: string; username: string; client_secret: string }> {
  const { ego, cortex } = getConfig();

  // Create user on Ego
  const res = await fetch(`${ego.url}/admin/users`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ username, machine: true }),
  });
  if (!res.ok) throw new Error(`Ego provision failed: ${res.status} ${await res.text()}`);
  const user = (await res.json()) as { id: string; username: string; client_secret: string };

  // SCIM-provision user on Cortex so they can subscribe to events
  const scimRes = await fetch(`${cortex.url}/scim/v2/Users`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: user.id,
      userName: user.username,
      active: true,
    }),
  });
  if (!scimRes.ok) throw new Error(`Cortex SCIM provision failed: ${scimRes.status} ${await scimRes.text()}`);

  return user;
}

export async function deprovisionMachineUser(userId: string): Promise<void> {
  const { ego, cortex } = getConfig();

  // Remove from Cortex
  await fetch(`${cortex.url}/scim/v2/Users/${userId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });

  // Remove from Ego
  const res = await fetch(`${ego.url}/admin/users/${userId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Ego deprovision failed: ${res.status} ${await res.text()}`);
}
