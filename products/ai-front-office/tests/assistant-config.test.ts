import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { saveAssistantConfig } from "../src/adapters/assistant-config.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";

describe("live assistant rule synchronization", () => {
  const env = { ...demoEnvironment(), DEMO_MODE: false, TELNYX_API_KEY: "synthetic-provider-key", TELNYX_ASSISTANT_ID: "synthetic-assistant", PUBLIC_BASE_URL: "https://front-office.example" };
  it("does not save rules when the provider refuses them", async () => {
    const store = new InMemoryStore();
    const original = createDemoConfig();
    await store.saveConfig(original);
    await expect(saveAssistantConfig(store, env, { ...original, businessName: "Changed" }, async () => new Response("", { status: 503 }))).rejects.toThrow("Voice configuration update failed");
    expect((await store.getConfig("demo")).businessName).toBe(original.businessName);
  });

  it("restores the previous provider configuration if the database write fails", async () => {
    const store = new InMemoryStore();
    const original = createDemoConfig();
    await store.saveConfig(original);
    vi.spyOn(store, "saveConfig").mockRejectedValueOnce(new Error("Synthetic database failure"));
    const payloads: string[] = [];
    await expect(saveAssistantConfig(store, env, { ...original, businessName: "Changed" }, async (_url, init) => { payloads.push(String(init?.body)); return Response.json({ id: "synthetic-assistant" }); })).rejects.toThrow("Synthetic database failure");
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toContain("Changed");
    expect(payloads[1]).toContain(original.businessName);
    expect((await store.getConfig("demo")).businessName).toBe(original.businessName);
  });

  it("saves configured rules only after the provider accepts them", async () => {
    const store = new InMemoryStore();
    const original = createDemoConfig();
    await store.saveConfig(original);
    await saveAssistantConfig(store, env, { ...original, businessName: "Changed" }, async () => {
      expect((await store.getConfig("demo")).businessName).toBe(original.businessName);
      return Response.json({ id: "synthetic-assistant" });
    });
    expect((await store.getConfig("demo")).businessName).toBe("Changed");
  });
});
