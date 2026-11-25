/**
 * The trades Call Otto starts a shop with. Picking one at signup seeds the shop's services and
 * the extra words that mark a call urgent; the owner changes either anytime in Settings.
 * Life-safety rules (gas, carbon monoxide, fire) apply to every trade regardless of these words.
 */
export interface Trade {
  key: string;
  label: string;
  /**
   * Services Otto offers callers. No "Other": the agent files a call it can't place as "other", and
   * that must stay unbookable so the owner confirms anything outside these.
   */
  services: string[];
  /**
   * Phrases matched as whole words in the call notes (case, apostrophes, "is"/"'s" and negation
   * handled in triage: "the roof's leaking" matches "roof is leaking", "no flooding" never matches).
   * A match marks the call urgent and alerts the owner, so specific phrases only: a bare "flooding",
   * "wasp nest" or "power line" would page the owner for routine quotes. The first two are shown on
   * the homepage, so they're never the always-on life-safety ones (gas, carbon monoxide, burning smell).
   */
  urgentWords: string[];
  /** A typical caller line for the homepage. Urgent-sounding ones must trip this trade's own words (tested). */
  call: string;
}

export const TRADES: readonly Trade[] = [
  { key: "hvac", label: "Heating & air", services: ["HVAC repair", "HVAC maintenance", "Installs and replacements"], urgentWords: ["heat went out", "pipes froze", "no heat in", "no heat at all", "furnace stopped working", "furnace won't turn on", "pipes are frozen", "has frozen pipes", "have frozen pipes", "gas smell", "carbon monoxide"], call: "Heat went out and it’s 30 degrees outside." },
  { key: "plumbing", label: "Plumbing", services: ["Plumbing repair", "Drains and sewer", "Water heaters", "Leaks"], urgentWords: ["burst pipe", "sewage is backing up", "pipe burst", "pipes burst", "sewer backup", "sewer is backing up", "sewage coming up", "water heater burst", "can't shut the water off", "can't turn the water off", "toilet is overflowing", "toilet overflowing", "sewage backing up", "water everywhere", "pipes are frozen", "has frozen pipes", "have frozen pipes", "pipes froze", "no water at all", "no running water"], call: "Sewage is backing up into the tub." },
  { key: "electrical", label: "Electrical", services: ["Electrical repair", "Panels and wiring", "Lighting and outlets", "EV chargers"], urgentWords: ["sparking", "just lost power", "power went out", "power is out", "power out in the", "no power in the house", "no power in the whole", "got shocked", "getting shocked", "hot to the touch", "burning smell"], call: "Half the house just lost power." },
  { key: "roofing", label: "Roofing", services: ["Roof repair", "Roof replacement", "Inspections", "Gutters"], urgentWords: ["water is coming in", "roof is leaking", "roof leaking", "water coming in through", "active leak", "leaking through the ceiling", "ceiling is leaking", "ceiling leaking", "ceiling is dripping", "dripping into", "need a tarp", "shingles blew off", "tree on the roof", "hole in the roof"], call: "Storm took some shingles. Now the roof is leaking." },
  { key: "construction", label: "Contractors & remodelers", services: ["Remodels", "Additions", "Repairs", "Estimates"], urgentWords: ["water is coming in", "structural damage", "water coming in through", "ceiling collapsed", "wall collapsed", "ceiling caved in"], call: "Can someone come quote a kitchen remodel?" },
  // No fire restoration yet: a caller describing a past fire trips the life-safety fire rule.
  { key: "restoration", label: "Water damage & mold", services: ["Water damage", "Mold", "Storm damage"], urgentWords: ["pipe burst", "under water", "underwater", "burst pipe", "water everywhere", "sewage is backing up", "inches of water"], call: "Pipe burst. The basement’s under water." },
  { key: "garage", label: "Garage doors", services: ["Garage door repair", "Springs and cables", "Openers", "New doors"], urgentWords: ["stuck open", "won't close", "will not close", "car is stuck", "car is trapped"], call: "Door’s stuck open and my car’s inside." },
  { key: "handyman", label: "Handyman", services: ["Repairs", "Installs", "Drywall and paint", "Doors and windows"], urgentWords: ["water is coming in", "leaking right now", "water coming in through", "window got smashed", "window smashed"], call: "Two sticky doors and a hole in the drywall." },
  { key: "landscaping", label: "Landscaping & tree", services: ["Lawn care", "Landscaping", "Tree work", "Irrigation"], urgentWords: ["tree came down", "tree on the house", "tree is down", "tree down on", "tree down across", "tree fell", "tree on the car", "power line down", "power lines down", "wires down"], call: "A tree came down across the driveway." },
  { key: "pest", label: "Pest control", services: ["Pest control", "Termites", "Rodents", "Wildlife"], urgentWords: ["got stung", "snake in the house", "getting stung", "wasps in the house", "bees in the house", "hornets in the house", "bat in the house"], call: "Wasps got in the house and my son got stung." },
  { key: "locksmith", label: "Locksmith", services: ["Lockouts", "Rekeying", "Lock repair", "Smart locks"], urgentWords: ["locked out", "broke in", "lockout", "locked my keys", "keys locked in", "had a break-in", "kicked in"], call: "Locked out, and the kids get home at three." },
  { key: "appliance", label: "Appliance repair", services: ["Appliance repair", "Washers and dryers", "Refrigerators", "Ovens and ranges"], urgentWords: ["leaking all over", "sparking", "water all over", "overflowed", "overflowing", "fridge stopped working", "fridge stopped cooling", "refrigerator stopped working", "refrigerator stopped cooling", "food is going bad", "gas smell", "burning smell"], call: "Washer’s leaking all over the floor." },
  { key: "other", label: "Another trade", services: ["Service call", "Estimate", "Repair"], urgentWords: ["water is coming in", "water everywhere", "water coming in through", "gas smell"], call: "" },
];

/** The trade for a signup or link value, or null when it's missing or unknown. */
export function findTrade(key: string | null | undefined): Trade | null {
  const wanted = key?.trim().toLowerCase();
  return wanted ? TRADES.find((trade) => trade.key === wanted) ?? null : null;
}
