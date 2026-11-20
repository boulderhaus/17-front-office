import type { BusinessConfig } from "./models.js";

export function createDemoConfig(tenantId = "demo"): BusinessConfig {
  return {
    tenantId,
    businessName: "North Star Heating",
    greeting: "Thanks for calling North Star Heating. I’m the owner’s AI assistant. How can I help?",
    timezone: "America/Chicago",
    serviceAreaTerms: ["Springfield", "627"],
    emergencyKeywords: ["frozen pipes", "no heat", "gas"],
    emergencyThreshold: 0.7,
    defaultServiceDurationMinutes: 90,
    ownerNotificationRefs: ["owner-primary"],
    ownerTransferNumberRef: "owner-primary",
    calendarConnectionRef: "google-primary",
    bookingMode: "confirm",
    operationMode: "after_hours",
    afterHours: {
      weekdayStart: "17:00",
      weekdayEnd: "08:00",
      weekends: true,
      holidayDates: [],
    },
    priceSnippets: [],
    approvedKnowledge: [],
    pronunciations: [],
    serviceCategories: ["HVAC repair", "HVAC maintenance", "plumbing", "electrical", "other"],
    requireDiagnosticFeeAcceptance: true,
    recordingDisclosure: "This call may be recorded and handled by an AI assistant.",
    flatMonthlyPriceCents: 4900,
  };
}

export function isInServiceArea(address: string | null, config: BusinessConfig): boolean {
  if (!address || config.serviceAreaTerms.length === 0) return true;
  const normalized = address.toLowerCase();
  return config.serviceAreaTerms.some((term) => normalized.includes(term.toLowerCase()));
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
