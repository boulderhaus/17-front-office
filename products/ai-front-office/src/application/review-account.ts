import { randomInt, randomUUID } from "node:crypto";
import { isCompStatus } from "../domain/billing.js";
import { createDemoConfig } from "../domain/config.js";
import { readFounderToken, signFounderToken } from "../domain/founder-booking.js";
import type { BusinessConfig, OwnerAccount, SubscriptionRecord } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import { hashOwnerPassword } from "../security/owner-auth.js";

/**
 * The Google OAuth review account: one complimentary owner account Google's verification team signs in to, to see
 * the consent screen and the calendar connect without a card. Made only through a signed admin link
 * (/admin/review-account?k=..., scripts/review-account-link.ts). Its subscription is "comp": the owner app opens as
 * if paid, but Stripe is never called for it, it never gets a phone line, and nothing is ever sent from it.
 */
export const REVIEW_ACCOUNT_EMAIL = "reviewer@callotto.co";
export const REVIEW_ACCOUNT_NAME = "Google Reviewer";
export const REVIEW_BUSINESS_NAME = "Review Demo Plumbing";
export const REVIEW_LINK_MAX_MS = 24 * 60 * 60_000;
/** What the owner app says when the review account tries anything that needs a real phone line. */
export const REVIEW_NO_LINE = "This is a review account. It has no phone line, so calls can’t be turned on and Call Otto doesn’t call or text from it.";

/** The admin link's proof: HMAC of SESSION_SIGNING_KEY with its own purpose, good for at most 24 hours. */
export function reviewAccountToken(key: string, now: Date, ttlMs = REVIEW_LINK_MAX_MS): string {
  return signFounderToken(key, "review-account", { exp: now.getTime() + Math.min(Math.max(ttlMs, 60_000), REVIEW_LINK_MAX_MS) });
}

export function reviewAccountTokenValid(key: string, token: string | null | undefined, now: Date): boolean {
  const data = readFounderToken(key, "review-account", token, now);
  // A link signed for longer than 24 hours (a bad script, a hand-made token) is refused, not trimmed.
  return data !== null && (data.exp as number) <= now.getTime() + REVIEW_LINK_MAX_MS + 60_000;
}

/** Link previews and crawlers (Slack, iMessage, WhatsApp, Discord, Teams, bots): never allowed to reset the password. */
const LINK_PREVIEW_AGENT = /bot\b|bot\/|crawler|spider|facebookexternalhit|slack|discord|whatsapp|telegram|skypeuripreview|teams|linkedin|embedly|preview|curl|wget/i;

export function isLinkPreview(userAgent: string | undefined): boolean {
  return LINK_PREVIEW_AGENT.test(userAgent ?? "");
}

/** No look-alike characters (0/O, 1/l/I), so it can be read off the page and typed. */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** 24 random characters (about 138 bits), in groups of four: "Kx7q-9mPa-…". */
export function generateReviewPassword(): string {
  const characters = Array.from({ length: 24 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]!).join("");
  return characters.match(/.{4}/g)!.join("-");
}

/** True for the review account's shop (and any other complimentary shop): nothing is ever sent from it. */
export async function isCompTenant(store: Pick<Store, "getSubscription">, tenantId: string): Promise<boolean> {
  return isCompStatus((await store.getSubscription(tenantId))?.status);
}

/** A demo shop: no owner phone, no texts, no emails, paused, with service area and hours already set. */
export function reviewShopConfig(tenantId: string): BusinessConfig {
  return {
    ...createDemoConfig(tenantId),
    paused: true,
    businessName: REVIEW_BUSINESS_NAME,
    greeting: `Thanks for calling ${REVIEW_BUSINESS_NAME}. How can I help?`,
    timezone: "America/New_York",
    serviceAreaTerms: ["Sarasota FL", "34236"],
    serviceCategories: ["plumbing repair", "drain cleaning", "water heater", "other"],
    emergencyKeywords: ["burst pipe", "flooding", "no water"],
    operationMode: "after_hours",
    ownerNotificationRefs: [],
    ownerTransferNumberRef: null,
    requireDiagnosticFeeAcceptance: false,
    supportEmail: null,
    customerSmsEnabled: false,
    ownerWeeklyEmailEnabled: false,
    ownerDailySmsEnabled: false,
    ownerRealtimeSmsEnabled: false,
  };
}

export class ReviewAccountError extends Error {}

export interface ReviewAccountResult {
  email: string;
  /** Plain text, shown once on the admin page and never stored or logged. */
  password: string;
  tenantId: string;
  created: boolean;
}

/**
 * Make the review account, or give it a new password. Idempotent: one account, one shop, however often the link is
 * opened. An existing account with that email is taken over as the review account (the address is ours, and a
 * password signup proves nothing about the email), unless it belongs to a teammate or has ever touched Stripe:
 * a shop with a Stripe customer or subscription is never turned complimentary.
 */
export async function ensureReviewAccount(store: Store, clock: Clock): Promise<ReviewAccountResult> {
  return store.withLock("review-account", async () => {
    const password = generateReviewPassword();
    const passwordHash = await hashOwnerPassword(password);
    const now = clock.now().toISOString();
    let account: OwnerAccount | null = await store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL);
    let created = false;
    let subscription: SubscriptionRecord | null = null;
    if (!account) {
      const tenantId = `shop_${randomUUID()}`;
      account = {
        id: randomUUID(), tenantId, email: REVIEW_ACCOUNT_EMAIL, displayName: REVIEW_ACCOUNT_NAME, passwordHash,
        // We made it on our own domain: a later Google sign-in with this address keeps the password.
        emailVerifiedAt: now,
        status: "pending_activation", createdAt: now, updatedAt: now,
      };
      if (!await store.createOwnerWorkspace({ account, config: reviewShopConfig(tenantId), ownerPhone: null })) {
        throw new ReviewAccountError("The review account couldn’t be created. Open the link again.");
      }
      created = true;
    } else {
      if (account.role === "member") throw new ReviewAccountError(`${REVIEW_ACCOUNT_EMAIL} is a teammate in another shop. Nothing was changed.`);
      subscription = await store.getSubscription(account.tenantId);
      if (subscription && !isCompStatus(subscription.status) && (subscription.providerCustomerId || subscription.providerSubscriptionId)) {
        throw new ReviewAccountError(`${REVIEW_ACCOUNT_EMAIL} has a Stripe billing record, so it can’t be made a review account. Nothing was changed.`);
      }
      if (!isCompStatus(subscription?.status)) {
        // Taken over: the demo shop's settings, and no phone or calendar someone else left on it.
        await store.saveConfig(reviewShopConfig(account.tenantId));
        await store.deleteIntegrationSecret(account.tenantId, "notifications", "owner-primary");
        await store.deleteIntegrationSecret(account.tenantId, "google", "refresh_token");
      }
    }
    const tenantId = account.tenantId;
    // Never later than a stored record, so the write always lands (the store keeps the newest provider event).
    const stamp = subscription && Date.parse(subscription.providerEventCreatedAt) > Date.parse(now) ? subscription.providerEventCreatedAt : now;
    await store.saveSubscription({
      tenantId, providerCustomerId: null, providerSubscriptionId: null, status: "comp", currentPeriodEnd: null,
      providerEventCreatedAt: stamp, createdAt: subscription?.createdAt ?? now, updatedAt: now,
    });
    // Setup is done for a demo shop, so the app opens on Calls with the calendar card, not the setup steps.
    for (const key of ["hours_set_at", "completed_at"]) {
      if (!await store.getIntegrationSecret(tenantId, "onboarding", key)) await store.saveIntegrationSecret(tenantId, "onboarding", key, now);
    }
    if (!created) {
      // A new password every visit; it signs out every earlier session too.
      await store.updateOwnerPassword(account.id, passwordHash, now);
      if (!account.emailVerifiedAt) await store.markOwnerEmailVerified(account.id, now, null);
      if (account.status === "suspended") await store.updateOwnerAccountStatus(account.id, "pending_activation", now);
    }
    return { email: account.email, password, tenantId, created };
  });
}
