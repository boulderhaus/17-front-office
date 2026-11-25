import type { BusinessConfig } from "./models.js";
import { DEFAULT_USAGE_ALERT_PERCENT, isValidUsageAlertPercent } from "./usage.js";
import { stateCode } from "./area-codes.js";
import { DEFAULT_OVERAGE_CENTS_PER_CALL, DEFAULT_PLANS, normalizePlanId } from "./plans.js";

export function createDemoConfig(tenantId = "demo"): BusinessConfig {
  return {
    tenantId,
    paused: true,
    businessName: "North Star Heating",
    greeting: "Thanks for calling North Star Heating. How can I help?",
    timezone: "America/Chicago",
    serviceAreaTerms: ["Springfield IL", "62701"],
    emergencyKeywords: ["frozen pipes", "no heat", "gas"],
    emergencyThreshold: 0.7,
    defaultServiceDurationMinutes: 90,
    ownerNotificationRefs: ["owner-primary"],
    ownerTransferNumberRef: "owner-primary",
    warmTransferEnabled: false,
    calendarConnectionRef: "google-primary",
    bookingMode: "confirm",
    operationMode: "after_hours",
    // 2.5 rings ≈ 15 seconds: the GSM forwarding timer (see ringSeconds in domain/forwarding.ts).
    answerAfterRings: 2.5,
    afterHours: {
      weekdayStart: "17:00",
      weekdayEnd: "08:00",
      weekends: true,
      holidayDates: [],
    },
    bookableHours: {
      weekdayStart: "08:00",
      weekdayEnd: "17:00",
      weekends: false,
    },
    minimumLeadTimeMinutes: 120,
    priceSnippets: [],
    approvedKnowledge: [],
    pronunciations: [],
    serviceCategories: ["HVAC repair", "HVAC maintenance", "plumbing", "electrical", "other"],
    requireDiagnosticFeeAcceptance: true,
    // Optional, off by default (as Rosie and Goodcall do); the shop owns recording compliance under the terms.
    recordingDisclosure: "",
    dataRetentionDays: 30,
    supportEmail: null,
    planId: "solo",
    flatMonthlyPriceCents: DEFAULT_PLANS.solo.priceCents,
    includedCalls: DEFAULT_PLANS.solo.includedCalls,
    overageCentsPerCall: DEFAULT_OVERAGE_CENTS_PER_CALL,
    unlimitedCalls: false,
    usageAlertPercent: DEFAULT_USAGE_ALERT_PERCENT,
    customerSmsEnabled: false,
    ownerWeeklyEmailEnabled: false,
    ownerDailySmsEnabled: false,
    ownerDailySmsHour: 7,
    ownerRealtimeSmsEnabled: true,
    maxCallsPerCallerPerDay: 5,
  };
}

export function normalizeBusinessConfig(value: Partial<BusinessConfig> & Pick<BusinessConfig, "tenantId">): BusinessConfig {
  const defaults = createDemoConfig(value.tenantId);
  // Configs saved before calls-based plans: "standard"/"plus" become Solo/Pro, and minutes give way to calls.
  const { includedMinutes: _minutes, overageCentsPerMinute: _perMinute, ...rest } = value as typeof value & { includedMinutes?: unknown; overageCentsPerMinute?: unknown };
  const planId = normalizePlanId(value.planId) ?? "solo";
  const includedCalls = Number.isInteger(value.includedCalls) && Number(value.includedCalls) > 0 ? Number(value.includedCalls) : DEFAULT_PLANS[planId].includedCalls;
  const overageCentsPerCall = Number.isInteger(value.overageCentsPerCall) && Number(value.overageCentsPerCall) >= 0 ? Number(value.overageCentsPerCall) : defaults.overageCentsPerCall;
  return {
    ...defaults,
    ...rest,
    planId,
    includedCalls,
    overageCentsPerCall,
    unlimitedCalls: value.unlimitedCalls === true,
    afterHours: { ...defaults.afterHours, ...value.afterHours },
    bookableHours: { ...defaults.bookableHours, ...value.bookableHours },
    usageAlertPercent: isValidUsageAlertPercent(Number(value.usageAlertPercent)) ? Number(value.usageAlertPercent) : defaults.usageAlertPercent,
  };
}

export function isInServiceArea(address: string | null, config: BusinessConfig): boolean {
  return evaluateServiceArea(address, config).status === "covered";
}

export type ServiceAreaStatus = "covered" | "outside" | "unconfigured" | "incomplete";

export function evaluateServiceArea(address: string | null, config: BusinessConfig): {
  status: ServiceAreaStatus;
  matchedTerm: string | null;
} {
  const terms = config.serviceAreaTerms.map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) return { status: "unconfigured", matchedTerm: null };
  if (!address?.trim()) return { status: "incomplete", matchedTerm: null };

  const rawComponents = address.split(",").map((component) => component.trim()).filter(Boolean)
    .filter((component, index) => index === 0 || !/^(?:usa|us|u\.s\.a?\.?|united states(?: of america)?)$/i.test(component));
  const addressComponents = rawComponents.map(normalizeCoverageText);
  // The first component is the street unless it has no digits ("Austin, TX 78701"). House
  // numbers are never read as ZIP codes ("62701 Lake Shore Dr" is not in 627xx).
  const firstIsStreet = /\d/.test(rawComponents[0] ?? "") && rawComponents.length > 1;
  const localityStart = firstIsStreet ? 1 : 0;
  const postalCodes = rawComponents.slice(localityStart).flatMap((component) => [...component.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].map((match) => match[1]!));
  const localityText = addressComponents.slice(localityStart).join(" ").split(" ");
  for (const term of terms) {
    const normalizedTerm = normalizeCoverageText(term);
    // A whole-state term ("FL") covers any address that names that state ("Sarasota, FL 34236", "Tampa Florida").
    const wholeState = /^[A-Za-z]{2}$/.test(term) ? stateCode(term) : null;
    if (wholeState) {
      const lastWords = localityText.filter((word) => !/^\d{5}(?:-\d{4})?$/.test(word));
      if ([1, 2, 3].some((size) => lastWords.length >= size && stateCode(lastWords.slice(-size).join(" ")) === wholeState)) {
        return { status: "covered", matchedTerm: term };
      }
      continue;
    }
    if (/^\d{5}$/.test(normalizedTerm)) {
      if (postalCodes.includes(normalizedTerm)) return { status: "covered", matchedTerm: term };
      continue;
    }
    if (!normalizedTerm || !normalizedTerm.includes(" ")) continue;
    // "Sarasota FL" matches the locality wherever it starts, e.g. after "Apt 4".
    for (let index = localityStart; index < addressComponents.length; index += 1) {
      const locality = addressComponents.slice(index).join(" ");
      if (locality === normalizedTerm || locality.startsWith(`${normalizedTerm} `)) return { status: "covered", matchedTerm: term };
    }
  }
  return { status: "outside", matchedTerm: null };
}

function normalizeCoverageText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9-]+/g, " ").trim();
}

export function isCoverageActive(config: BusinessConfig, at: Date, ownerBusy: boolean): boolean {
  if (config.operationMode === "always") return true;
  if (config.operationMode === "overflow") return ownerBusy;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  if (config.afterHours.holidayDates.includes(date)) return true;
  // A shop that works Saturdays keeps weekday hours on Saturday; Sunday stays fully covered.
  if (config.afterHours.weekends && (weekday === "Sun" || (weekday === "Sat" && !config.afterHours.workSaturday))) return true;

  const minuteOfDay = Number(value("hour")) * 60 + Number(value("minute"));
  const parseTime = (time: string): number => {
    const [hours = "0", minutes = "0"] = time.split(":");
    return Number(hours) * 60 + Number(minutes);
  };
  // A Saturday-morning shop: Saturday's after hours starts when the morning ends.
  const saturdayClose = weekday === "Sat" && config.afterHours.workSaturday ? config.afterHours.saturdayEnd : undefined;
  const start = parseTime(saturdayClose ?? config.afterHours.weekdayStart);
  const end = parseTime(config.afterHours.weekdayEnd);
  return start <= end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}

/**
 * Parse what an owner types ("Sarasota, FL, Venice FL, 34236") into exact
 * coverage terms. A city without a state never matches anything, so it is an
 * error rather than a silently ignored term.
 */
export function normalizeServiceAreaInput(raw: string): { terms: string[]; errors: string[] } {
  const tokens = raw.split(/[,;\n]+/).map((token) => token.trim().replace(/\s+/g, " ")).filter(Boolean);
  const merged: string[] = [];
  for (const token of tokens) {
    const previous = merged.at(-1);
    if (/^[A-Za-z]{2}$/.test(token) && previous !== undefined && !/^\d{5}$/.test(previous) && !stateCode(previous)) merged[merged.length - 1] = `${previous} ${token}`;
    // "34236, FL": the state only qualifies the ZIP; it must not widen coverage to the whole state.
    else if (stateCode(token) && previous !== undefined && /^\d{5}$/.test(previous)) continue;
    else merged.push(token);
  }
  const terms: string[] = [];
  const errors: string[] = [];
  for (const term of merged) {
    const wholeState = stateCode(term);
    if (wholeState) terms.push(wholeState);
    else if (/^\d{5}$/.test(term)) terms.push(term);
    else if (/^[A-Za-z][A-Za-z .'-]* [A-Za-z]{2}$/.test(term)) terms.push(`${term.slice(0, -2).trimEnd()} ${term.slice(-2).toUpperCase()}`);
    else errors.push(term);
  }
  return { terms: [...new Set(terms)].slice(0, 100), errors };
}
