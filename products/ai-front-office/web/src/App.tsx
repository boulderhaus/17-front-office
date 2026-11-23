import { useMemo } from "react"
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { AppShell } from "@/components/app/shell"
import { CalendarPage } from "@/pages/calendar"
import { CallPage } from "@/pages/call"
import { JobsPage } from "@/pages/jobs"
import { SettingsPage } from "@/pages/settings"
import { TodayPage } from "@/pages/today"
import { useApi } from "@/lib/api"
import { ModeContext, type AppMode } from "@/lib/mode"
import type { ApiDashboard } from "@/lib/types"

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return <AppShell title={title}>{children}</AppShell>
}

function Loading() {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-2.5">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-24 rounded-xl" />)}</div>
      {[0, 1].map((key) => <Skeleton key={key} className="h-40 rounded-xl" />)}
    </div>
  )
}

function Workspace({ base }: { base: "/app" | "/demo" }) {
  const preview = base === "/demo"
  const dashboard = useApi<ApiDashboard>(preview ? "/api/demo/dashboard" : "/api/app/dashboard")
  const mode = useMemo<AppMode>(() => ({ base, preview, dashboard: dashboard.data, reload: dashboard.reload }), [base, preview, dashboard.data, dashboard.reload])
  const ready = (node: React.ReactNode) => (dashboard.data ? node : dashboard.error ? <p className="rounded-xl border bg-card p-4">{dashboard.error}</p> : <Loading />)
  return (
    <ModeContext.Provider value={mode}>
      <Routes>
        <Route index element={<Screen title="Today">{ready(<TodayPage />)}</Screen>} />
        <Route path="jobs" element={<Screen title="Jobs">{ready(<JobsPage />)}</Screen>} />
        <Route path="calendar" element={<Screen title="Calendar">{ready(<CalendarPage />)}</Screen>} />
        <Route path="calls/:id" element={<Screen title="Call"><CallPage /></Screen>} />
        {!preview && <Route path="settings" element={<Screen title="Settings"><SettingsPage /></Screen>} />}
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
