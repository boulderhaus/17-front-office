import { describe, expect, it } from "vitest";
import { createDemoConfig } from "../src/domain/config.js";
import { buildTelnyxAssistantUpdate, TURN_TAKING, USER_IDLE_REPLY_SECONDS } from "../src/voice/system-prompt.js";

// VOICE-02/05 (Nov 26 walk): on a real cell call Otto missed quiet one-word answers. Replaying that call's
// caller audio into a lab copy, Telnyx noise suppression removed them; with it off they were heard.
describe("Otto hears quiet cell-phone answers", () => {
  const update = buildTelnyxAssistantUpdate(createDemoConfig(), "https://front-office.example") as {
    telephony_settings: { noise_suppression: string; user_idle_reply_secs: number };
  };

  it("turns Telnyx noise suppression off", () => {
    expect(update.telephony_settings.noise_suppression).toBe("disabled");
  });

  it("leaves the idle check-in and end-of-turn timing as they were", () => {
    expect(update.telephony_settings.user_idle_reply_secs).toBe(3);
    expect(USER_IDLE_REPLY_SECONDS).toBe(3);
    expect(TURN_TAKING).toEqual({ eot_threshold: 0.75, eager_eot_threshold: 0.5, eot_timeout_ms: 1_000, interrupt_prediction_threshold: 0.5 });
  });
});
