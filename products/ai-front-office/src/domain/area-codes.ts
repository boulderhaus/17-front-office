/**
 * US area code → state, so a new shop gets a sensible starting service area and timezone from
 * the owner's mobile number alone. Owners refine both in Settings; an unknown code gives null.
 */
const AREA_CODES: Record<string, string> = {
  AL: "205 251 256 334 483 659 938", AK: "907", AZ: "480 520 602 623 928", AR: "327 479 501 870",
  CA: "209 213 279 310 323 341 350 357 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 840 858 909 916 925 949 951",
  CO: "303 719 720 748 970 983", CT: "203 475 860 959", DE: "302", DC: "202 771",
  FL: "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954",
  GA: "229 404 470 478 678 706 762 770 912 943", HI: "808", ID: "208 986",
  IL: "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872", IN: "219 260 317 463 574 765 812 930",
  IA: "319 515 563 641 712", KS: "316 620 785 913", KY: "270 364 502 606 859", LA: "225 318 337 504 985",
  ME: "207", MD: "227 240 301 410 443 667", MA: "339 351 413 508 617 774 781 857 978",
  MI: "231 248 269 313 517 586 616 679 734 810 906 947 989", MN: "218 320 507 612 651 763 924 952",
  MS: "228 471 601 662 769", MO: "235 314 417 557 573 636 660 816 975", MT: "406", NE: "308 402 531",
  NV: "702 725 775", NH: "603", NJ: "201 551 609 640 732 848 856 862 908 973", NM: "505 575",
  NY: "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934",
  NC: "252 336 472 704 743 828 910 919 980 984", ND: "701",
  OH: "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937", OK: "405 539 572 580 918", OR: "458 503 541 971",
  PA: "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878", RI: "401", SC: "803 821 839 843 854 864",
  SD: "605", TN: "423 615 629 731 865 901 931",
  TX: "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979",
  UT: "385 435 801", VT: "802", VA: "276 434 540 571 686 703 757 804 826 948", WA: "206 253 360 425 509 564",
  WV: "304 681", WI: "262 274 353 414 534 608 715 920", WY: "307",
};

const STATE_BY_CODE = new Map(Object.entries(AREA_CODES).flatMap(([state, codes]) => codes.split(" ").map((code) => [code, state] as const)));

/** Most of each state's population; the browser's own timezone wins when we have it. */
const CENTRAL = new Set(["AL", "AR", "IL", "IA", "KS", "LA", "MN", "MS", "MO", "NE", "ND", "OK", "SD", "TN", "TX", "WI"]);
const MOUNTAIN = new Set(["CO", "MT", "NM", "UT", "WY", "ID"]);

export const US_STATES = new Set(Object.keys(AREA_CODES));

/** "+19415550123" → "FL". */
export function stateForPhone(e164: string | null | undefined): string | null {
  const match = /^\+1([2-9]\d{2})\d{7}$/.exec(e164 ?? "");
  return match ? STATE_BY_CODE.get(match[1]!) ?? null : null;
}

const STATE_NAMES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware",
  DC: "district of columbia", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa",
  KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota",
  MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey",
  NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon",
  PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah",
  VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
};

/** "FL", "fl" or "Florida" → "FL"; anything else → null. */
export function stateCode(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^[a-z]{2}$/.test(text)) return US_STATES.has(text.toUpperCase()) ? text.toUpperCase() : null;
  return Object.entries(STATE_NAMES).find(([, name]) => name === text)?.[0] ?? null;
}

/** "FL" → "Florida". */
export function stateName(code: string): string {
  return STATE_NAMES[code]?.replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? code;
}

export function timezoneForState(state: string | null): string {
  if (!state) return "America/New_York";
  if (state === "AZ") return "America/Phoenix";
  if (state === "HI") return "Pacific/Honolulu";
  if (state === "AK") return "America/Anchorage";
  if (["CA", "NV", "OR", "WA"].includes(state)) return "America/Los_Angeles";
  if (MOUNTAIN.has(state)) return "America/Denver";
  if (CENTRAL.has(state)) return "America/Chicago";
  return "America/New_York";
}

/**
 * States where recording a call needs everyone's OK (all-party consent). A new shop there starts with the recording
 * notice on. The owner app's hint uses the same list (web/src/lib/recording-hint.ts; a test keeps them equal).
 */
export const ALL_PARTY_CONSENT_STATES: ReadonlySet<string> = new Set(["CA", "CT", "DE", "FL", "IL", "MD", "MA", "MI", "MT", "NV", "NH", "OR", "PA", "WA"]);
