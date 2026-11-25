/**
 * The trades Call Otto starts a shop with. Picking one at signup seeds the shop's services and
 * the extra words that mark a call urgent; the owner changes either anytime in Settings.
 * Life-safety rules (gas, carbon monoxide, fire) apply to every trade regardless of these words.
 */
export interface Trade {
  key: string;
  label: string;
  /** Services Otto offers callers; "Other" catches the rest so nothing is turned away. */
  services: string[];
  /**
   * Phrases matched in the call notes (case and apostrophes ignored); a match marks the call urgent and
   * alerts the owner. Specific phrases only: a bare word like "emergency" or "dripping" would page the
   * owner for routine calls. The first two are shown on the homepage, so they're never the always-on
   * life-safety ones (gas, carbon monoxide, burning smell).
   */
  urgentWords: string[];
  /** A typical caller line for the homepage. Urgent-sounding ones must trip this trade's own words (tested). */
  call: string;
}

export const TRADES: readonly Trade[] = [
  { key: "hvac", label: "Heating & air", services: ["HVAC repair", "HVAC maintenance", "Installs and replacements", "Other"], urgentWords: ["heat went out", "frozen pipes", "no heat in", "no heat at all", "heat is out", "gas smell", "carbon monoxide"], call: "Heat went out and it’s 30 degrees outside." },
  { key: "plumbing", label: "Plumbing", services: ["Plumbing repair", "Drains and sewer", "Water heaters", "Leaks", "Other"], urgentWords: ["burst pipe", "sewage", "pipe burst", "sewer backup", "flooding", "leaking all over", "leaking everywhere", "no water at all", "no running water"], call: "Sewage is backing up into the tub." },
  { key: "electrical", label: "Electrical", services: ["Electrical repair", "Panels and wiring", "Lighting and outlets", "EV chargers", "Other"], urgentWords: ["sparking", "lost power", "power is out", "power went out", "exposed wires", "burning smell"], call: "Half the house just lost power." },
  { key: "roofing", label: "Roofing", services: ["Roof repair", "Roof replacement", "Inspections", "Gutters", "Other"], urgentWords: ["water coming in", "roof is leaking", "leaking through the ceiling", "ceiling is leaking", "ceiling is dripping", "tree on the roof", "hole in the roof"], call: "Storm took some shingles. Now the roof is leaking." },
  { key: "construction", label: "Contractors & remodelers", services: ["Remodels", "Additions", "Repairs", "Estimates", "Other"], urgentWords: ["water coming in", "structural damage", "ceiling collapsed", "wall collapsed"], call: "Can someone come quote a kitchen remodel?" },
  { key: "restoration", label: "Water & fire restoration", services: ["Water damage", "Mold", "Fire and smoke damage", "Storm damage", "Other"], urgentWords: ["flooding", "under water", "sewage", "standing water", "burst pipe", "pipe burst"], call: "Pipe burst. The basement’s under water." },
  { key: "garage", label: "Garage doors", services: ["Garage door repair", "Springs and cables", "Openers", "New doors", "Other"], urgentWords: ["stuck open", "won't close", "will not close", "car is stuck", "car is trapped", "broken spring"], call: "Door’s stuck open and my car’s inside." },
  { key: "handyman", label: "Handyman", services: ["Repairs", "Installs", "Drywall and paint", "Doors and windows", "Other"], urgentWords: ["water leak", "won't lock", "will not lock", "broken window"], call: "Two sticky doors and a hole in the drywall." },
  { key: "landscaping", label: "Landscaping & tree", services: ["Lawn care", "Landscaping", "Tree work", "Irrigation", "Other"], urgentWords: ["tree down", "power line", "tree fell", "tree came down", "tree on the house", "tree on the car"], call: "A tree came down across the driveway." },
  { key: "pest", label: "Pest control", services: ["Pest control", "Termites", "Rodents", "Wildlife", "Other"], urgentWords: ["wasp nest", "snake in the house", "bees in the house", "hornets", "bat in the house", "got stung"], call: "There’s a wasp nest right by the front door." },
  { key: "locksmith", label: "Locksmith", services: ["Lockouts", "Rekeying", "Lock repair", "Smart locks", "Other"], urgentWords: ["locked out", "break-in", "broken into", "lock is broken"], call: "Locked out, and the kids get home at three." },
  { key: "appliance", label: "Appliance repair", services: ["Appliance repair", "Washers and dryers", "Refrigerators", "Ovens and ranges", "Other"], urgentWords: ["sparking", "leaking all over", "flooding", "gas smell", "burning smell"], call: "Washer’s leaking all over the floor." },
  { key: "other", label: "Another trade", services: ["Service call", "Estimate", "Repair", "Other"], urgentWords: ["flooding", "water coming in", "gas smell"], call: "" },
];

/** The trade for a signup or link value, or null when it's missing or unknown. */
export function findTrade(key: string | null | undefined): Trade | null {
  const wanted = key?.trim().toLowerCase();
  return wanted ? TRADES.find((trade) => trade.key === wanted) ?? null : null;
}
