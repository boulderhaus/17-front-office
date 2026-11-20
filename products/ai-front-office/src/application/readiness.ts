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
    check("telnyx_voice", "Telnyx voice configured", Boolean(env.TELNYX_API_KEY && env.TELNYX_PUBLIC_KEY && env.TELNYX_ASSISTANT_ID), "API key, webhook public key, and assistant ID are required."),
    check("telnyx_sms", "Telnyx SMS configured", Boolean(env.TELNYX_API_KEY && env.TELNYX_FROM_NUMBER && env.TELNYX_MESSAGING_PROFILE_ID), "API key, E.164 sender, and messaging profile are required."),
    check("sms_compliance", "Production messaging approved", env.TELNYX_MESSAGING_APPROVED, env.TELNYX_MESSAGING_APPROVED ? "Production messaging approval is recorded." : "Keep provider-test mode enabled until the Telnyx account and US messaging campaign are approved."),
    check("owner_phone", "Owner alert destination", input.ownerPhoneConfigured && config.ownerNotificationRefs.length > 0, input.ownerPhoneConfigured ? "Encrypted owner destination is configured." : "Owner notification phone is missing."),
    check("calendar", "Google Calendar connected", input.googleConnected, input.googleConnected ? "Encrypted refresh credential is present." : "Connect Google Calendar before activation."),
    check("public_url", "Public HTTPS URL", env.PUBLIC_BASE_URL.startsWith("https://"), env.PUBLIC_BASE_URL),
    check("branding", "Customer business identity", !/your service business|north star heating/i.test(`${config.businessName} ${config.greeting}`), "Replace all demo/placeholder business identity before launch."),
    check("identity", "AI identity in greeting", /\bAI\b/i.test(config.greeting), "Greeting must disclose the owner's AI assistant."),
    check("consent", "Recording consent approved", config.recordingDisclosure.trim().length > 0 && env.RECORDING_CONSENT_APPROVED, env.RECORDING_CONSENT_APPROVED ? "Approval is recorded for the configured wording and launch jurisdiction." : "A qualified reviewer must approve the configured wording for the launch jurisdiction."),
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
    detail: `Mirror ${config.operationMode.replace("_", " ")} coverage and ${config.answerAfterRings}-ring overflow in the Telnyx number routing configuration.`,
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
