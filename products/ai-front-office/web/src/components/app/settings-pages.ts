import { BellRing, CalendarDays, CreditCard, Database, MessageSquareQuote, PhoneIncoming, Store, Users } from "lucide-react"

/** The settings pages, in menu order. The side menu, the phone drawer and the settings list all read this one list. */
export const SETTINGS_PAGES = [
  { id: "business", title: "Business details", icon: Store },
  { id: "answering", title: "How calls are answered", icon: PhoneIncoming },
  { id: "answers", title: "Your prices and answers", icon: MessageSquareQuote },
  { id: "alerts", title: "Alerts", icon: BellRing },
  { id: "calendar", title: "Hours and Google Calendar", icon: CalendarDays },
  { id: "plan", title: "Plan and billing", icon: CreditCard },
  { id: "team", title: "Team", icon: Users },
  { id: "data", title: "Your data", icon: Database },
] as const

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]["id"]

export function settingsPage(id: SettingsPageId) {
  return SETTINGS_PAGES.find((page) => page.id === id)!
}

/** Where a settings row goes. Team is a page of its own (/app/team): every menu and list goes straight there, never through a stub. */
export function settingsPageHref(id: SettingsPageId, base = "/app"): string {
  return id === "team" ? `${base}/team` : `${base}/settings/${id}`
}
