import { describe, expect, it } from "vitest";
import { ownerTaskReason } from "../src/domain/task-reason.js";

describe("owner task reasons", () => {
  it("never shows owners internal reason codes", () => {
    expect(ownerTaskReason("Urgent urgent call")).toBe("Urgent: call back soon");
    expect(ownerTaskReason("Urgent life_safety call")).toBe("Emergency: call back now");
    expect(ownerTaskReason("Caller requested a human")).toBe("Asked to talk to you");
    expect(ownerTaskReason("Resolve: call_ended_without_final_provider_payload, intake_incomplete")).toBe("Check the details and call back");
    expect(ownerTaskReason("Provider call ended without a final payload")).toBe("Call dropped: call them back");
    expect(ownerTaskReason("Urgent callback requested")).toBe("Urgent callback requested");
    for (const reason of ["Urgent urgent call", "Urgent life_safety call", "Resolve: x_y", "Provider call ended without a final payload"]) {
      expect(ownerTaskReason(reason)).not.toMatch(/_|payload|provider|urgent urgent/i);
    }
  });
});
