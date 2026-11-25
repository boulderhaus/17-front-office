import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, Navigate, useBlocker, useLocation, useParams } from "react-router-dom"
import { Check, ChevronRight, LogOut, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AppShell } from "@/components/app/shell"
import { settingsPage } from "@/components/app/settings-pages"
import { api, useApi } from "@/lib/api"
import { useMediaQuery, useMode } from "@/lib/mode"
import { leavesSettings } from "@/lib/nav"
import type { ApiSettings, SettingsValues } from "@/lib/types"
import { cn } from "@/lib/utils"
import { AlertsSection, AnsweringSection, AnswersSection, BusinessSection, CalendarSection, DataSection, PlanSection, TeamSection } from "./settings-sections"

/** Every setting lives on one of these pages: a short list on a phone, under Settings in the side menu on a computer. */
export interface SectionDef {
  id: string
  title: string
  description: string
  icon: LucideIcon
  /** Has fields that save with the Save button (the rest act on their own). */
  form: boolean
  summary: (context: SettingsContextValue) => string
  render: () => ReactNode
}

const MODE_WORDS: Record<string, string> = { always: "Otto answers every call", overflow: "Ring my phone first", after_hours: "After hours" }

export const SECTIONS: SectionDef[] = [
  { ...settingsPage("business"), form: true, description: "Name, greeting, where you work and what you fix.", summary: ({ text }) => text("businessName"), render: () => <BusinessSection /> },
  { ...settingsPage("answering"), form: true, description: "Which calls Call Otto picks up, after hours and emergencies.", summary: ({ text }) => (text("serviceState") === "paused" ? "Paused" : MODE_WORDS[text("operationMode")] ?? "On"), render: () => <AnsweringSection /> },
  { ...settingsPage("answers"), form: true, description: "The only prices and facts Call Otto may tell callers.", summary: ({ text }) => { const count = [text("priceSnippets"), text("approvedKnowledge")].join("\n").split("\n").filter((line) => line.trim()).length; return count ? `${count} saved` : "None yet" }, render: () => <AnswersSection /> },
  { ...settingsPage("alerts"), form: true, description: "How we let you know about new calls.", summary: ({ settings }) => (settings.integrations.ownerPhoneConfigured ? "Mobile saved" : "No mobile yet"), render: () => <AlertsSection /> },
  { ...settingsPage("calendar"), form: true, description: "Google Calendar, appointment hours and booking.", summary: ({ settings }) => (settings.integrations.googleConnected ? "Connected" : settings.integrations.googleAvailable ? "Not connected" : "Not available yet"), render: () => <CalendarSection /> },
  { ...settingsPage("plan"), form: false, description: "Your plan, your card, invoices, cancel.", summary: ({ settings }) => settings.plan.label, render: () => <PlanSection /> },
  { ...settingsPage("team"), form: false, description: "People who work your calls with you.", summary: () => "Invite people", render: () => <TeamSection /> },
  { ...settingsPage("data"), form: true, description: "Downloads, how long calls are kept, sign out, delete.", summary: ({ text }) => `${text("dataRetentionDays")} days`, render: () => <DataSection /> },
]
// Old links and the status pill used these ids.
const ALIASES: Record<string, string> = { shop: "business", area: "business", appointments: "calendar", emergencies: "answering" }

export interface SettingsContextValue {
  settings: ApiSettings
  values: SettingsValues
  text: (name: string) => string
  flag: (name: string) => boolean
  set: (name: string, value: string | boolean) => void
  bind: (name: string) => { name: string; value: string; onChange: (event: { target: { value: string } }) => void }
  dirty: boolean
  discard: () => void
  saving: boolean
  /** True once the server has the changes; false when it refused (the toast says why). */
  save: () => Promise<boolean>
  reload: () => Promise<void>
  /** Automated emergency calls: saved on its own, right away (it records or withdraws the owner's consent). */
  urgentBusy: boolean
  toggleUrgentCalls: (on: boolean) => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)
export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (!value) throw new Error("useSettings outside the settings area")
  return value
}

/** /app/settings and /app/settings/:section. The form state lives here, so moving between pages never loses an edit. */
export function SettingsArea() {
  const { reload: reloadDashboard } = useMode()
  const sectionId = useParams()["*"]?.replace(/\/$/, "") || undefined
  const wide = useMediaQuery("(min-width: 1024px)")
  const settings = useApi<ApiSettings>("/api/app/settings")
  const [values, setValues] = useState<SettingsValues | null>(null)
  const [saving, setSaving] = useState(false)
  const [urgentBusy, setUrgentBusy] = useState(false)
  // Saved on its own, right away: it records (or withdraws) the owner's consent to automated calls.
  const toggleUrgentCalls = async (on: boolean) => {
    setUrgentBusy(true)
    try {
      const result = await api<{ urgentCalls: NonNullable<ApiSettings["urgentCalls"]> }>("/api/app/alerts/urgent-calls", { method: "POST", body: { on } })
      if (settings.data) settings.setData({ ...settings.data, urgentCalls: result.urgentCalls })
      toast.success(on ? "We’ll call your mobile about emergencies." : "Emergency calls are off.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t change. Please try again.")
    } finally {
      setUrgentBusy(false)
    }
  }
  useEffect(() => { if (settings.data) setValues(settings.data.values) }, [settings.data])
  const section = SECTIONS.find((item) => item.id === sectionId) ?? null

  const context = useMemo<SettingsContextValue | null>(() => {
    if (!settings.data || !values) return null
    const saved = settings.data.values
    const text = (name: string) => String(values[name] ?? "")
    const set = (name: string, value: string | boolean) => setValues((current) => ({ ...(current ?? {}), [name]: value }))
    return {
      settings: settings.data,
      values,
      text,
      flag: (name) => values[name] === true,
      set,
      bind: (name) => ({ name, value: text(name), onChange: (event) => set(name, event.target.value) }),
      dirty: Object.keys(values).some((key) => values[key] !== saved[key]),
      discard: () => setValues(saved),
      saving,
      save: async () => {
        setSaving(true)
        try {
          const next = await api<ApiSettings>("/api/app/settings", { method: "PUT", body: values })
          settings.setData(next)
          setValues(next.values)
          await reloadDashboard()
          toast.success("Saved.")
          return true
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "That didn’t save. Please try again.")
          return false
        } finally {
          setSaving(false)
        }
      },
      reload: async () => { await settings.reload(); await reloadDashboard() },
      urgentBusy,
      toggleUrgentCalls,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, values, saving, reloadDashboard, urgentBusy])

  const dirty = context?.dirty ?? false

  if (sectionId && !section) return <Navigate to={ALIASES[sectionId] ? `/app/settings/${ALIASES[sectionId]}` : "/app/settings"} replace />
  // A computer always shows a page next to the menu; a phone shows the list first.
  if (!sectionId && wide) return <Navigate to="/app/settings/business" replace />

  const body = settings.error ? <p className="rounded-xl border bg-card p-4">{settings.error}</p>
    : !context ? <div className="grid gap-3">{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-14 w-full rounded-xl" />)}</div>
    : section ? <SectionPage section={section} /> : <SettingsIndex />
  return (
    <AppShell
      title={section && !wide ? section.title : "Settings"}
      // Phone: the page's one grey line sits under its title, like Calls, Jobs and Calendar (a computer has it in the sticky header).
      subtitle={section && !wide ? section.description : undefined}
      back={section ? { to: "/app/settings", label: "Settings" } : undefined}
    >
      {/* Wide screens: the pages are listed under Settings in the side menu, so the chosen page has the full width. */}
      <SettingsContext.Provider value={context}>
        <div className="min-w-0">{body}</div>
        <LeaveGuard dirty={dirty} />
      </SettingsContext.Provider>
    </AppShell>
  )
}

/**
 * Leaving Settings with unsaved changes (the menu, the drawer, Back, a call link) asks first: Save, Discard or Stay.
 * Moving between settings pages never asks: the edit travels with them. A reload or closing the tab gets the
 * browser's own "Leave site?".
 */
function LeaveGuard({ dirty }: { dirty: boolean }) {
  const context = useContext(SettingsContext)
  const blocker = useBlocker(({ nextLocation }) => dirty && leavesSettings(nextLocation))
  useEffect(() => {
    if (!dirty) return
    const hold = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", hold)
    return () => window.removeEventListener("beforeunload", hold)
  }, [dirty])
  // Saved or discarded while the question was up (the dialog's Save and Discard included): nothing is left to lose, so go.
  // This is the only place that moves on: a second proceed (from a button as well) throws in React Router.
  useEffect(() => { if (blocker.state === "blocked" && !dirty) blocker.proceed() }, [blocker, dirty])
  // The blocker as it is now, not as it was when Save was tapped: Stay may have closed the question mid-save.
  const latest = useRef(blocker)
  useEffect(() => { latest.current = blocker }, [blocker])
  if (!context) return null
  const { save, saving, discard } = context
  return (
    <AlertDialog open={blocker.state === "blocked"} onOpenChange={(open) => { if (!open && blocker.state === "blocked") blocker.reset() }}>
      {/* Stay: back to the page, not to a menu row that closed with the drawer. */}
      <AlertDialogContent onCloseAutoFocus={() => requestAnimationFrame(() => { if (document.activeElement === document.body) document.getElementById("main")?.focus({ preventScroll: true }) })}>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>Your changes aren’t saved yet.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay</AlertDialogCancel>
          <Button type="button" variant="outline" size="tap" disabled={saving} onClick={discard}>Discard</Button>
          <Button type="button" size="tap" disabled={saving} onClick={() => void save().then((saved) => { if (!saved && latest.current.state === "blocked") latest.current.reset?.() })}>{saving ? "Saving…" : "Save"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Phone: one short list, each row with its current value, each opening its own page. */
function SettingsIndex() {
  const context = useSettings()
  return (
    <div className="grid gap-5 lg:hidden">
      {context.dirty && <UnsavedBar />}
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {SECTIONS.map((item) => (
          <Link key={item.id} to={`/app/settings/${item.id}`} className="flex min-h-15 items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-brand-ink"><item.icon className="size-5" /></span>
            <span className="grid min-w-0 flex-1">
              <span className="text-base font-medium">{item.title}</span>
              <span className="truncate text-sm text-muted-foreground">{item.summary(context)}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
      <a href="/logout" className="flex min-h-14 items-center gap-3 rounded-xl border bg-card px-4 text-base font-medium"><LogOut className="size-5" />Sign out</a>
    </div>
  )
}

function UnsavedBar() {
  const { save, saving } = useSettings()
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-2 text-[15px] text-amber-950 ring-1 ring-amber-200 ring-inset">
      <strong className="font-semibold">You have unsaved changes.</strong>
      <Button size="tap" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
    </div>
  )
}

/**
 * Save: on a computer it sits top right in the page's own sticky header, always in view and disabled until
 * something changes (Stripe and Vercel put it with the content it saves, never floating mid-screen).
 * On a phone it is a bar pinned to the bottom of the screen, shown only while there is something to save.
 */
function SectionPage({ section }: { section: SectionDef }) {
  const { save, saving, dirty, discard } = useSettings()
  const location = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [location.pathname])
  const saveButton = (className?: string) => dirty || saving
    ? <Button size="tap" type="submit" className={cn("min-w-36", className)} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
    : <span className={cn("inline-flex h-12 min-w-36 items-center justify-center gap-1.5 text-[15px] font-medium text-muted-foreground lg:pointer-fine:h-10", className)}><Check className="size-4" />All changes saved</span>
  const body = (
    <>
      <header className="sticky top-0 z-10 -mx-1 hidden items-center justify-between gap-6 border-b bg-card/95 px-1 py-3 backdrop-blur-md lg:flex">
        <div className="grid gap-0.5">
          <h2 className="text-[22px] font-semibold tracking-tight">{section.title}</h2>
          <p className="text-[15px] text-muted-foreground">{section.description}</p>
        </div>
        {section.form && (
          <div className="flex shrink-0 items-center gap-2">
            {dirty && <Button type="button" variant="ghost" size="tap" onClick={discard}>Discard</Button>}
            {saveButton()}
          </div>
        )}
      </header>
      {section.render()}
    </>
  )
  if (!section.form) return <div className="grid max-w-3xl gap-4">{body}</div>
  return (
    <form className="grid max-w-3xl gap-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
      {body}
      {dirty && (
        <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t bg-card/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-md lg:hidden">
          <Button type="button" variant="outline" size="tap" className="flex-1" onClick={discard}>Discard</Button>
          {saveButton("flex-[2]")}
        </div>
      )}
    </form>
  )
}
