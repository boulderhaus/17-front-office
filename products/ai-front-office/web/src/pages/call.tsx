import { useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"
import { Play } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { ActionBar, addressFact, CallBackNote, CallHeader, ExtraAnswers, Facts, phoneFact, SafetyNote, SpamNote, Transcript } from "@/components/app/call-parts"
import { CallPathCard, useLiveCallPath } from "@/components/app/call-path"
import { useTaskTiles } from "./today"
import { api, useApi } from "@/lib/api"
import { urgency } from "@/lib/derive"
import { compactDate, notificationWords, outcomeWords } from "@/lib/format"
import { useMode } from "@/lib/mode"
import { callBack } from "@/lib/nav"
import type { ApiCallDetail } from "@/lib/types"

function minutes(seconds: number | null): string {
  if (!seconds) return "Unknown"
  if (seconds < 60) return `${seconds} sec`
  return `${Math.round(seconds / 60)} min`
}

export function CallPage() {
  const { id = "" } = useParams()
  const { base, preview, dashboard, reload } = useMode()
  const navigate = useNavigate()
  const location = useLocation()
  const back = callBack({ key: location.key, state: location.state, base })
  const tiles = useTaskTiles()
  const detail = useApi<ApiCallDetail & { csrf?: string }>(`/api/${preview ? "demo" : "app"}/calls/${encodeURIComponent(id)}`)
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const tz = dashboard?.shop.timezone ?? "America/New_York"
  const [pathStale, setPathStale] = useState(false)
  useLiveCallPath(
    id,
    !preview && detail.data?.path?.live === true,
    // The call rides along, so the header, safety note and facts tick with the path.
    (path, call) => {
      setPathStale(false)
      detail.setData((current) => (current ? { ...current, path, ...(call ? { call } : {}) } : current))
    },
    () => void detail.reload(),
    () => {
      setPathStale(true)
      detail.setData((current) => (current?.path ? { ...current, path: { ...current.path, live: false } } : current))
    },
  )
  // A failed refresh keeps what's on screen; only a page that never loaded shows the error.
  if (detail.error && !detail.data) return <Card><CardContent className="grid gap-3"><p>{detail.error}</p><Button variant="outline" asChild className="w-fit"><Link to={base}>Back to Calls</Link></Button></CardContent></Card>
  if (!detail.data) return <div className="mx-auto grid max-w-2xl gap-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-5 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-48 w-full" /></div>
  const { call, task, booking } = detail.data
  const spam = call.outcome === "ignored_spam"
  const badge = call.emergency?.severity === "life_safety" ? { tone: "danger" as const, label: "Emergency" }
    : call.emergency?.emergency ? { tone: "danger" as const, label: "Urgent" }
    : spam ? { tone: "neutral" as const, label: "Likely spam" }
    : urgency(task ?? undefined, call)
  const when = booking?.requestedStart ?? call.fields.requestedStart
  const bookedFor = booking?.requestedStart ? booking.status === "confirmed" : call.outcome === "booked"
  const facts: Array<[string, string]> = [
    phoneFact(call),
    ...addressFact(call, dashboard?.shop.asksAddress),
    ["Called", compactDate(call.startedAt, tz)],
    ["Length", minutes(call.durationSeconds)],
    ...(spam ? [] : [["Category", call.fields.serviceCategory ?? "Not classified"] as [string, string]]),
    ["Outcome", outcomeWords(call.outcome)],
    ...(when ? [[bookedFor ? "Booked for" : "Asked for", compactDate(when, tz)] as [string, string]] : []),
    ...(call.fields.equipmentDetails ? [["Equipment", call.fields.equipmentDetails] as [string, string]] : []),
    ...(call.fields.accessNotes ? [["Access", call.fields.accessNotes] as [string, string]] : []),
    ...(task ? [["Follow-up", task.reason] as [string, string], [task.status === "completed" ? "Completed" : "Call back by", task.status === "completed" ? compactDate(task.completedAt ?? task.updatedAt, tz) : compactDate(task.dueAt, tz)] as [string, string]] : []),
  ]
  const remove = async () => {
    setDeleting(true)
    try {
      await api(`/api/app/calls/${encodeURIComponent(call.id)}`, { method: "DELETE", body: { confirm: "delete" } })
      await reload()
      toast.success("Call record deleted.")
      navigate(base)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed. Please retry.")
      setDeleting(false)
    }
  }
  return (
    <div className="mx-auto grid max-w-2xl gap-5">
      {/* Back to the list that opened this call (one step back, so it keeps its place), else to Calls: never out of the app.
          Calls replaces the call in history, so Back from Calls doesn't return to it. */}
      <Button variant="ghost" className="-ml-2 h-11 w-fit text-base max-lg:hidden" onClick={() => (back.history ? navigate(-1) : navigate(back.to, { replace: true }))}>← {back.label}</Button>
      <CallHeader page call={call} tone={badge.tone} label={badge.label} />
      <SafetyNote call={call} />
      {spam && <SpamNote />}
      <ActionBar call={call} extra={spam ? [] : tiles(task, () => detail.reload())} reachNote={<CallBackNote call={call} />} />
      {detail.data.path && <CallPathCard path={detail.data.path} stale={pathStale} onRefresh={() => { setPathStale(false); void detail.reload() }} />}
      <Facts rows={facts} />
      <ExtraAnswers call={call} />
      {detail.data.recordingUrl && (
        <section className="ph-no-capture grid gap-2">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold"><Play className="size-4" />Recording</h3>
          {/* preload=metadata fetches the recording header as the page opens, so Play starts at once. */}
          <audio controls preload="metadata" src={detail.data.recordingUrl} className="w-full" />
        </section>
      )}
      <section className="grid gap-3 rounded-xl border bg-card p-4">
        <h3 className="text-[17px] font-semibold">Call transcript</h3>
        <Transcript call={call} />
      </section>
      {detail.data.alerts.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-[15px] font-semibold">Alerts we sent you</h3>
          <dl className="divide-y overflow-hidden rounded-xl border bg-card">
            {detail.data.alerts.map((alert, index) => (
              <div key={index} className="flex justify-between gap-3 px-4 py-3 text-[15px]"><dt>{alert.priority === "high" ? "Urgent text" : "Text"}</dt><dd className="text-muted-foreground">{notificationWords(alert.state)}</dd></div>
            ))}
          </dl>
        </section>
      )}
      {detail.data.canDelete && (
        <details className="group rounded-xl border bg-card px-4">
          <summary className="flex min-h-12 cursor-pointer items-center text-[15px] font-semibold text-red-700">Delete this call record</summary>
          <div className="grid gap-3 pb-4">
            <p className="text-sm text-muted-foreground">This permanently removes the call record, transcript, recording, callback, alerts, and any customer record whose latest call is this one. Appointments already on your calendar stay on your calendar.</p>
            <Label className="flex min-h-11 items-center gap-3 text-[15px] font-medium"><Checkbox checked={confirm} onCheckedChange={(value) => setConfirm(value === true)} className="size-5" />I understand this can’t be undone.</Label>
            <Button size="tap" variant="destructive" className="w-full bg-red-600 text-white hover:bg-red-700 md:w-auto" disabled={!confirm || deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete permanently"}</Button>
          </div>
        </details>
      )}
    </div>
  )
}
