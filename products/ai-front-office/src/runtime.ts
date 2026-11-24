import { CapturingNotificationSender, InMemoryCalendar, InMemoryStore } from "./adapters/in-memory.js";
import { GoogleCalendarAdapter } from "./adapters/google-calendar.js";
import { anyGoogleClient, googleCredentials } from "./adapters/google-oauth-clients.js";
import { TeamCalendar } from "./adapters/team-calendar.js";
import { PostgresStore } from "./adapters/postgres-store.js";
import { TelnyxSmsAdapter } from "./adapters/telnyx.js";
import { ResendEmailAdapter } from "./adapters/resend.js";
import { NotificationRouter } from "./adapters/notification-router.js";
import { WebPushSender } from "./adapters/web-push.js";
import { hasOwnerCallConsent } from "./domain/owner-call-consent.js";
import { TelnyxOwnerCallSender, urgentOwnerCallsConfigured } from "./adapters/telnyx-owner-call.js";
import { UnavailableCalendar } from "./adapters/unavailable.js";
import { parseOwnerDestinations, type Environment } from "./config/environment.js";
import { createDemoConfig } from "./domain/config.js";
import { systemClock, type CalendarPort, type NotificationPort, type Store } from "./ports.js";
import { CryptoBox } from "./security/crypto-box.js";

export interface Runtime {
  store: Store;
  calendar: CalendarPort;
  sender: NotificationPort;
  integrations: Record<string, boolean>;
  close(): Promise<void>;
}

export async function createRuntime(env: Environment): Promise<Runtime> {
  if (env.DEMO_MODE) {
    const store = new InMemoryStore();
    await store.saveConfig({
      ...createDemoConfig(env.DEFAULT_TENANT_ID),
      businessName: env.DEFAULT_BUSINESS_NAME,
      timezone: env.DEFAULT_TIMEZONE,
    });
    return {
      store,
      calendar: new InMemoryCalendar(),
      sender: new CapturingNotificationSender(),
      integrations: { "Telnyx Voice": false, "Google Calendar": false, "Telnyx SMS": false, "Demo simulator": true },
      close: async () => undefined,
    };
  }

  const destinations = parseOwnerDestinations(env.OWNER_DESTINATIONS_JSON, false);
  const store = new PostgresStore(env.DATABASE_URL!, new CryptoBox(env.DATA_ENCRYPTION_KEY!));
  await store.ping();
  try {
    await store.getConfig(env.DEFAULT_TENANT_ID);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("No business configuration")) throw error;
    await store.saveConfig({
      ...createDemoConfig(env.DEFAULT_TENANT_ID),
      businessName: env.DEFAULT_BUSINESS_NAME,
      timezone: env.DEFAULT_TIMEZONE,
      ownerNotificationRefs: Object.keys(destinations),
      ownerTransferNumberRef: Object.keys(destinations)[0] ?? null,
    });
  }
  for (const [reference, phone] of Object.entries(destinations)) {
    if (!await store.getIntegrationSecret(env.DEFAULT_TENANT_ID, "notifications", reference)) {
      await store.saveIntegrationSecret(env.DEFAULT_TENANT_ID, "notifications", reference, phone);
    }
  }
  if (env.TELNYX_ASSISTANT_ID) {
    const now = new Date().toISOString();
    const existing = await store.getProviderRoute("telnyx", env.TELNYX_ASSISTANT_ID);
    if (!existing) await store.saveProviderRoute({ provider: "telnyx", externalId: env.TELNYX_ASSISTANT_ID, tenantId: env.DEFAULT_TENANT_ID, createdAt: now, updatedAt: now });
  }
  const googleConfigured = anyGoogleClient(env);
  const telnyxVoiceConfigured = Boolean(env.TELNYX_API_KEY && env.TELNYX_PUBLIC_KEY && env.TELNYX_ASSISTANT_ID);
  const telnyxSmsConfigured = Boolean(env.TELNYX_API_KEY && env.TELNYX_FROM_NUMBER && env.TELNYX_MESSAGING_PROFILE_ID);
  const soloCalendar = googleConfigured
    ? new GoogleCalendarAdapter({
        getCredentials: (tenantId) => googleCredentials(store, env, tenantId, "refresh_token"),
        onRevoked: (tenantId) => store.deleteIntegrationSecret(tenantId, "google", "refresh_token"),
        calendarId: env.GOOGLE_CALENDAR_ID,
      })
    : new UnavailableCalendar();
  const calendar = new TeamCalendar(store, soloCalendar, (accountId, owner) => googleConfigured ? new GoogleCalendarAdapter({
    calendarId: owner ? env.GOOGLE_CALENDAR_ID : "primary",
    getCredentials: (tenantId) => googleCredentials(store, env, tenantId, owner ? "refresh_token" : `refresh_token:${accountId}`),
    onRevoked: (tenantId) => store.deleteIntegrationSecret(tenantId, "google", owner ? "refresh_token" : `refresh_token:${accountId}`),
  }) : new UnavailableCalendar());
  const smsSender = telnyxSmsConfigured
    ? new TelnyxSmsAdapter({
        apiKey: env.TELNYX_API_KEY!,
        fromNumber: env.TELNYX_FROM_NUMBER!,
        ...(env.FOUNDER_WELCOME_FROM_NUMBER ? { founderFromNumber: env.FOUNDER_WELCOME_FROM_NUMBER } : {}),
        messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID!,
        resolveDestination: async (tenantId, reference) =>
          (await store.getIntegrationSecret(tenantId, "notifications", reference)) ?? null,
        isOptedOut: (tenantId, phone) => store.isSmsOptedOut(tenantId, phone),
        claimStopNotice: (phone, notificationId, firstAttempt) => store.claimSmsStopNotice(phone, notificationId, new Date().toISOString(), firstAttempt),
        webhookUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
        textingApproved: env.TELNYX_MESSAGING_APPROVED,
        ...(env.PROVIDER_TEST_MODE ? { allowedDirectDestinations: new Set(Object.values(destinations)) } : {}),
      })
    : null;
  const emailConfigured = Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
  const emailSender = emailConfigured
    ? new ResendEmailAdapter({ apiKey: env.RESEND_API_KEY!, from: env.RESEND_FROM_EMAIL! })
    : null;
  const pushSender = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? new WebPushSender({ store, clock: systemClock, vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT } })
    : null;
  const voiceSender = urgentOwnerCallsConfigured(env)
    ? new TelnyxOwnerCallSender({
        apiKey: env.TELNYX_API_KEY!, connectionId: env.TELNYX_CHECK_CONNECTION_ID!, from: env.TELNYX_FROM_NUMBER!, clock: systemClock,
        webhookUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
        resolveDestination: async (tenantId, reference) => (await store.getIntegrationSecret(tenantId, "notifications", reference)) ?? null,
        claimDial: (key) => store.claimWebhook(key),
        hasConsent: (tenantId, phone) => hasOwnerCallConsent(store, tenantId, phone),
        ...(env.PROVIDER_TEST_MODE ? { allowedDestinations: new Set(Object.values(destinations)) } : {}),
      })
    : null;
  const sender = new NotificationRouter(smsSender, emailSender, pushSender, voiceSender);
  return {
    store,
    calendar,
    sender,
    integrations: { "Telnyx Voice": telnyxVoiceConfigured, "Google Calendar": googleConfigured, "Telnyx SMS": telnyxSmsConfigured, "Weekly Email": emailConfigured, "Web Push": Boolean(pushSender), "Urgent owner calls": Boolean(voiceSender) },
    close: () => store.close(),
  };
}
