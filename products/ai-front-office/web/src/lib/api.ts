import { useCallback, useEffect, useState } from "react"
import { loginReturningHere } from "@/lib/login-next"

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

let csrfToken = ""
export function setCsrf(token: string) {
  if (token) csrfToken = token
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET"
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json", "x-csrf-token": csrfToken },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  if (response.status === 401) {
    window.location.assign(loginReturningHere(window.location))
    throw new ApiError("Sign in again", 401)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(typeof payload.error === "string" ? payload.error : "Something went wrong. Please try again.", response.status)
  return payload as T
}

export function useApi<T extends { csrf?: string }>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    try {
      const next = await api<T>(path)
      if (next.csrf) setCsrf(next.csrf)
      setData(next)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load")
    } finally {
      setLoading(false)
    }
  }, [path])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, loading, reload: load, setData }
}
