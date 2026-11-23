/** Who runs Front Office and how to reach a person. Shown on the homepage and signup. */
export function siteFooter(supportEmail: string | null | undefined): string {
  const safe = (value: string): string => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  const support = supportEmail ? ` Questions? <a href="mailto:${safe(supportEmail)}">${safe(supportEmail)}</a>` : "";
  return `<p class="maker">Front Office is a product of <a href="https://bydutchworks.com" rel="noopener">Dutchworks LLC</a>.${support}</p>`;
}

/** Version of the text-consent wording on the signup form, saved with each opt-in. */
export const SMS_CONSENT_VERSION = "2026-11-23.2";
