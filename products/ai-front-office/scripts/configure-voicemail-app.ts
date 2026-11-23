/**
 * Creates (or finds by name) the shared TeXML "voicemail" application used for the billing grace
 * line, and prints its id for TELNYX_VOICEMAIL_APP_ID.
 *
 *   TELNYX_API_KEY=... PUBLIC_BASE_URL=https://front-office.example.com \
 *     node --import tsx scripts/configure-voicemail-app.ts           # dry run: find only
 *   ... node --import tsx scripts/configure-voicemail-app.ts --apply  # create or fix the voice URL
 */
import { withTimeout } from "../src/application/retry.js";

const FRIENDLY_NAME = process.env.TELNYX_VOICEMAIL_APP_NAME ?? "Front Office grace voicemail";
const apply = process.argv.includes("--apply");
const apiKey = process.env.TELNYX_API_KEY;
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
if (!apiKey) throw new Error("TELNYX_API_KEY is required");
if (!publicBaseUrl?.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be an https:// URL");
const voiceUrl = `${publicBaseUrl}/texml/voicemail`;

interface TexmlApplication { id: string; friendly_name?: string; voice_url?: string; voice_method?: string }

async function telnyx<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await withTimeout(fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...init?.headers },
  }), 15_000);
  const payload = await response.json().catch(() => ({})) as T & { errors?: Array<{ detail?: string }> };
  if (!response.ok) throw new Error(`Telnyx ${init?.method ?? "GET"} ${path} failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
  return payload;
}

const listed = await telnyx<{ data?: TexmlApplication[] }>(`/texml_applications?filter[friendly_name]=${encodeURIComponent(FRIENDLY_NAME)}&page[size]=250`);
const existing = listed.data?.find((app) => app.friendly_name === FRIENDLY_NAME) ?? null;
const desired = { voice_url: voiceUrl, voice_method: "post" };

if (existing) {
  const upToDate = existing.voice_url === voiceUrl && existing.voice_method?.toLowerCase() === "post";
  if (!upToDate && apply) await telnyx(`/texml_applications/${encodeURIComponent(existing.id)}`, { method: "PATCH", body: JSON.stringify(desired) });
  console.log(JSON.stringify({ mode: apply ? "applied" : "dry_run", action: upToDate ? "found" : apply ? "updated_voice_url" : "would_update_voice_url", id: existing.id, voiceUrl }, null, 2));
} else if (!apply) {
  console.log(JSON.stringify({ mode: "dry_run", action: "would_create", friendlyName: FRIENDLY_NAME, voiceUrl }, null, 2));
} else {
  const created = await telnyx<{ data?: TexmlApplication }>("/texml_applications", {
    method: "POST",
    body: JSON.stringify({ friendly_name: FRIENDLY_NAME, active: true, ...desired }),
  });
  if (!created.data?.id) throw new Error("Telnyx did not return the new TeXML application id");
  console.log(JSON.stringify({ mode: "applied", action: "created", id: created.data.id, voiceUrl }, null, 2));
}
console.log("Set TELNYX_VOICEMAIL_APP_ID to the id above.");
