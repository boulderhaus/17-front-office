import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { Check, Play, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { CallHeader, ContactActions, Facts, phoneFact, SafetyNote } from "@/components/app/call-parts"
import { useTaskActions } from "./today"
import { api, useApi } from "@/lib/api"
import { urgency } from "@/lib/derive"
import { compactDate, notificationWords, outcomeWords } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { ApiCallDetail } from "@/lib/types"

export function CallPage() {
  const { id = "" } = useParams()
  const { base, preview, dashboard, reload } = useMode()
  const navigate = useNavigate()
  const act = useTaskActions()
  const detail = useApi<ApiCallDetail & { csrf?: string }>(`/api/${preview ? "demo" : "app"}/calls/${encodeURIComponent(id)}`)
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const tz = dashboard?.shop.timezone ?? "America/New_York"
  if (detail.error) return <Card><CardContent className="grid gap-3"><p>{detail.error}</p><Button variant="outline" asChild className="w-fit"><Link to={base}>Back</Link></Button></CardContent></Card>
  if (!detail.data) return <Card><CardContent className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-5 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-40 w-full" /></CardContent></Card>
  const { call, task, booking } = detail.data
  const life = call.emergency?.severity === "life_safety"
  const tone = call.emergency?.emergency ? "danger" : call.outcome === "booked" ? "good" : "neutral"
  const label = life ? "Emergency" : call.emergency?.emergency ? "Urgent" : preview ? urgency(task ?? undefined, call).label : outcomeWords(call.outcome)
  const facts: Array<[string, string]> = [
    phoneFact(call),
    ["Address", call.fields.address?.trim() || "Not confirmed"],
    ["Called", compactDate(call.startedAt, tz)],
    ["Length", call.durationSeconds ? `${Math.max(1, Math.round(call.durationSeconds / 60))} min` : "Unknown"],
    ["Category", call.fields.serviceCategory ?? "Not classified"],
    ["Outcome", outcomeWords(call.outcome)],
    ...(booking?.requestedStart ? [[booking.status === "confirmed" ? "Booked for" : "Asked for", compactDate(booking.requestedStart, tz)] as [string, string]] : call.fields.requestedStart ? [[call.outcome === "booked" ? "Booked for" : "Asked for", compactDate(call.fields.requestedStart, tz)] as [string, string]] : []),
    ...(call.fields.equipmentDetails ? [["Equipment", call.fields.equipmentDetails] as [string, string]] : []),
    ...(call.fields.accessNotes ? [["Access", call.fields.accessNotes] as [string, string]] : []),
    ...(task ? [["Follow-up", `${task.reason} · ${task.status === "completed" ? "handled" : `due ${compactDate(task.dueAt, tz)}`}`] as [string, string]] : []),
  ]
  const taskButton = preview || !task ? null
    : task.status !== "completed" && task.status !== "cancelled"
      ? <Button size="tap" variant="outline" onClick={async () => { await act(call.id, "complete"); await detail.reload() }}><Check />Mark handled</Button>
      : task.status === "completed" ? <Button size="tap" variant="outline" onClick={async () => { await act(call.id, "reopen"); await detail.reload() }}><RotateCcw />Reopen</Button> : null
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
    <div className="mx-auto grid max-w-2xl gap-4">
      <Card>
        <CardContent className="grid gap-4">
          <Button variant="ghost" className="-ml-2 h-10 w-fit" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(base))}>← Back</Button>
          <CallHeader call={call} tone={tone} label={label} />
          <SafetyNote call={call} />
          <ContactActions call={call} extra={taskButton} />
          <Facts rows={facts} />
          {detail.data.recordingUrl && (
            <div className="grid gap-2 rounded-xl border bg-secondary/60 p-3">
              <span className="flex items-center gap-2 text-sm font-semibold"><Play className="size-4" />Recording</span>
              {/* preload=metadata fetches the recording header as the page opens, so Play starts at once. */}
              <audio controls preload="metadata" src={detail.data.recordingUrl} className="w-full" />
            </div>
          )}
          <details open className="rounded-xl border">
            <summary className="flex min-h-12 cursor-pointer items-center px-3.5 font-semibold">Read the call</summary>
            <p className="px-3.5 pb-3.5 text-sm whitespace-pre-wrap text-foreground/85">{call.transcript ?? "Transcript unavailable"}</p>
          </details>
          {detail.data.alerts.length > 0 && (
            <section className="grid gap-1">
              <h3 className="text-sm font-semibold">Alerts sent</h3>
              <ul className="divide-y text-sm">
                {detail.data.alerts.map((alert, index) => <li key={index} className="flex justify-between py-2"><span>{alert.priority === "high" ? "Urgent text" : "Text"}</span><span className="text-muted-foreground">{notificationWords(alert.state)}</span></li>)}
              </ul>
            </section>
          )}
        </CardContent>
      </Card>
      {detail.data.canDelete && (
        <Card className="border-red-200">
          <CardContent>
            <details>
              <summary className="flex min-h-10 cursor-pointer items-center font-semibold text-red-700">Delete this call record</summary>
              <div className="mt-3 grid gap-3">
                <p className="text-sm text-muted-foreground">This permanently removes the call record, transcript, recording, callback, tool events, notifications, and any customer record whose latest call is this one. Appointments already on your calendar stay on your calendar.</p>
                <Label className="flex min-h-11 items-center gap-3 text-sm font-medium"><Checkbox checked={confirm} onCheckedChange={(value) => setConfirm(value === true)} className="size-5" />I understand this can’t be undone.</Label>
                <Button size="tap" variant="destructive" className="w-full bg-red-600 text-white hover:bg-red-700" disabled={!confirm || deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete permanently"}</Button>
              </div>
            </details>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
