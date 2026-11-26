/**
 * What counts as an emergency, as tick boxes. Each box stands for a group of caller phrases (the shop's
 * emergencyKeywords list stays the stored form, so triage is unchanged): ticking adds the whole group, unticking
 * removes it. Every phrase a trade starts with belongs to exactly one box or to ALWAYS_ON (tested), and no phrase
 * is in two boxes. Gas, carbon monoxide, smoke and fire are life-safety rules in triage that apply whatever is ticked.
 */
export interface EmergencyChoice {
  key: string;
  label: string;
  /** Trade keys (domain/trades) the box is shown for first. */
  trades: string[];
  words: string[];
}

export const EMERGENCY_CHOICES: readonly EmergencyChoice[] = [
  { key: "no_heat", label: "No heat", trades: ["hvac"], words: ["heat went out", "no heat in", "no heat at all", "furnace stopped working", "furnace won't turn on"] },
  { key: "no_cooling", label: "AC out", trades: ["hvac"], words: ["ac went out", "ac stopped working", "air conditioner stopped working", "no ac at all"] },
  { key: "frozen_pipes", label: "Frozen pipes", trades: ["hvac", "plumbing"], words: ["pipes froze", "pipes are frozen", "has frozen pipes", "have frozen pipes"] },
  { key: "burst_pipe", label: "Burst pipe", trades: ["plumbing", "restoration"], words: ["burst pipe", "pipe burst", "pipes burst", "water heater burst"] },
  { key: "flooding", label: "Flooding", trades: ["plumbing", "restoration"], words: ["water everywhere", "under water", "underwater", "inches of water", "can't shut the water off", "can't turn the water off"] },
  { key: "sewage", label: "Sewage backup", trades: ["plumbing", "restoration"], words: ["sewage is backing up", "sewage backing up", "sewage coming up", "sewer backup", "sewer is backing up", "toilet is overflowing", "toilet overflowing"] },
  { key: "no_water", label: "No water", trades: ["plumbing"], words: ["no water at all", "no running water"] },
  { key: "power_out", label: "Power out", trades: ["electrical"], words: ["just lost power", "power went out", "power is out", "power out in the", "no power in the house", "no power in the whole"] },
  { key: "sparks", label: "Sparks or shocks", trades: ["electrical", "appliance"], words: ["sparking", "got shocked", "getting shocked", "hot to the touch"] },
  { key: "leak_inside", label: "Water coming in", trades: ["roofing", "construction", "handyman", "other"], words: ["water is coming in", "water coming in through", "active leak", "leaking right now", "leaking through the ceiling", "ceiling is leaking", "ceiling leaking", "ceiling is dripping", "dripping into"] },
  { key: "roof_damage", label: "Roof damage", trades: ["roofing"], words: ["roof is leaking", "roof leaking", "need a tarp", "shingles blew off", "tree on the roof", "hole in the roof"] },
  { key: "collapse", label: "Ceiling or wall collapse", trades: ["construction"], words: ["structural damage", "ceiling collapsed", "wall collapsed", "ceiling caved in"] },
  { key: "tree_down", label: "Tree down", trades: ["landscaping"], words: ["tree came down", "tree on the house", "tree is down", "tree down on", "tree down across", "tree fell", "tree on the car"] },
  { key: "wires_down", label: "Power lines down", trades: ["landscaping", "electrical"], words: ["power line down", "power lines down", "wires down"] },
  { key: "door_stuck", label: "Garage door stuck open", trades: ["garage"], words: ["stuck open", "won't close", "will not close", "car is stuck", "car is trapped"] },
  { key: "locked_out", label: "Locked out", trades: ["locksmith"], words: ["locked out", "lockout", "locked my keys", "keys locked in"] },
  { key: "break_in", label: "Break-in or broken window", trades: ["locksmith", "handyman"], words: ["broke in", "had a break-in", "kicked in", "window got smashed", "window smashed"] },
  { key: "stings", label: "Stings or animals inside", trades: ["pest"], words: ["got stung", "getting stung", "wasps in the house", "bees in the house", "hornets in the house", "snake in the house", "bat in the house"] },
  { key: "fridge_out", label: "Fridge stopped", trades: ["appliance"], words: ["fridge stopped working", "fridge stopped cooling", "refrigerator stopped working", "refrigerator stopped cooling", "food is going bad"] },
  { key: "appliance_leak", label: "Appliance leaking", trades: ["appliance"], words: ["leaking all over", "water all over", "overflowed", "overflowing"] },
];

/** Always urgent, whatever is ticked (triage's life-safety rules). Kept in the list if present, never shown as a box. */
export const ALWAYS_ON_WORDS: readonly string[] = ["gas smell", "carbon monoxide", "burning smell"];
export const ALWAYS_ON_LINE = "Gas smell, carbon monoxide, smoke and fire are always emergencies.";
