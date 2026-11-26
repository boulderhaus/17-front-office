import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string): string => readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8");

describe("owner app words that must match what the screen shows (walk 11-26 re-walk)", () => {
  it("says two iPhone settings and lists exactly two (ONB-02)", () => {
    const card = source("components/app/forwarding-card.tsx");
    const box = card.slice(card.indexOf("function IphoneSettings"), card.indexOf("function showFix"));
    expect(box).toContain("change two settings:");
    expect(box.match(/<li>/g)).toHaveLength(2);
  });

  it("points to Alerts for emergency calls only in words that work without a saved mobile (SET-01)", () => {
    const sections = source("pages/settings-sections.tsx");
    expect(sections).toContain('settings.integrations.ownerPhoneConfigured ? "Turn on emergency calls in Alerts." : "Add your mobile in Alerts, then turn on emergency calls."');
  });

  it("never claims unticked emergencies are always flagged (SET-07)", () => {
    expect(source("pages/settings-sections.tsx")).not.toContain("Otto also flags burst pipes");
  });
});
