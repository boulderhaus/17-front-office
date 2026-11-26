/**
 * Sign-up is two screens: the account (Google, Microsoft, an email link, or email and password), then the shop.
 * These walk a test browser to the shop screen with an email and password, the way the account screen does.
 */
let counter = 0;

/** Sends the account screen; returns the pending sign-up cookie and the email it holds. */
export async function startSignup(baseUrl: string, input: { email?: string; password?: string; query?: string } = {}): Promise<{ cookie: string; email: string; response: Response }> {
  const email = input.email ?? `shop-step-${++counter}@synthetic.example`;
  const params = new URLSearchParams(input.query ?? "");
  const body = new URLSearchParams({ step: "account", email, password: input.password ?? "synthetic-pass-1" });
  if (params.get("plan")) body.set("plan", params.get("plan")!);
  if (params.get("unlimited") === "1") body.set("unlimited", "yes");
  const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("afo_pending_identity="))?.split(";")[0] ?? "";
  return { cookie, email, response };
}

/** The shop screen's HTML (the page with the shop name, mobile, opt-in and plan), for a new email. */
export async function shopStepPage(baseUrl: string, query = ""): Promise<string> {
  const { cookie } = await startSignup(baseUrl, { query });
  return (await fetch(`${baseUrl}/signup${query ? `?${query}` : ""}`, { headers: { cookie } })).text();
}
