import { createDemoConfig } from "../../src/domain/config.js";
import type { BusinessConfig } from "../../src/domain/models.js";

/** Synthetic shops that never touched "What Otto does on a call". */
export const DEFAULT_SHOPS: Record<string, BusinessConfig> = {
  "new shop (direct booking, fee question, no prices)": { ...createDemoConfig("shop_new"), businessName: "Synthetic Heating" },
  "typical shop (prices, answers, names, confirm mode, recording notice)": {
    ...createDemoConfig("shop_typical"),
    businessName: "Synthetic Plumbing",
    greeting: "Thanks for calling Synthetic Plumbing. How can I help?",
    bookingMode: "confirm",
    requireDiagnosticFeeAcceptance: false,
    recordingDisclosure: "Calls may be recorded.",
    serviceAreaTerms: ["Springfield IL", "Chatham IL", "62701", "62704"],
    serviceCategories: ["plumbing", "drain cleaning", "water heaters", "other"],
    priceSnippets: [{ label: "Service call", text: "$89, applied to the repair." }, { label: "Drain cleaning", text: "Starts at $149." }],
    approvedKnowledge: [{ topic: "Brands", text: "We service all major brands." }, { topic: "Warranty", text: "One year on parts and labor." }],
    pronunciations: [{ term: "Chatham", spokenAs: "CHAT-um" }],
  },
  "shop with no service area": { ...createDemoConfig("shop_no_area"), businessName: "Synthetic Electric", serviceAreaTerms: [] },
};
