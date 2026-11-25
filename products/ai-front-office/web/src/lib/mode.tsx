import { createContext, useContext, useEffect, useState } from "react"
import type { ApiDashboard } from "./types"

export interface AppMode {
  base: "/app" | "/demo"
  preview: boolean
  /** A team member (not the owner): Settings is the owner's alone, so it isn't shown at all. */
  member: boolean
  dashboard: ApiDashboard | null
  reload: () => Promise<void>
}

export const ModeContext = createContext<AppMode>({ base: "/app", preview: false, member: false, dashboard: null, reload: async () => undefined })
export const useMode = () => useContext(ModeContext)

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [query])
  return matches
}
