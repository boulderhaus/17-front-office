import { useEffect, useMemo } from "react"
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { AppShell } from "@/components/app/shell"
import { CalendarPage } from "@/pages/calendar"
import { CallPage } from "@/pages/call"
import { JobsPage } from "@/pages/jobs"
import { SettingsArea } from "@/pages/settings"
import { StartPage } from "@/pages/start"
import { TodayPage } from "@/pages/today"
import { useApi } from "@/lib/api"
import { identifyOwner } from "@/lib/analytics"
import { ModeContext, type AppMode } from "@/lib/mode"
import type { ApiDashboard } from "@/lib/types"

/**
 * Screens that show callers' names, numbers, addresses, transcripts or recordings are
 * `ph-no-capture`: session replay records a blank box and autocapture ignores them.
 */
function Screen({ title, children, callerData = true, back, hideTitle }: { title: string; children: React.ReactNode; callerData?: boolean; back?: { to: string; label: string }; hideTitle?: boolean }) {
  return <AppShell title={title} back={back} hideTitle={hideTitle}>{callerData ? <div className="ph-no-capture">{children}</div> : children}</AppShell>
}

function Loading() {
  return (
    <div className="grid gap-4">
      <Skeleton className="h-[84px] rounded-xl" />
      {[0, 1].map((key) => <Skeleton key={key} className="h-40 rounded-xl" />)}
    </div>
  )
}

function Workspace({ base }: { base: "/app" | "/demo" }) {
  const preview = base === "/demo"
  const dashboard = useApi<ApiDashboard>(preview ? "/api/demo/dashboard" : "/api/app/dashboard")
  const mode = useMemo<AppMode>(() => ({ base, preview, dashboard: dashboard.data, reload: dashboard.reload }), [base, preview, dashboard.data, dashboard.reload])
  useEffect(() => identifyOwner(dashboard.data?.analytics), [dashboard.data?.analytics])
  const ready = (node: React.ReactNode) => (dashboard.data ? node : dashboard.error ? <p className="rounded-xl border bg-card p-4">{dashboard.error}</p> : <Loading />)
  return (
    <ModeContext.Provider value={mode}>
      <Routes>
        <Route index element={<Screen title="Calls">{ready(<TodayPage />)}</Screen>} />
        {/* "Calls" is the home screen; /calls is an alias so a typed or shared link lands there too. */}
        <Route path="calls" element={<Navigate to={base} replace />} />
        {!preview && <Route path="start" element={dashboard.data ? <StartPage /> : <div className="mx-auto max-w-xl p-4">{ready(null)}</div>} />}
        <Route path="jobs" element={<Screen title="Jobs">{ready(<JobsPage />)}</Screen>} />
        <Route path="calendar" element={<Screen title="Calendar">{ready(<CalendarPage />)}</Screen>} />
        <Route path="calls/:id" element={<Screen title="Call" back={{ to: base, label: "Calls" }} hideTitle><CallPage /></Screen>} />
        {/* One route for the whole settings area, so an unsaved edit survives moving between its pages. */}
        {!preview && <Route path="settings/*" element={<SettingsArea />} />}
        <Route path="*" element={<Navigate to={base} replace />} />
      </Routes>
    </ModeContext.Provider>
  )
}

function Root() {
  const location = useLocation()
  if (location.pathname.startsWith("/demo")) return <Workspace base="/demo" />
  return <Workspace base="/app" />
}

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={200}>
        <Routes>
          <Route path="/demo/*" element={<Root />} />
          <Route path="/app/*" element={<Root />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
        <Toaster position="top-center" richColors closeButton />
      </TooltipProvider>
    </BrowserRouter>
  )
}
