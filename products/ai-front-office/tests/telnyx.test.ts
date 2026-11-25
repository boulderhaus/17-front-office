import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  asTelnyxConversationEnded,
  parseTelnyxEnvelope,
  parseTelnyxTexmlCallback,
  TelnyxRecordingClient,
  TelnyxSmsAdapter,
  TelnyxVoiceRoutingClient,
  toTelnyxCallSummary,
  toTelnyxTexmlCallSummary,
  verifyTelnyxWebhook,
} from "../src/adapters/telnyx.js";
import { createDemoConfig } from "../src/domain/config.js";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { OutboxWorker } from "../src/application/outbox-worker.js";
import { NotificationHeldError } from "../src/ports.js";
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

  it("normalizes TeXML form conversation callbacks into durable call evidence", () => {
    const rawBody = new URLSearchParams({
      CallStatus: "conversation_ended",
      CallSid: "v3:texml-call",
      CallSessionId: "session-test",
      ConversationId: "conversation-test",
      DurationSec: "42",
      Messages: JSON.stringify([
        { role: "user", content: "The furnace stopped.", timestamp: "2026-11-20T17:00:10.000Z" },
        {
          role: "assistant",
          timestamp: "2026-11-20T17:00:30.000Z",
          tool_calls: [{
            id: "tool-intake",
            type: "function",
            function: { name: "save_intake", arguments: JSON.stringify({ caller_name: "Synthetic Caller", problem_description: "Furnace stopped" }) },
          }],
        },
      ]),
    }).toString();
    expect(parseTelnyxTexmlCallback(rawBody)).toEqual({ callStatus: "conversation_ended", providerCallId: "v3:texml-call" });
    const summary = toTelnyxTexmlCallSummary(rawBody, "demo", new Date("2026-11-20T17:01:00.000Z"), "https://front-office.example/admin/recording");
    expect(summary.providerCallId).toBe("v3:texml-call");
    expect(summary.durationSeconds).toBe(42);
    expect(summary.fields.callerName).toBe("Synthetic Caller");
    expect(summary.transcript).toContain("Caller: The furnace stopped.");
  });

  it("sends idempotent SMS through the Telnyx Messages API", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { id: "message-test" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const adapter = new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      textingApproved: true,
      messagingProfileId: "00000000-0000-4000-8000-000000000001",
      resolveDestination: async () => "+15555550100",
      webhookUrl: "https://front-office.example/webhooks/telnyx",
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
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      from: "+15555550199",
      to: "+15555550100",
      text: "Otto: Synthetic alert",
      webhook_url: "https://front-office.example/webhooks/telnyx",
    });
  });

  it("brands owner texts and adds the STOP line only to the first one a number gets, even across retries and replicas", async () => {
    const store = new InMemoryStore();
    const texts: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      texts.push(JSON.parse(String(init.body)).text as string);
      return jsonResponse({ data: { id: `message-${texts.length}` } });
    }) as unknown as typeof fetch;
    // Two adapters on one store stand in for two replicas.
    const replica = () => new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      textingApproved: true,
      resolveDestination: async () => "+15555550100",
      claimStopNotice: (phone, id, firstAttempt) => store.claimSmsStopNotice(phone, id, "2026-11-23T12:00:00.000Z", firstAttempt),
      fetcher,
    });
    const [a, b] = [replica(), replica()];
    const first = { ...syntheticNotification(), id: "11111111-1111-4111-8111-111111111111", body: "New call: Maria\n\nCall back: https://x.example/c/t" };
    const second = { ...syntheticNotification(), id: "22222222-2222-4222-8222-222222222222", body: "Otto: Today\n1 follow-up" };
    await Promise.all([a.send(first), b.send(second)]);
    await b.send(first); // a retry of the notification that holds the notice
    await a.send(second);
    const withStop = texts.filter((text) => text.endsWith("\nReply STOP to opt out"));
    expect(withStop).toHaveLength(2); // the winner, and its retry
    expect(new Set(withStop).size).toBe(1);
    expect(texts.every((text) => text.startsWith("Otto: "))).toBe(true);
    expect(texts.map((text) => text.replace(/\nReply STOP to opt out$/, "")).sort()).toEqual([
      "Otto: New call: Maria\n\nCall back: https://x.example/c/t",
      "Otto: New call: Maria\n\nCall back: https://x.example/c/t",
      "Otto: Today\n1 follow-up",
      "Otto: Today\n1 follow-up",
    ]);

    // After START the next owner text carries it again; a text that already says STOP does not use it up.
    await store.resetSmsStopNotice("+15555550100");
    texts.length = 0;
    await a.send({ ...syntheticNotification(), id: "33333333-3333-4333-8333-333333333333", body: "Call Otto by Dutchworks: You're subscribed. Reply HELP for help, STOP to cancel." });
    await a.send({ ...syntheticNotification(), id: "44444444-4444-4444-8444-444444444444", body: "New call: Bob" });
    await a.send({ ...syntheticNotification(), id: "55555555-5555-4555-8555-555555555555", body: "New call: Ana" });
    expect(texts).toEqual([
      "Call Otto by Dutchworks: You're subscribed. Reply HELP for help, STOP to cancel.",
      "Otto: New call: Bob\nReply STOP to opt out",
      "Otto: New call: Ana",
    ]);
  });

  it("never changes a retry's text, and ignores a caller's own STOP", async () => {
    const store = new InMemoryStore();
    const texts: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      texts.push(JSON.parse(String(init.body)).text as string);
      return jsonResponse({ data: { id: `message-${texts.length}` } });
    }) as unknown as typeof fetch;
    const adapter = new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      textingApproved: true,
      resolveDestination: async () => "+15555550100",
      claimStopNotice: (phone, id, firstAttempt) => store.claimSmsStopNotice(phone, id, "2026-11-23T12:00:00.000Z", firstAttempt),
      fetcher,
    });
    const holder = { ...syntheticNotification(), id: "11111111-1111-4111-8111-111111111111", attempts: 1, body: "New call: Ana" };
    const loser = { ...syntheticNotification(), id: "22222222-2222-4222-8222-222222222222", attempts: 1, body: "New call: Bo" };
    await adapter.send(holder);
    await adapter.send(loser);
    await store.releaseSmsStopNotice(holder.id); // the holder went dead
    await adapter.send({ ...loser, attempts: 2 }); // the loser's retry must not take the freed notice
    await adapter.send({ ...syntheticNotification(), id: "33333333-3333-4333-8333-333333333333", attempts: 1, body: "New call: Cy\n- STOP valve stuck\n\nCall back: https://x.example/c/t" });
    expect(texts).toEqual([
      "Otto: New call: Ana\nReply STOP to opt out",
      "Otto: New call: Bo",
      "Otto: New call: Bo",
      "Otto: New call: Cy\n- STOP valve stuck\n\nCall back: https://x.example/c/t\nReply STOP to opt out",
    ]);
  });

  it("leaves texts to callers unchanged", async () => {
    const store = new InMemoryStore();
    const fetcher = vi.fn(async () => jsonResponse({ data: { id: "message-caller" } })) as unknown as typeof fetch;
    const adapter = new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      textingApproved: true,
      resolveDestination: async () => null,
      claimStopNotice: (phone, id, firstAttempt) => store.claimSmsStopNotice(phone, id, "2026-11-23T12:00:00.000Z", firstAttempt),
      fetcher,
    });
    await adapter.send({ ...syntheticNotification(), destinationRef: "tel:+15555550101", body: "Suncoast Heating: Your visit is confirmed." });
    expect(JSON.parse(String(((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body)).text).toBe("Suncoast Heating: Your visit is confirmed.");
    expect(store.smsStopNotices.size).toBe(0);
  });

  it("uses the separately approved sender only for founder welcome SMS", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { id: "message-founder" } })) as unknown as typeof fetch;
    const adapter = new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      textingApproved: true,
      founderFromNumber: "+15555550200",
      resolveDestination: async () => "+15555550100",
      fetcher,
    });
    const welcome = { ...syntheticNotification(), callId: null, senderRef: "founder" as const, body: "Synthetic welcome" };
    await adapter.send(welcome);
    expect(JSON.parse(String(((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      from: "+15555550200",
      to: "+15555550100",
      text: "Synthetic welcome",
    });
  });

  it("holds owner texts without the owner's yes on file, and never holds texts to callers or the founder's note", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { id: "message-consent" } })) as unknown as typeof fetch;
    const adapter = new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      founderFromNumber: "+15555550200",
      textingApproved: true,
      resolveDestination: async () => "+15555550100",
      hasOwnerTextConsent: async () => false,
      fetcher,
    });
    await expect(adapter.send(syntheticNotification())).rejects.toBeInstanceOf(NotificationHeldError);
    expect(fetcher).not.toHaveBeenCalled();
    await adapter.send({ ...syntheticNotification(), destinationRef: "tel:+15555550101", body: "Suncoast Heating: Your visit is confirmed." });
    await adapter.send({ ...syntheticNotification(), callId: null, senderRef: "founder" as const, body: "Synthetic welcome" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses SMS to a destination that opted out", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const adapter = new TelnyxSmsAdapter({
      apiKey: "synthetic-key",
      fromNumber: "+15555550199",
      textingApproved: true,
      resolveDestination: async () => "+15555550100",
      isOptedOut: async () => true,
      fetcher,
    });
    const notification = syntheticNotification();
    await expect(adapter.send(notification)).rejects.toThrow("opted out");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disconnects and reconnects only the expected Telnyx voice route", async () => {
    let connectionId: string | null = "texml-app";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ai/assistants/assistant-test")) {
        return jsonResponse({ data: { telephony_settings: { default_texml_app_id: "texml-app" } } });
      }
      if (url.includes("/phone_numbers?")) {
        return jsonResponse({ data: [{ id: "number-test", phone_number: "+15555550199", connection_id: connectionId }] });
      }
      if (url.endsWith("/phone_numbers/number-test") && init?.method === "PATCH") {
        connectionId = (JSON.parse(String(init.body)) as { connection_id: string | null }).connection_id;
        return jsonResponse({ data: { id: "number-test", connection_id: connectionId } });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    const client = new TelnyxVoiceRoutingClient({
      apiKey: "synthetic-key",
      phoneNumber: "+15555550199",
      assistantId: "assistant-test",
      fetcher,
    });
    await expect(client.setPaused(true)).resolves.toMatchObject({ changed: true, numberId: "number-test" });
    expect(connectionId).toBeNull();
    await expect(client.setPaused(false)).resolves.toMatchObject({ changed: true, numberId: "number-test" });
    expect(connectionId).toBe("texml-app");
  });

  it("does not take over a Telnyx number assigned elsewhere", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/ai/assistants/assistant-test")) return jsonResponse({ data: { telephony_settings: { default_texml_app_id: "texml-app" } } });
      if (url.includes("/phone_numbers?")) return jsonResponse({ data: [{ id: "number-test", phone_number: "+15555550199", connection_id: "someone-elses-app" }] });
      return jsonResponse({}, 500);
    }) as unknown as typeof fetch;
    const client = new TelnyxVoiceRoutingClient({ apiKey: "synthetic-key", phoneNumber: "+15555550199", assistantId: "assistant-test", fetcher });
    await expect(client.setPaused(true)).rejects.toThrow("unexpected voice connection");
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    expect(serialized).toContain('"type":"transfer"');
    expect(serialized).toContain('"targets":"{{owner_transfer_targets}}"');
    expect(serialized).toContain('"action":"stop_transfer"');
    expect(serialized).not.toContain("TOOL_TOKEN");
    expect(serialized).not.toContain("Retell");
    expect(serialized).not.toContain("Twilio");
  });
});

describe("texts before carrier approval (10DLC)", () => {
  it("holds every text until texting is approved, except to the provider-test numbers, and never retries it", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { id: "message-test" } })) as unknown as typeof fetch;
    const unapproved = (allowed?: string[]) => new TelnyxSmsAdapter({
      apiKey: "synthetic-key", fromNumber: "+15555550199", textingApproved: false,
      ...(allowed ? { allowedDirectDestinations: new Set(allowed) } : {}),
      resolveDestination: async () => "+15555550100", fetcher,
    });
    await expect(unapproved().send(syntheticNotification())).rejects.toBeInstanceOf(NotificationHeldError);
    await expect(unapproved().send({ ...syntheticNotification(), destinationRef: "tel:+15555550100" })).rejects.toBeInstanceOf(NotificationHeldError);
    expect(fetcher).not.toHaveBeenCalled();
    // Provider test mode keeps working for the allowlisted test number only.
    await expect(unapproved(["+15555550100"]).send(syntheticNotification())).resolves.toEqual({ providerReceipt: "message-test" });

    const store = new InMemoryStore();
    await store.enqueueNotification({ ...syntheticNotification(), id: "4c7c0e8e-7c1c-4f5d-9d1f-1b8a3a7b2c01", callId: null, idempotencyKey: "held-test" });
    const clock = { now: () => new Date("2026-11-20T17:00:00.000Z") };
    const result = await new OutboxWorker(store, unapproved(), clock).runOnce();
    expect(result).toMatchObject({ sent: 0, retried: 0, dead: 0, held: 1 });
    expect((await new OutboxWorker(store, unapproved(), clock).runOnce()).held).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function syntheticNotification(): OutboxNotification {
  return {
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
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
