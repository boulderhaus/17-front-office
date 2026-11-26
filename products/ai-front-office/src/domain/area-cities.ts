import { normalizeServiceAreaInput } from "./config.js";

/**
 * Area code → the main cities it covers, so a new shop's "Where you work" starts with its own area ("Sarasota FL,
 * Bradenton FL…") instead of a whole state. Only the bigger metros: an area code not listed falls back to the state.
 * The owner edits the list in Settings. Cities only (no ZIPs), as callers say them.
 */
const AREAS: Array<[string, string]> = [
  // Florida
  ["941", "Sarasota FL, Bradenton FL, Venice FL, North Port FL"],
  ["239", "Fort Myers FL, Cape Coral FL, Naples FL"],
  ["305 786", "Miami FL, Miami Beach FL, Hialeah FL, Homestead FL"],
  ["954 754", "Fort Lauderdale FL, Hollywood FL, Pompano Beach FL, Coral Springs FL"],
  ["561", "West Palm Beach FL, Boca Raton FL, Boynton Beach FL, Jupiter FL"],
  ["407 689", "Orlando FL, Kissimmee FL, Winter Park FL, Sanford FL"],
  ["321", "Melbourne FL, Palm Bay FL, Cocoa FL, Titusville FL"],
  ["813 656", "Tampa FL, Brandon FL, Plant City FL"],
  ["727", "St. Petersburg FL, Clearwater FL, Largo FL"],
  ["904", "Jacksonville FL, Orange Park FL, St. Augustine FL"],
  ["850", "Tallahassee FL, Pensacola FL, Panama City FL"],
  ["352", "Gainesville FL, Ocala FL"],
  ["863", "Lakeland FL, Winter Haven FL"],
  ["386", "Daytona Beach FL, Deltona FL"],
  ["772", "Port St. Lucie FL, Vero Beach FL, Stuart FL"],
  // New York
  ["212 646 332", "New York NY"],
  ["718 347 929 917", "New York NY, Brooklyn NY, Bronx NY, Queens NY, Staten Island NY"],
  // Southeast
  ["404 470 678 770", "Atlanta GA, Marietta GA, Decatur GA, Sandy Springs GA"],
  ["704 980", "Charlotte NC, Concord NC, Gastonia NC"],
  ["919 984", "Raleigh NC, Durham NC, Cary NC"],
  ["615 629", "Nashville TN, Franklin TN, Murfreesboro TN"],
  ["901", "Memphis TN"],
  ["504", "New Orleans LA, Metairie LA, Kenner LA"],
  ["757", "Virginia Beach VA, Norfolk VA, Chesapeake VA"],
  ["502", "Louisville KY"],
  // Northeast and Midwest
  ["617 857", "Boston MA, Cambridge MA, Somerville MA"],
  ["215 267 445", "Philadelphia PA"],
  ["412", "Pittsburgh PA"],
  ["202", "Washington DC"],
  ["410 443", "Baltimore MD"],
  ["312 773 872", "Chicago IL"],
  ["847 224", "Evanston IL, Schaumburg IL, Skokie IL"],
  ["630 331", "Naperville IL, Aurora IL, Wheaton IL"],
  ["313", "Detroit MI"],
  ["216", "Cleveland OH"],
  ["614 380", "Columbus OH"],
  ["513", "Cincinnati OH"],
  ["317 463", "Indianapolis IN, Carmel IN, Fishers IN"],
  ["414", "Milwaukee WI"],
  ["612", "Minneapolis MN"],
  ["651", "St. Paul MN"],
  ["314", "St. Louis MO"],
  ["816", "Kansas City MO"],
  // Texas, Southwest and West
  ["214 469 972 945", "Dallas TX, Plano TX, Irving TX, Garland TX"],
  ["817 682", "Fort Worth TX, Arlington TX"],
  ["713 281 832 346", "Houston TX, Sugar Land TX, Pearland TX"],
  ["512 737", "Austin TX, Round Rock TX"],
  ["210 726", "San Antonio TX"],
  ["915", "El Paso TX"],
  ["405", "Oklahoma City OK, Norman OK, Edmond OK"],
  ["918", "Tulsa OK, Broken Arrow OK"],
  ["602", "Phoenix AZ"],
  ["480", "Mesa AZ, Scottsdale AZ, Chandler AZ, Gilbert AZ, Tempe AZ"],
  ["623", "Phoenix AZ, Glendale AZ, Peoria AZ"],
  ["520", "Tucson AZ"],
  ["505", "Albuquerque NM, Rio Rancho NM"],
  ["702 725", "Las Vegas NV, Henderson NV, North Las Vegas NV"],
  ["775", "Reno NV, Sparks NV"],
  ["303 720 983", "Denver CO, Aurora CO, Lakewood CO"],
  ["719", "Colorado Springs CO, Pueblo CO"],
  ["801 385", "Salt Lake City UT, West Valley City UT, Provo UT"],
  ["213 323", "Los Angeles CA"],
  ["310 424", "Los Angeles CA, Santa Monica CA, Torrance CA, Beverly Hills CA"],
  ["818 747", "Los Angeles CA, Burbank CA, Glendale CA"],
  ["626", "Pasadena CA, El Monte CA"],
  ["562", "Long Beach CA, Downey CA, Whittier CA"],
  ["714 657", "Anaheim CA, Santa Ana CA, Huntington Beach CA"],
  ["949", "Irvine CA, Newport Beach CA"],
  ["619 858", "San Diego CA, Chula Vista CA"],
  ["415 628", "San Francisco CA"],
  ["510 341", "Oakland CA, Berkeley CA, Fremont CA"],
  ["408 669", "San Jose CA, Santa Clara CA, Sunnyvale CA"],
  ["650", "San Mateo CA, Palo Alto CA, Redwood City CA"],
  ["916 279", "Sacramento CA, Elk Grove CA, Roseville CA"],
  ["909", "San Bernardino CA, Ontario CA, Pomona CA"],
  ["951", "Riverside CA, Corona CA, Temecula CA"],
  ["559", "Fresno CA, Clovis CA"],
  ["661", "Bakersfield CA, Lancaster CA, Palmdale CA"],
  ["206", "Seattle WA"],
  ["425", "Bellevue WA, Everett WA, Redmond WA"],
  ["253", "Tacoma WA"],
  ["503 971", "Portland OR, Beaverton OR, Gresham OR, Hillsboro OR"],
  ["808", "Honolulu HI"],
  ["907", "Anchorage AK"],
];

const CITIES_BY_CODE = new Map(AREAS.flatMap(([codes, cities]) => codes.split(" ").map((code) => [code, cities] as const)));

/** "+19415550123" → ["Sarasota FL", "Bradenton FL", …] (normalized service-area terms); null when the code isn't listed. */
export function areaForPhone(e164: string | null | undefined): string[] | null {
  const match = /^\+1([2-9]\d{2})\d{7}$/.exec(e164 ?? "");
  const cities = match ? CITIES_BY_CODE.get(match[1]!) : undefined;
  return cities ? normalizeServiceAreaInput(cities).terms : null;
}
