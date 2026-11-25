/**
 * Signed out on an owner-app page (a session that expired, a phone that scanned the setup QR code): sign in, then
 * come back to it. Pure, so tests can import it; the server checks `next` again (safeNext).
 */
export function loginReturningHere(location: { pathname: string; search: string }): string {
  const here = `${location.pathname}${location.search}`
  return /^\/app(\/|$)/.test(location.pathname) && here !== "/app" && here.length <= 300 ? `/login?next=${encodeURIComponent(here)}` : "/login"
}
