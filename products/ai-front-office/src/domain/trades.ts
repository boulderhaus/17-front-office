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
  /** Plain substrings of the call notes (straight apostrophes); a match marks the call urgent and alerts the owner. */
  urgentWords: string[];
  /** A typical caller line, shown on the homepage with the first two urgent words. */
  call: string;
}

export const TRADES: readonly Trade[] = [
  { key: "hvac", label: "Heating & air", services: ["HVAC repair", "HVAC maintenance", "Installs and replacements", "Other"], urgentWords: ["gas smell", "carbon monoxide", "no heat", "frozen pipes"], call: "AC’s blowing warm and it’s 90 upstairs." },
  { key: "plumbing", label: "Plumbing", services: ["Plumbing repair", "Drains and sewer", "Water heaters", "Leaks", "Other"], urgentWords: ["burst pipe", "sewage", "pipe burst", "flooding", "have no water"], call: "Water heater’s leaking all over the garage." },
  { key: "electrical", label: "Electrical", services: ["Electrical repair", "Panels and wiring", "Lighting and outlets", "EV chargers", "Other"], urgentWords: ["sparking", "burning smell", "exposed wires", "lost power", "power is out", "have no power"], call: "Half the house just lost power." },
  { key: "roofing", label: "Roofing", services: ["Roof repair", "Roof replacement", "Inspections", "Gutters", "Other"], urgentWords: ["water coming in", "ceiling is leaking", "dripping", "tree on the roof", "hole in the roof"], call: "Storm took some shingles. Ceiling’s dripping." },
  { key: "construction", label: "Contractors & remodelers", services: ["Remodels", "Additions", "Repairs", "Estimates", "Other"], urgentWords: ["water coming in", "structural damage", "collapsed"], call: "Can someone come quote a kitchen remodel?" },
  { key: "restoration", label: "Water & fire restoration", services: ["Water damage", "Mold", "Fire and smoke damage", "Storm damage", "Other"], urgentWords: ["flooding", "sewage", "standing water", "under water", "burst pipe", "pipe burst"], call: "Pipe burst. The basement’s under water." },
  { key: "garage", label: "Garage doors", services: ["Garage door repair", "Springs and cables", "Openers", "New doors", "Other"], urgentWords: ["stuck open", "won't close", "car is stuck", "broken spring"], call: "Door’s stuck open and my car’s inside." },
  { key: "handyman", label: "Handyman", services: ["Repairs", "Installs", "Drywall and paint", "Doors and windows", "Other"], urgentWords: ["water leak", "won't lock", "broken window"], call: "Two sticky doors and a hole in the drywall." },
  { key: "landscaping", label: "Landscaping & tree", services: ["Lawn care", "Landscaping", "Tree work", "Irrigation", "Other"], urgentWords: ["tree down", "power line", "tree fell", "came down", "tree on the house"], call: "A tree came down across the driveway." },
  { key: "pest", label: "Pest control", services: ["Pest control", "Termites", "Rodents", "Wildlife", "Other"], urgentWords: ["wasp nest", "snake in the house", "nesting", "hornets", "bat in the house"], call: "Wasps are nesting right by the front door." },
  { key: "locksmith", label: "Locksmith", services: ["Lockouts", "Rekeying", "Lock repair", "Smart locks", "Other"], urgentWords: ["locked out", "break-in", "can't get in"], call: "Locked out, and the kids get home at three." },
  { key: "appliance", label: "Appliance repair", services: ["Appliance repair", "Washers and dryers", "Refrigerators", "Ovens and ranges", "Other"], urgentWords: ["gas smell", "sparking", "burning smell", "flooding the kitchen"], call: "Fridge quit. Everything’s getting warm." },
  { key: "other", label: "Another trade", services: ["Service call", "Estimate", "Repair", "Other"], urgentWords: ["flooding", "water coming in", "gas smell"], call: "" },
];

/** The trade for a signup or link value, or null when it's missing or unknown. */
export function findTrade(key: string | null | undefined): Trade | null {
  const wanted = key?.trim().toLowerCase();
  return wanted ? TRADES.find((trade) => trade.key === wanted) ?? null : null;
}
