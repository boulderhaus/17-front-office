/** The company behind Front Office, published on the site (carrier/10DLC reviews check these are public). */
export const COMPANY = {
  legalName: "Dutchworks LLC",
  website: "https://bydutchworks.com",
  street: "16192 Coastal Highway",
  locality: "Lewes, DE 19958",
  phoneDisplay: "(929) 610-8092",
  phoneE164: "+19296108092",
  email: "hello@bydutchworks.com",
} as const;

const safe = (value: string): string => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** One sentence for the Privacy and Terms pages: who operates Front Office and how to reach them. */
export function companyStatementHtml(): string {
  return `Front Office is a product of ${COMPANY.legalName}, ${COMPANY.street}, ${COMPANY.locality}. Phone <a href="tel:${COMPANY.phoneE164}">${COMPANY.phoneDisplay}</a>, email <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>.`;
}

/** Who runs Front Office and how to reach a person. Shown on the homepage and signup. */
export function siteFooter(supportEmail: string | null | undefined): string {
  const support = supportEmail && supportEmail.toLowerCase() !== COMPANY.email ? ` Questions? <a href="mailto:${safe(supportEmail)}">${safe(supportEmail)}</a>` : "";
  return `<p class="maker">Front Office is a product of <a href="${COMPANY.website}" rel="noopener">${COMPANY.legalName}</a>.<br>${COMPANY.street}, ${COMPANY.locality}<br><a href="tel:${COMPANY.phoneE164}">${COMPANY.phoneDisplay}</a> · <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>${support}</p>`;
}

/** Version of the text-consent wording on the signup form, saved with each opt-in. */
export const SMS_CONSENT_VERSION = "2026-11-23.2";
