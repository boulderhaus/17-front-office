import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { dateKey } from "@/lib/format"
import type { ApiCall } from "@/lib/types"

const config = { calls: { label: "Calls answered", color: "var(--brand-ink)" } } satisfies ChartConfig

/** Calls answered per day over the last two weeks (shadcn chart-area pattern). */
export default function CallsChart({ calls, now, tz }: { calls: ApiCall[]; now: string; tz: string }) {
  const nowMs = Date.parse(now)
  const days = Array.from({ length: 14 }, (_, index) => {
    const day = new Date(nowMs - (13 - index) * 86_400_000)
    const key = dateKey(day, tz)
    return {
      key,
      label: new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(day),
      calls: calls.filter((call) => dateKey(new Date(call.startedAt), tz) === key).length,
    }
  })
  const total = days.reduce((sum, day) => sum + day.calls, 0)
  if (total === 0) return null
  return (
    <Card className="gap-2 pb-2">
      <CardHeader>
        <CardTitle className="text-base">Calls answered</CardTitle>
        <CardDescription>{total} in the last 14 days</CardDescription>
      </CardHeader>
      <CardContent className="px-2">
        <ChartContainer config={config} className="aspect-auto h-36 w-full md:h-44">
          <AreaChart data={days} margin={{ left: 8, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="fillCalls" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--brand-yellow)" stopOpacity={0.9} />
                <stop offset="95%" stopColor="var(--brand-yellow)" stopOpacity={0.15} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
            <Area dataKey="calls" type="monotone" fill="url(#fillCalls)" stroke="var(--color-calls)" strokeWidth={2} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
