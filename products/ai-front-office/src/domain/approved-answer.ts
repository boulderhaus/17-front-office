import type { BusinessConfig } from "./models.js";

/** Selection only: callers and the model cannot submit a price, policy, or answer. */
export function approvedAnswer(config: BusinessConfig, kind: "price" | "answer", key: string): { status: "approved" | "unapproved"; text: string } {
  const normalized = key.trim().toLowerCase();
  const options = kind === "price" ? config.priceSnippets.map((item) => ({ key: item.label, text: item.text })) : config.approvedKnowledge.map((item) => ({ key: item.topic, text: item.text }));
  const match = options.find((item) => item.key.toLowerCase() === normalized);
  return match ? { status: "approved", text: match.text } : { status: "unapproved", text: "I don’t have an approved answer for that. I can take a message for the owner." };
}
