import { createHmac } from "crypto";
import { getConfig } from "./config";

export async function pushEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const { cortex } = getConfig();

  const body = JSON.stringify({ type: eventType, ...payload });

  const signature = createHmac("sha256", cortex.sourceSecret)
    .update(body)
    .digest("hex");

  const res = await fetch(`${cortex.url}/webhooks/${cortex.sourceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-signature": signature,
    },
    body,
  });

  if (!res.ok) throw new Error(`Cortex push failed: ${res.status} ${await res.text()}`);
}
