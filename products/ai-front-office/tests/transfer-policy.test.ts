import { describe, expect, it } from "vitest";
import { approvedTransferTargets } from "../src/application/transfer-policy.js";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { createDemoConfig } from "../src/domain/config.js";

describe("owner transfer allowlist", () => {
  it("excludes disabled transfers, self-calls, AI loops, and unconfigured targets", async () => {
    const store = new InMemoryStore();
    const config = { ...createDemoConfig(), warmTransferEnabled: true };
    expect(await approvedTransferTargets(store, config, "+15555550100", undefined)).toEqual([]);
    await store.saveIntegrationSecret("demo", "notifications", "owner-primary", "+15555550101");
    expect(await approvedTransferTargets(store, { ...config, warmTransferEnabled: false }, "+15555550100", undefined)).toEqual([]);
    expect(await approvedTransferTargets(store, config, "+15555550101", undefined)).toEqual([]);
    expect(await approvedTransferTargets(store, config, "(555) 555-0101", undefined)).toEqual([]);
    expect(await approvedTransferTargets(store, config, "15555550101", undefined)).toEqual([]);
    expect(await approvedTransferTargets(store, config, "unknown", undefined)).toEqual([]);
    expect(await approvedTransferTargets(store, config, "+15555550100", "+15555550101")).toEqual([]);
    expect(await approvedTransferTargets(store, config, "+15555550100", "+15555550199")).toEqual([{ name: "Owner", to: "+15555550101" }]);
    await store.saveIntegrationSecret("demo", "telnyx", "inbound_number", "+15555550101");
    expect(await approvedTransferTargets(store, config, "+15555550100", undefined)).toEqual([]);
  });
});
