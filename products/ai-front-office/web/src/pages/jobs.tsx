import { useSearchParams } from "react-router-dom"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CallLink, Muted, ToneBadge } from "@/components/app/bits"
import { CallPanel } from "./today"
import { derive, type Tone } from "@/lib/derive"
import { compactDate } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { ApiCall } from "@/lib/types"

interface Row { call: ApiCall; label: string; tone: Tone; meta: string }

export function JobsPage() {
  const { dashboard } = useMode()
  const [params, setParams] = useSearchParams()
  if (!dashboard) return null
  const d = derive(dashboard)
  const rows = (items: Array<Row | null>): Row[] => items.filter((item): item is Row => item !== null)
  const columns: Array<{ id: string; title: string; empty: string; rows: Row[] }> = [
    { id: "reply", title: "Needs reply", empty: "Nothing needs a reply.", rows: rows(d.actionable.map((task) => { const call = d.callsById.get(task.callId); return call ? { call, label: task.priority === "high" ? "Urgent" : "Call back", tone: task.priority === "high" ? "danger" : "neutral", meta: task.reason } : null })) },
    { id: "waiting", title: "Waiting", empty: "Nothing snoozed.", rows: rows(d.snoozed.map((task) => { const call = d.callsById.get(task.callId); return call ? { call, label: "Later", tone: "neutral", meta: `Back ${compactDate(task.dueAt, d.tz)}` } : null })) },
    { id: "booked", title: "Booked", empty: "No upcoming bookings.", rows: d.booked.map((call) => ({ call, label: "Booked", tone: "good" as Tone, meta: compactDate(call.fields.requestedStart!, d.tz) })) },
    { id: "handled", title: "Handled", empty: "Nothing handled yet.", rows: rows(d.handled.map((task) => { const call = d.callsById.get(task.callId); return call ? { call, label: "Handled", tone: "neutral", meta: compactDate(task.completedAt ?? task.updatedAt, d.tz) } : null })) },
  ]
  const tab = columns.some((column) => column.id === params.get("tab")) ? params.get("tab")! : "reply"
  const selected = params.get("call") ? d.callsById.get(params.get("call")!) ?? null : null
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <section className="grid min-w-0 gap-3">
        <h2 className="px-1 text-base font-semibold tracking-tight">Every job at a glance</h2>
        <Tabs value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })} className="min-w-0 gap-3">
          <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
          <TabsList className="h-11 w-max">
            {columns.map((column) => (
              <TabsTrigger key={column.id} value={column.id} className="h-9 px-3 text-sm">
                {column.title}
                <span className="tabular ml-1 rounded-md bg-background/70 px-1.5 text-xs">{column.rows.length}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          </div>
          {columns.map((column) => (
            <TabsContent key={column.id} value={column.id}>
              {column.rows.length === 0 ? <Card className="py-0"><Muted>{column.empty}</Muted></Card> : (
                <>
                  <div className="grid gap-2 md:hidden">
                    {column.rows.map((row) => (
                      <CallLink key={row.call.id} callId={row.call.id} className="grid gap-1 rounded-xl border bg-card p-3.5 shadow-xs">
                        <span className="flex items-center justify-between gap-2"><strong className="truncate font-semibold">{row.call.fields.callerName ?? "Unknown caller"}</strong><ToneBadge tone={row.tone}>{row.label}</ToneBadge></span>
                        <small className="line-clamp-2 text-[13px] text-muted-foreground">{row.call.fields.problemDescription || "No summary"}</small>
                        <time className="text-xs text-muted-foreground">{row.meta}</time>
                      </CallLink>
                    ))}
                  </div>
                  <Card className="hidden overflow-hidden py-0 md:block">
                    <Table>
                      <TableHeader className="bg-muted/60">
                        <TableRow>
                          <TableHead className="pl-4">Caller</TableHead>
                          <TableHead>Problem</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="pr-4 text-right">When</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {column.rows.map((row) => (
                          <TableRow key={row.call.id} data-state={selected?.id === row.call.id ? "selected" : undefined} className="relative h-14">
                            <TableCell className="pl-4 font-semibold"><CallLink callId={row.call.id} className="after:absolute after:inset-0">{row.call.fields.callerName ?? "Unknown caller"}</CallLink></TableCell>
                            <TableCell className="max-w-[28ch] truncate text-muted-foreground">{row.call.fields.problemDescription || "No summary"}</TableCell>
                            <TableCell><ToneBadge tone={row.tone}>{row.label}</ToneBadge></TableCell>
                            <TableCell className="pr-4 text-right text-sm text-muted-foreground">{row.meta}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                </>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </section>
      {selected && (
        <aside className="max-lg:hidden lg:sticky lg:top-20 lg:w-[380px]">
          <CallPanel call={selected} task={d.taskFor(selected.id)} tz={d.tz} standalone={false} />
        </aside>
      )}
    </div>
  )
}
