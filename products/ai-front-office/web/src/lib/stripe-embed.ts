/**
 * Stripe's embedded Checkout, loaded only when the owner taps "Change card". Stripe.js must come straight from
 * js.stripe.com (never bundled). Any failure (script blocked, Stripe refuses) rejects, and the caller falls back
 * to Stripe's own card page.
 */
type EmbeddedCheckout = { mount: (target: HTMLElement) => void; destroy: () => void }
type EmbeddedOptions = { fetchClientSecret: () => Promise<string>; onComplete?: () => void }
type StripeInstance = {
  initEmbeddedCheckout?: (options: EmbeddedOptions) => Promise<EmbeddedCheckout>
  createEmbeddedCheckoutPage?: (options: EmbeddedOptions) => Promise<EmbeddedCheckout>
}
type StripeFactory = (key: string) => StripeInstance

/** v3 runs sessions made with ui_mode "embedded"; Stripe's newest script runs "embedded_page" ones. */
const SCRIPTS = { embedded: "https://js.stripe.com/v3/", embedded_page: "https://js.stripe.com/endive/stripe.js" } as const
const loading = new Map<string, Promise<StripeFactory>>()

function loadStripe(uiMode: keyof typeof SCRIPTS, timeoutMs = 10_000): Promise<StripeFactory> {
  const src = SCRIPTS[uiMode]
  const existing = loading.get(src)
  if (existing) return existing
  const promise = new Promise<StripeFactory>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = src
    script.async = true
    const timer = window.setTimeout(() => reject(new Error("Stripe took too long to load")), timeoutMs)
    script.onload = () => {
      window.clearTimeout(timer)
      const factory = (window as unknown as { Stripe?: StripeFactory }).Stripe
      if (typeof factory === "function") resolve(factory)
      else reject(new Error("Stripe did not load"))
    }
    script.onerror = () => { window.clearTimeout(timer); reject(new Error("Stripe could not load")) }
    document.head.appendChild(script)
  })
  // A failed load can be tried again next time.
  promise.catch(() => { loading.delete(src); document.querySelector(`script[src="${src}"]`)?.remove() })
  loading.set(src, promise)
  return promise
}

export async function mountEmbeddedCheckout(input: { publishableKey: string; clientSecret: string; uiMode: keyof typeof SCRIPTS; target: HTMLElement; onComplete: () => void }): Promise<EmbeddedCheckout> {
  const factory = await loadStripe(input.uiMode)
  const stripe = factory(input.publishableKey)
  // Each script has its own name for the form; the newer script keeps the old name only as a stub that throws.
  const init = input.uiMode === "embedded_page" ? stripe.createEmbeddedCheckoutPage : stripe.initEmbeddedCheckout
  if (!init) throw new Error("This Stripe script has no embedded Checkout")
  const checkout = await init.call(stripe, { fetchClientSecret: async () => input.clientSecret, onComplete: input.onComplete })
  checkout.mount(input.target)
  return checkout
}
