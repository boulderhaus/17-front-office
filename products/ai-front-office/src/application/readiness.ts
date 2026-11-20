import type { Environment } from "../config/environment.js";
import type { BusinessConfig } from "../domain/models.js";

export type ReadinessStatus = "pass" | "warn" | "block";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
}

export interface ActivationReport {
  go: boolean;
  mode: "simulator" | "provider_test" | "live_candidate";
  checks: ReadinessCheck[];
  blocking: ReadinessCheck[];
}

export function buildActivationReport(input: {
  env: Environment;
  config: BusinessConfig;
  googleConnected: boolean;
  ownerPhoneConfigured: boolean;
}): ActivationReport {
  const { env, config } = input;
  const checks: ReadinessCheck[] = [
    check("service_state", "Service is unpaused", !config.paused, config.paused ? "Paused: provider traffic is rejected." : "Provider traffic may be accepted."),
    check("runtime", "Production runtime", !env.DEMO_MODE, env.DEMO_MODE ? "Demo mode cannot serve a customer." : "Production runtime selected."),
    check("retell", "Retell configured", Boolean(env.RETELL_API_KEY), env.RETELL_API_KEY ? "API credential is present by name." : "RETELL_API_KEY is missing."),
    check("twilio", "Twilio SMS configured", Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_SECRET && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID)), "Account, auth, and sender configuration are required."),
    check("owner_phone", "Owner alert destination", input.ownerPhoneConfigured && config.ownerNotificationRefs.length > 0, input.ownerPhoneConfigured ? "Encrypted owner destination is configured." : "Owner notification phone is missing."),
    check("calendar", "Google Calendar connected", input.googleConnected, input.googleConnected ? "Encrypted refresh credential is present." : "Connect Google Calendar before activation."),
    check("public_url", "Public HTTPS URL", env.PUBLIC_BASE_URL.startsWith("https://"), env.PUBLIC_BASE_URL),
    check("identity", "AI identity in greeting", /\bAI\b/i.test(config.greeting), "Greeting must disclose the owner's AI assistant."),
    check("consent", "Recording disclosure", config.recordingDisclosure.trim().length > 0, "Launch counsel must approve the configured wording."),
    check("service_area", "Service area configured", config.serviceAreaTerms.length > 0, "At least one city, ZIP, or service-area term is required."),
    check("services", "Service categories configured", config.serviceCategories.length > 0, "At least one owner-approved service category is required."),
    check("pricing_script", "Diagnostic-fee script", !config.requireDiagnosticFeeAcceptance || config.priceSnippets.length > 0, "Fee-gated booking requires exact owner-approved wording."),
    check("live_proof", "Live provider proof recorded", Boolean(env.LIVE_PROVIDER_PROOF_AT), env.LIVE_PROVIDER_PROOF_AT ?? "Run the live smoke checklist, then record its timestamp."),
  ];
  checks.push({
    id: "billing",
    label: "Billing boundary",
    status: "warn",
    detail: `Manual billing only; configured plan is $${(config.flatMonthlyPriceCents / 100).toFixed(0)}/month. No automated subscription or usage enforcement exists.`,
  });
  checks.push({
    id: "routing",
    label: "Carrier overflow routing",
    status: "warn",
    detail: `Mirror ${config.operationMode.replace("_", " ")} coverage and ${config.answerAfterRings}-ring overflow in the carrier/Retell configuration.`,
  });
  const blocking = checks.filter((item) => item.status === "block");
  return {
    go: blocking.length === 0 && !env.PROVIDER_TEST_MODE,
    mode: env.DEMO_MODE ? "simulator" : env.PROVIDER_TEST_MODE ? "provider_test" : "live_candidate",
    checks,
    blocking,
  };
}

function check(id: string, label: string, passed: boolean, detail: string): ReadinessCheck {
  return { id, label, status: passed ? "pass" : "block", detail };
}
