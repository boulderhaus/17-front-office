import { useEffect, useMemo } from "react"
import { createBrowserRouter, Navigate, Route, RouterProvider, Routes, useLocation } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { AppShell, type BackLink } from "@/components/app/shell"
import { CalendarHeaderActions, CalendarPage } from "@/pages/calendar"
import { CallPage } from "@/pages/call"
import { JobsPage } from "@/pages/jobs"
import { SettingsArea } from "@/pages/settings"
import { StartPage } from "@/pages/start"
import { TodayPage } from "@/pages/today"
import { useApi } from "@/lib/api"
import { identifyOwner } from "@/lib/analytics"
import { ModeContext, useMediaQuery, type AppMode } from "@/lib/mode"
import { callBack } from "@/lib/nav"
import type { ApiDashboard } from "@/lib/types"

/**
 * Screens that show callers' names, numbers, addresses, transcripts or recordings are
 * `ph-no-capture`: session replay records a blank box and autocapture ignores them.
 */
function Screen({ title, subtitle, actions, children, callerData = true, back, hideTitle }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode; callerData?: boolean; back?: BackLink; hideTitle?: boolean }) {
  return <AppShell title={title} subtitle={subtitle} actions={actions} back={back} hideTitle={hideTitle}>{callerData ? <div className="ph-no-capture">{children}</div> : children}</AppShell>
}

/** A call's own screen: its "‹ Jobs" / "‹ Calls" goes back to the list that opened it, or to Calls. */
function CallScreen({ base }: { base: "/app" | "/demo" }) {
  const location = useLocation()
  return <Screen title="Call" back={callBack({ key: location.key, state: location.state, base })} hideTitle><CallPage /></Screen>
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
  const member = dashboard.data?.viewer.role === "member"
  const mode = useMemo<AppMode>(() => ({ base, preview, member, dashboard: dashboard.data, reload: dashboard.reload }), [base, preview, member, dashboard.data, dashboard.reload])
  useEffect(() => identifyOwner(dashboard.data?.analytics), [dashboard.data?.analytics])
  const ready = (node: React.ReactNode) => (dashboard.data ? node : dashboard.error ? <p className="rounded-xl border bg-card p-4">{dashboard.error}</p> : <Loading />)
  return (
    <ModeContext.Provider value={mode}>
      <Routes>
        <Route index element={<Screen title="Calls" subtitle="Who called, and who’s waiting on you.">{ready(<TodayPage />)}</Screen>} />
        {/* "Calls" is the home screen; /calls is an alias so a typed or shared link lands there too. */}
        <Route path="calls" element={<Navigate to={base} replace />} />
        {!preview && <Route path="start" element={dashboard.data ? <StartPage /> : <div className="mx-auto max-w-xl p-4">{ready(null)}</div>} />}
        <Route path="jobs" element={<Screen title="Jobs" subtitle="Every job from your calls, by where it stands.">{ready(<JobsPage />)}</Screen>} />
        <Route path="calendar" element={<Screen title="Calendar" subtitle="Booked visits and times callers asked for." actions={<CalendarHeaderActions />}>{ready(<CalendarPage />)}</Screen>} />
        <Route path="calls/:id" element={<CallScreen base={base} />} />
        {/* One route for the whole settings area, so an unsaved edit survives moving between its pages. */}
        {/* Team members never see Settings: a typed or old link goes home (the server refuses them too). */}
        {!preview && <Route path="settings/*" element={!dashboard.data ? <Screen title="Settings" callerData={false}>{ready(null)}</Screen> : member ? <Navigate to={base} replace /> : <SettingsArea />} />}
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

function Layout() {
  const phone = useMediaQuery("(max-width: 1023px)")
  const toastPosition = phone ? "bottom-center" : "top-center"
  return (
    <TooltipProvider delayDuration={200}>
      <Routes>
        <Route path="/demo/*" element={<Root />} />
        <Route path="/app/*" element={<Root />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
      {/* Phones: at the bottom, clear of the header and the menu button. Computers: top centre. */}
      <Toaster position={toastPosition} richColors closeButton />
    </TooltipProvider>
  )
}

// A data router (not <BrowserRouter>), so Settings can hold the owner on the page while an edit is unsaved
// (useBlocker), including the browser's Back. The routes themselves are unchanged, below the one catch-all.
const router = createBrowserRouter([{ path: "*", element: <Layout /> }])

export default function App() {
  return <RouterProvider router={router} />
}
