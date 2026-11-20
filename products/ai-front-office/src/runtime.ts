import { CapturingNotificationSender, InMemoryCalendar, InMemoryStore } from "./adapters/in-memory.js";
import { GoogleCalendarAdapter } from "./adapters/google-calendar.js";
import { PostgresStore } from "./adapters/postgres-store.js";
import { TwilioSmsAdapter } from "./adapters/twilio-sms.js";
import { UnavailableCalendar, UnavailableNotificationSender } from "./adapters/unavailable.js";
import { parseOwnerDestinations, type Environment } from "./config/environment.js";
import { createDemoConfig } from "./domain/config.js";
import type { CalendarPort, NotificationPort, Store } from "./ports.js";
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
      integrations: { Retell: false, "Google Calendar": false, "Twilio SMS": false, "Demo simulator": true },
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
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const twilioConfigured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_SECRET && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID));
  const calendar = googleConfigured
    ? new GoogleCalendarAdapter({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        getRefreshToken: async () => env.GOOGLE_REFRESH_TOKEN || await store.getIntegrationSecret(env.DEFAULT_TENANT_ID, "google", "refresh_token"),
        calendarId: env.GOOGLE_CALENDAR_ID,
      })
    : new UnavailableCalendar();
  const sender = twilioConfigured
    ? new TwilioSmsAdapter({
        accountSid: env.TWILIO_ACCOUNT_SID!,
        authUser: env.TWILIO_AUTH_USER || env.TWILIO_ACCOUNT_SID!,
        authSecret: env.TWILIO_AUTH_SECRET!,
        resolveDestination: (reference) => store.getIntegrationSecret(env.DEFAULT_TENANT_ID, "notifications", reference),
        ...(env.TWILIO_FROM_NUMBER ? { fromNumber: env.TWILIO_FROM_NUMBER } : {}),
        ...(env.TWILIO_MESSAGING_SERVICE_SID ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID } : {}),
      })
    : new UnavailableNotificationSender();
  return {
    store,
    calendar,
    sender,
    integrations: { Retell: Boolean(env.RETELL_API_KEY), "Google Calendar": googleConfigured, "Twilio SMS": twilioConfigured },
    close: () => store.close(),
  };
}
