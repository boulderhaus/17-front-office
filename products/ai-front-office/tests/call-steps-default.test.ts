import { describe, expect, it } from "vitest";
import { buildTelnyxTools, buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
import { DEFAULT_SHOPS } from "./support/call-step-shops.js";

// The snapshot beside this file was written from main before "What Otto does on a call" existed (see the commit that
// added it). A shop that never touched the switches must get the same instructions and tools, byte for byte.
// Synthetic shops only.
const BASE = "https://front-office.example";

describe("a shop that never touched the call steps", () => {
  for (const [name, config] of Object.entries(DEFAULT_SHOPS)) {
    it(`gets today's instructions and tools, byte for byte: ${name}`, () => {
      expect(buildVoiceSystemPrompt(config)).toMatchSnapshot("instructions");
      expect(JSON.stringify(buildTelnyxTools(config, BASE), null, 1)).toMatchSnapshot("tools");
    });
  }
});
