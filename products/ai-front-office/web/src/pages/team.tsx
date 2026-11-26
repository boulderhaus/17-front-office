import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CalendarDays, Check, Copy, Loader2, MailCheck, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ToneBadge } from "@/components/app/bits"
import { api, useApi } from "@/lib/api"
import { useMode } from "@/lib/mode"
import { JUMP } from "@/lib/nav"
import { cn } from "@/lib/utils"

interface TeamData {
  csrf: string
  role: "owner" | "member"
  emailConfirmed: boolean
  emailEnabled: boolean
  calendarConnected: boolean
  inRotation: boolean
  /** A teammate's own hours (they have no Settings); null for the owner, whose hours are Settings › Hours. */
  hours: { weekdayStart: string; weekdayEnd: string; weekends: boolean } | null
  timezone: string
  people: Array<{ id: string; name: string; role: "owner" | "member"; active: boolean; you: boolean }>
}

/** Same widths as Settings: full on a phone, one width on a computer. */
const ACTION = "w-full sm:w-60"
const FIELD = "h-12 bg-card text-[17px] font-medium"

/**
 * Team: a page of the owner app like every other (same shell, same parts). Who is in the shop, whether you take
 * booked jobs on your calendar, and inviting someone. The owner's hours are set once, in Hours and Google Calendar.
 */
export function TeamPage() {
  const team = useApi<TeamData>("/api/app/team")
  if (team.error && !team.data) return <p className="rounded-xl border bg-card p-4 text-[15px]">{team.error}</p>
  if (!team.data) return <div className="grid max-w-3xl gap-4"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>
  const data = team.data
  const reload = () => void team.reload()
  return (
    <div className="grid max-w-3xl gap-8">
      <You data={data} onSaved={reload} />
      {data.role === "owner" && <People data={data} onChanged={reload} />}
      {data.role === "owner" && <Invite data={data} />}
    </div>
  )
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Your calendar and whether booked jobs land on it. */
function You({ data, onSaved }: { data: TeamData; onSaved: () => void }) {
  const { base } = useMode()
  const [busy, setBusy] = useState(false)
  const [hours, setHours] = useState(data.hours)
  const member = data.role === "member"
  const save = async (enabled: boolean, next = hours) => {
    setBusy(true)
    try {
      await api("/api/app/team/rotation", { method: "POST", body: { enabled, ...(member && next ? { start: next.weekdayStart, end: next.weekdayEnd, weekends: next.weekends } : {}) } })
      toast.success(enabled ? "Booked jobs can go on your calendar." : "No booked jobs on your calendar.")
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t save. Please try again.")
    } finally {
      setBusy(false)
    }
  }
  const changedHours = member && hours && data.hours && (hours.weekdayStart !== data.hours.weekdayStart || hours.weekdayEnd !== data.hours.weekdayEnd || hours.weekends !== data.hours.weekends)
  return (
    <Section title="You">
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
          <span className="flex min-w-0 items-center gap-3">
            <CalendarDays className="size-5 shrink-0 text-muted-foreground" />
            <span className="grid">
              <strong className="text-[15px] font-semibold">Google Calendar</strong>
              <span className={cn("text-sm", data.calendarConnected ? "font-medium text-emerald-800" : "text-muted-foreground")}>{data.calendarConnected ? "Connected" : "Not connected"}</span>
            </span>
          </span>
          {!data.calendarConnected && (
            member
              ? <Button size="tap" variant="brand" className={ACTION} asChild><a href="/app/integrations/google/start">Connect Google Calendar</a></Button>
              : <Button size="tap" variant="outline" className={ACTION} asChild><Link to={`${base}/settings/calendar`} state={JUMP}>Connect in Hours</Link></Button>
          )}
        </div>
        <label htmlFor="rotation" className="flex min-h-16 cursor-pointer items-center justify-between gap-4 px-4 py-3">
          <span className="grid gap-0.5">
            <span className="text-[15px] font-semibold">Take booked jobs</span>
            <span className="text-sm text-muted-foreground">{data.calendarConnected ? "Otto books jobs into your open times." : "Connect Google Calendar first."}</span>
          </span>
          <Switch id="rotation" checked={data.inRotation && data.calendarConnected} disabled={busy || !data.calendarConnected} onCheckedChange={(value) => void save(value)} />
        </label>
        {!member && (
          <Link to={`${base}/settings/calendar`} state={JUMP} className="flex min-h-12 items-center justify-between gap-3 px-4 py-3 text-[15px] hover:bg-muted/50">
            <span className="font-semibold">Change your hours</span>
            <span aria-hidden className="text-muted-foreground">›</span>
          </Link>
        )}
      </div>
      {member && hours && (
        <form className="grid gap-4 rounded-xl border bg-card p-4" onSubmit={(event) => { event.preventDefault(); void save(data.inRotation, hours) }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="start" className="text-[15px]">First job</Label><Input id="start" type="time" className={FIELD} value={hours.weekdayStart} onChange={(event) => setHours({ ...hours, weekdayStart: event.target.value })} /></div>
            <div className="grid gap-1.5"><Label htmlFor="end" className="text-[15px]">Finish by</Label><Input id="end" type="time" className={FIELD} value={hours.weekdayEnd} onChange={(event) => setHours({ ...hours, weekdayEnd: event.target.value })} /></div>
          </div>
          <label htmlFor="weekends" className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
            <span className="text-[15px] font-semibold">Weekends too</span>
            <Switch id="weekends" checked={hours.weekends} onCheckedChange={(value) => setHours({ ...hours, weekends: value })} />
          </label>
          {changedHours && <Button size="tap" type="submit" className={ACTION} disabled={busy}>{busy && <Loader2 className="animate-spin" />}Save my hours</Button>}
        </form>
      )}
    </Section>
  )
}

function People({ data, onChanged }: { data: TeamData; onChanged: () => void }) {
  const active = data.people.filter((person) => person.active)
  return (
    <Section title="People" action={<span className="tabular text-[15px] text-muted-foreground">{active.length} of 10</span>}>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {active.map((person) => (
          <li key={person.id} className="flex min-h-16 items-center justify-between gap-3 px-4 py-3">
            <span className="flex min-w-0 items-center gap-3">
              <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-[15px] font-semibold">{person.name.trim().charAt(0).toUpperCase() || "?"}</span>
              <span className="grid min-w-0">
                <strong className="truncate text-[15px] font-semibold">{person.name}{person.you && <span className="font-normal text-muted-foreground"> (you)</span>}</strong>
                <span className="text-sm text-muted-foreground">{person.role === "owner" ? "Owner" : "Teammate"}</span>
              </span>
            </span>
            {person.role === "member" ? <RemoveButton person={person} onRemoved={onChanged} /> : <ToneBadge tone="neutral">Owner</ToneBadge>}
          </li>
        ))}
      </ul>
    </Section>
  )
}

function RemoveButton({ person, onRemoved }: { person: TeamData["people"][number]; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try {
      await api("/api/app/team/remove", { method: "POST", body: { accountId: person.id } })
      toast.success(`${person.name} can’t sign in anymore.`)
      onRemoved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t work. Please try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild><Button variant="ghost" className="h-11 px-3 text-[15px] font-semibold text-red-700 hover:bg-red-50 hover:text-red-800" disabled={busy}>Remove</Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {person.name}?</AlertDialogTitle>
          <AlertDialogDescription>They’re signed out and their calendar stops getting jobs.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11">Keep</AlertDialogCancel>
          <AlertDialogAction className="h-11 bg-red-600 text-white hover:bg-red-700" onClick={() => void remove()}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Invite someone. An owner who signed up with a password confirms the email first, with one tap. */
function Invite({ data }: { data: TeamData }) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sent, setSent] = useState(false)
  if (!data.emailConfirmed) {
    const confirm = async () => {
      setBusy(true)
      try {
        await api("/api/app/team/confirm-email", { method: "POST", body: {} })
        setSent(true)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That didn’t send. Please try again.")
      } finally {
        setBusy(false)
      }
    }
    return (
      <Section title="Invite a teammate">
        <div className="grid gap-3 rounded-xl border bg-card p-4">
          {sent ? (
            <p role="status" className="flex items-start gap-2.5 text-[15px]"><MailCheck className="mt-0.5 size-5 shrink-0 text-emerald-700" /><span><strong className="font-semibold">Check your email.</strong> Tap the link in it, then come back here.</span></p>
          ) : (
            <>
              <p className="text-[15px]">Confirm your email first, so only you can add people.</p>
              {data.emailEnabled
                ? <Button size="tap" variant="brand" className={ACTION} disabled={busy} onClick={() => void confirm()}>{busy ? <Loader2 className="animate-spin" /> : <MailCheck />}Confirm my email</Button>
                : <p className="text-sm text-muted-foreground">Email isn’t switched on yet. Try again soon.</p>}
            </>
          )}
        </div>
      </Section>
    )
  }
  const invite = async () => {
    setBusy(true)
    try {
      const result = await api<{ inviteUrl: string }>("/api/app/team/invite", { method: "POST", body: { email } })
      setLink(result.inviteUrl)
      setEmail("")
      setCopied(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t work. Please try again.")
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      toast.error("Couldn’t copy. Press and hold the link to copy it.")
    }
  }
  return (
    <Section title="Invite a teammate">
      <div className="grid gap-4 rounded-xl border bg-card p-4">
        <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void invite() }}>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email" className="text-[15px]">Their email</Label>
            <Input id="invite-email" type="email" required autoComplete="off" spellCheck={false} autoCapitalize="none" inputMode="email" placeholder="name@yourshop.com" className={FIELD} value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <Button size="tap" type="submit" className="w-full sm:w-auto" disabled={busy || !email.trim()}>{busy ? <Loader2 className="animate-spin" /> : <UserPlus />}Get invite link</Button>
        </form>
        {link && (
          <div role="status" className="grid gap-2 rounded-lg bg-secondary p-3">
            <span className="text-[15px] font-semibold">Send them this link. It works once, for 2 days.</span>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-card px-3 py-2.5 text-sm">{link}</code>
              <Button type="button" size="tap" variant="outline" className="bg-card" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
            </div>
          </div>
        )}
      </div>
    </Section>
  )
}
