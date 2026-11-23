/**
 * Turn on Telnyx Inbound Call Screening (inbound_call_screening: "reject_calls") for every Front Office
 * number, so spam is rejected at the carrier before the AI answers and never spends minutes.
 *
 * Numbers: every shop's telnyx/inbound_number (and any half-finished pending_number) in our database,
 * the demo line (TELNYX_FROM_NUMBER), and any number on the Telnyx account ordered by us
 * (customer_reference "front-office:…"). Numbers belonging to other products on the account are untouched.
 *
 * Dry run by default (prints the plan, writes nothing). --apply writes. Idempotent: numbers already on
 * reject_calls are skipped.
 *
 *   npm run enable:call-screening            # dry run
 *   npm run enable:call-screening -- --apply # write
 */
import { pathToFileURL } from "node:url";
import { withTimeout } from "../src/application/retry.js";
import { loadEnvironment } from "../src/config/environment.js";
import { ensureInboundCallScreening, INBOUND_CALL_SCREENING, type CallScreeningResult } from "../src/adapters/telnyx-provisioning.js";
import type { Store } from "../src/ports.js";

type Source = "shop_line" | "pending_line" | "demo_line" | "telnyx_account";

export interface EnableCallScreeningDeps {
  apply: boolean;
  apiKey: string;
  store: Store;
  demoNumber?: string | undefined;
  fetcher?: typeof fetch | undefined;
  print?: (line: string) => void;
}

export interface EnableCallScreeningReport {
  mode: "dry_run" | "applied";
  setting: { field: "inbound_call_screening"; value: typeof INBOUND_CALL_SCREENING };
  numbers: Array<CallScreeningResult & { sources: Source[]; error?: string }>;
  summary: { total: number; alreadySet: number; toChange: number; changed: number; notFound: number; failed: number };
}

export async function runEnableCallScreening(deps: EnableCallScreeningDeps): Promise<EnableCallScreeningReport> {
  const sources = new Map<string, Set<Source>>();
  const add = (phone: string | null | undefined, source: Source) => {
    if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) return;
    sources.set(phone, (sources.get(phone) ?? new Set()).add(source));
  };
  for (const tenantId of await deps.store.listTenantIds()) {
    add(await deps.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"), "shop_line");
    add(await deps.store.getIntegrationSecret(tenantId, "telnyx", "pending_number"), "pending_line");
  }
  add(deps.demoNumber, "demo_line");
  for (const phone of await listFrontOfficeNumbers(deps.apiKey, deps.fetcher)) add(phone, "telnyx_account");

  const numbers: EnableCallScreeningReport["numbers"] = [];
  for (const [phoneNumber, from] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const result = await ensureInboundCallScreening({ apiKey: deps.apiKey, phoneNumber, apply: deps.apply, fetcher: deps.fetcher });
      numbers.push({ ...result, sources: [...from] });
    } catch (error) {
      numbers.push({ phoneNumber, numberId: null, current: null, action: deps.apply ? "set" : "would_set", sources: [...from], error: error instanceof Error ? error.message : String(error) });
    }
  }
  const ok = numbers.filter((entry) => !entry.error);
  const report: EnableCallScreeningReport = {
    mode: deps.apply ? "applied" : "dry_run",
    setting: { field: "inbound_call_screening", value: INBOUND_CALL_SCREENING },
    numbers,
    summary: {
      total: numbers.length,
      alreadySet: ok.filter((entry) => entry.action === "already_set").length,
      toChange: ok.filter((entry) => entry.action === "would_set").length,
      changed: ok.filter((entry) => entry.action === "set").length,
      notFound: ok.filter((entry) => entry.action === "not_found").length,
      failed: numbers.length - ok.length,
    },
  };
  const print = deps.print ?? ((line: string) => console.log(line));
  for (const entry of numbers) {
    const verb = entry.error ? `FAILED: ${entry.error}`
      : entry.action === "would_set" ? `would change ${entry.current ?? "unset"} -> ${INBOUND_CALL_SCREENING}`
        : entry.action === "set" ? `changed ${entry.current ?? "unset"} -> ${INBOUND_CALL_SCREENING}`
          : entry.action === "already_set" ? `already ${INBOUND_CALL_SCREENING}, no change`
            : "not on this Telnyx account, skipped";
    print(`${entry.phoneNumber} (${entry.sources.join(", ")}): ${verb}`);
  }
  print(JSON.stringify({ mode: report.mode, setting: report.setting, summary: report.summary }));
  if (!deps.apply && report.summary.toChange > 0) print("Dry run: nothing was written. Re-run with --apply to change these numbers.");
  return report;
}

/** Numbers on the Telnyx account that Front Office ordered (customer_reference front-office:<tenant>). */
async function listFrontOfficeNumbers(apiKey: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const found: string[] = [];
  for (let page = 1; page <= 40; page += 1) {
    const url = new URL("https://api.telnyx.com/v2/phone_numbers");
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("page[size]", "250");
    const response = await withTimeout(fetcher(url.toString(), { headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" } }), 10_000);
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ phone_number?: unknown; customer_reference?: unknown }>; meta?: { total_pages?: unknown }; errors?: Array<{ detail?: string }> };
    if (!response.ok) throw new Error(`Telnyx phone number listing failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
    for (const item of payload.data ?? []) {
      if (typeof item.phone_number === "string" && typeof item.customer_reference === "string" && item.customer_reference.startsWith("front-office:")) found.push(item.phone_number);
    }
    const totalPages = typeof payload.meta?.total_pages === "number" ? payload.meta.total_pages : 1;
    if (page >= totalPages || (payload.data ?? []).length === 0) break;
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnvironment(process.env);
  if (!env.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is required");
  const { createRuntime } = await import("../src/runtime.js");
  const runtime = await createRuntime(env);
  try {
    const report = await runEnableCallScreening({ apply: process.argv.includes("--apply"), apiKey: env.TELNYX_API_KEY, store: runtime.store, demoNumber: env.TELNYX_FROM_NUMBER });
    if (report.summary.failed > 0) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
