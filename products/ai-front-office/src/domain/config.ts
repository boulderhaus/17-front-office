import type { BusinessConfig } from "./models.js";

export function createDemoConfig(tenantId = "demo"): BusinessConfig {
  return {
    tenantId,
    paused: true,
    businessName: "North Star Heating",
    greeting: "Thanks for calling North Star Heating. I’m the owner’s AI assistant. How can I help?",
    timezone: "America/Chicago",
    serviceAreaTerms: ["Springfield IL", "627"],
    emergencyKeywords: ["frozen pipes", "no heat", "gas"],
    emergencyThreshold: 0.7,
    defaultServiceDurationMinutes: 90,
    ownerNotificationRefs: ["owner-primary"],
    ownerTransferNumberRef: "owner-primary",
    calendarConnectionRef: "google-primary",
    bookingMode: "confirm",
    operationMode: "after_hours",
    answerAfterRings: 4,
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
    recordingDisclosure: "This call may be recorded and handled by an AI assistant.",
    dataRetentionDays: 30,
    supportEmail: null,
    flatMonthlyPriceCents: 4900,
    maxCallsPerCallerPerDay: 5,
  };
}

export function normalizeBusinessConfig(value: Partial<BusinessConfig> & Pick<BusinessConfig, "tenantId">): BusinessConfig {
  const defaults = createDemoConfig(value.tenantId);
  return {
    ...defaults,
    ...value,
    afterHours: { ...defaults.afterHours, ...value.afterHours },
    bookableHours: { ...defaults.bookableHours, ...value.bookableHours },
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

  const rawComponents = address.split(",").map((component) => component.trim()).filter(Boolean);
  const addressComponents = rawComponents.map(normalizeCoverageText);
  const localityComponents = addressComponents.slice(1);
  const lastComponent = rawComponents.at(-1) ?? "";
  const postalCodes: string[] = lastComponent.match(/\b\d{5}(?:-\d{4})?\b/g) ?? [];
  for (const term of terms) {
    const normalizedTerm = normalizeCoverageText(term);
    if (/^\d{5}(?:-\d{4})?$/.test(normalizedTerm)) {
      if (postalCodes.includes(normalizedTerm)) return { status: "covered", matchedTerm: term };
      continue;
    }
    if (/^\d{3}$/.test(normalizedTerm)) {
      if (postalCodes.some((postalCode) => postalCode.startsWith(normalizedTerm))) return { status: "covered", matchedTerm: term };
      continue;
    }
    const locality = localityComponents.join(" ");
    if (normalizedTerm && normalizedTerm.includes(" ") && (locality === normalizedTerm || locality.startsWith(`${normalizedTerm} `))) {
      return { status: "covered", matchedTerm: term };
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
  if (config.afterHours.weekends && (weekday === "Sat" || weekday === "Sun")) return true;

  const minuteOfDay = Number(value("hour")) * 60 + Number(value("minute"));
  const parseTime = (time: string): number => {
    const [hours = "0", minutes = "0"] = time.split(":");
    return Number(hours) * 60 + Number(minutes);
  };
  const start = parseTime(config.afterHours.weekdayStart);
  const end = parseTime(config.afterHours.weekdayEnd);
  return start <= end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}
