import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  asTelnyxConversationEnded,
  parseTelnyxEnvelope,
  TelnyxRecordingClient,
  TelnyxSmsAdapter,
  toTelnyxCallSummary,
  verifyTelnyxWebhook,
} from "../src/adapters/telnyx.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { OutboxNotification } from "../src/domain/models.js";
import { buildTelnyxAssistantUpdate } from "../src/voice/system-prompt.js";

describe("Telnyx provider boundary", () => {
  it("accepts a current Ed25519 signature and rejects tampering and replay", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const now = Date.parse("2026-11-20T17:00:00.000Z");
    const timestamp = String(Math.floor(now / 1_000));
    const rawBody = JSON.stringify({ data: { event_type: "assistant.initialization" } });
    const signature = sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString("base64");
    expect(verifyTelnyxWebhook(rawBody, timestamp, signature, rawPublicKey, now)).toBe(true);
    expect(verifyTelnyxWebhook(`${rawBody} `, timestamp, signature, rawPublicKey, now)).toBe(false);
    expect(verifyTelnyxWebhook(rawBody, timestamp, signature, rawPublicKey, now + 5 * 60_000 + 1)).toBe(false);
  });

  it("turns the final conversation and tool calls into durable call evidence", () => {
    const rawBody = JSON.stringify({
      data: {
        record_type: "event",
        event_type: "call.conversation.ended",
        id: "event-ended",
        occurred_at: "2026-11-20T17:02:00.000Z",
        payload: {
          assistant_id: "assistant-test",
          call_control_id: "v3:call-test",
          from: "+15555550100",
          duration_sec: 120,
          messages: [
            { role: "assistant", content: "How can I help?", timestamp: "2026-11-20T17:00:00.000Z" },
            { role: "user", content: "My furnace stopped.", timestamp: "2026-11-20T17:00:10.000Z" },
            {
              role: "assistant",
              tool_calls: [{
                id: "tool-intake",
                type: "function",
                function: {
                  name: "save_intake",
                  arguments: JSON.stringify({
                    caller_name: "Synthetic Caller",
                    callback_number: "+15555550100",
                    service_address: "100 Main St, Springfield",
                    service_category: "HVAC repair",
                    service_category_confidence: 0.98,
                    problem_description: "Furnace stopped",
                    confidence: 0.97,
                    recording_disclosure_given: true,
                  }),
                },
              }],
            },
          ],
        },
      },
    });
    const envelope = asTelnyxConversationEnded(parseTelnyxEnvelope(rawBody));
    const summary = toTelnyxCallSummary(envelope, rawBody, "demo", new Date("2026-11-20T17:02:01.000Z"), "https://front-office.example/admin/recording");
    expect(summary.providerCallId).toBe("v3:call-test");
    expect(summary.fields.callerName).toBe("Synthetic Caller");
    expect(summary.fields.address).toBe("100 Main St, Springfield");
    expect(summary.transcript).toContain("Caller: My furnace stopped.");
    expect(summary.consentState).toBe("disclosed");
  });

  it("sends idempotent SMS through the Telnyx Messages API", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { id: "message-test" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const adapter = new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      messagingProfileId: "00000000-0000-4000-8000-000000000001",
      resolveDestination: async () => "+15555550100",
      fetcher,
    });
    const notification: OutboxNotification = {
      id: "8a8a3d6a-fb2e-4c37-b5a3-95117a9f9026",
      tenantId: "demo",
      callId: "call-test",
      channel: "sms",
      destinationRef: "owner-primary",
      body: "Synthetic alert",
      priority: "high",
      state: "pending",
      attempts: 0,
      nextAttemptAt: "2026-11-20T17:00:00.000Z",
      idempotencyKey: "call-summary:call-test",
      providerReceipt: null,
      lastError: null,
      createdAt: "2026-11-20T17:00:00.000Z",
      sentAt: null,
    };
    await expect(adapter.send(notification)).resolves.toEqual({ providerReceipt: "message-test" });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/messages");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer synthetic-key",
      "idempotency-key": notification.id,
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ from: "+15555550199", to: "+15555550100", text: "Synthetic alert" });
  });

  it("retrieves a short-lived recording URL by call-control ID", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ download_urls: { mp3: "https://recordings.example/test.mp3" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const client = new TelnyxRecordingClient("synthetic-key", fetcher);
    await expect(client.getDownloadUrl("v3:call-test")).resolves.toBe("https://recordings.example/test.mp3");
    const [url] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain("filter%5Bcall_control_id%5D=v3%3Acall-test");
  });

  it("generates a Telnyx-only assistant configuration with protected tool identifiers", () => {
    const update = buildTelnyxAssistantUpdate(createDemoConfig(), "https://front-office.example");
    expect(update.tool_ids).toEqual([]);
    const serialized = JSON.stringify(update);
    expect(serialized).toContain("/webhooks/telnyx");
    expect(serialized).toContain("/tools/save-intake");
    expect(serialized).toContain("{{call_control_id}}");
    expect(serialized).toContain("{{owner_transfer_targets}}");
    expect(serialized).not.toContain("TOOL_TOKEN");
    expect(serialized).not.toContain("Retell");
    expect(serialized).not.toContain("Twilio");
  });
});
