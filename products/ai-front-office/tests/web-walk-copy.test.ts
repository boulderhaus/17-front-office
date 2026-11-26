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

describe("owner app controls (walk 11-26 re-walk)", () => {
  it("turns Unlimited on as a proposal: only the price bar's button asks to confirm", () => {
    const sections = source("pages/settings-sections.tsx");
    const flip = sections.slice(sections.indexOf("const flipUnlimited"), sections.indexOf("const apply = async"));
    expect(flip).not.toContain("setConfirmOpen(true)");
  });

  it("fits the four Jobs tabs on one phone line instead of scrolling them off the edge (APP-08)", () => {
    const jobs = source("pages/jobs.tsx");
    expect(jobs).toContain('role="tablist" aria-label="Jobs" className="grid grid-cols-4');
    expect(jobs).not.toContain("overflow-x-auto");
  });

  it("gives Call, Text and Map equal widths in one row", () => {
    expect(source("components/app/call-parts.tsx")).toContain('<div className="grid auto-cols-fr grid-flow-col gap-2">{top.map(render)}</div>');
  });

  it("keeps a two-up row of fields level when only one has a hint", () => {
    expect(source("pages/settings-sections.tsx")).toContain('<label className={cn("grid min-w-0 content-start gap-1.5", className)}>');
  });
});
