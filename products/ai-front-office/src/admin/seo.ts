import { COMPANY } from "./footer.js";
import { money, type Plan } from "../domain/plans.js";

/**
 * What search engines and AI answers need to find Call Otto and tell it apart from look-alikes
 * (Ottomatic's "Otto Front Desk", OttoCalls, callotto.ai). Every public page credits one address, says
 * the same sentence about what Call Otto is, and names Dutchworks LLC as its maker.
 */

/** The one public address. The Railway URL and www both lead here, so every canonical link names it. */
export const SITE_URL = "https://callotto.co";

/** Public pages, in the order the sitemap lists them. Owner screens, demos and call-back links stay out. */
export const SITEMAP_PATHS = ["/", "/signup", "/privacy", "/terms"] as const;

/** The same sentence everywhere Call Otto is described, built from the plan price so it never goes stale. */
export function entitySentence(monthlyCents: number): string {
  return `Call Otto (callotto.co) is a ${money(monthlyCents)}-a-month AI answering service for solo HVAC and plumbing owners, made by ${COMPANY.legalName}.`;
}

const escapeAttribute = (value: string): string => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** Canonical link plus Open Graph and card tags for one public page. */
export function seoHead(input: { path: string; title: string; description: string }): string {
  const url = `${SITE_URL}${input.path}`;
  const title = escapeAttribute(input.title);
  const description = escapeAttribute(input.description);
  return [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Call Otto">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:image" content="${SITE_URL}/assets/front-office-mascot-flat.png?v=2">`,
    `<meta name="twitter:card" content="summary">`,
  ].join("");
}

/**
 * Organization, WebSite and SoftwareApplication facts for the homepage, as JSON-LD. A data block, not a script,
 * so the strict CSP does not apply; "<" is escaped so no value can close the tag.
 */
export function structuredData(plans: readonly Plan[], fallbackMonthlyCents: number): string {
  const base = plans[0]?.priceCents ?? fallbackMonthlyCents;
  const maker = { "@id": `${SITE_URL}/#maker` };
  const offer = (name: string | null, cents: number) => ({
    "@type": "Offer",
    ...(name ? { name } : {}),
    price: (cents / 100).toFixed(2),
    priceCurrency: "USD",
    url: `${SITE_URL}/#pricing`,
    priceSpecification: { "@type": "UnitPriceSpecification", price: (cents / 100).toFixed(2), priceCurrency: "USD", unitText: "MONTH", referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" } },
  });
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": maker["@id"],
        name: COMPANY.legalName,
        // Name and site only: the homepage keeps the street address and phone off (they live on Privacy and Terms).
        url: COMPANY.website,
      },
      { "@type": "WebSite", "@id": `${SITE_URL}/#website`, name: "Call Otto", url: `${SITE_URL}/`, publisher: maker },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#app`,
        name: "Call Otto",
        url: `${SITE_URL}/`,
        description: entitySentence(base),
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "AI answering service",
        operatingSystem: "Web",
        audience: { "@type": "BusinessAudience", audienceType: "Owners of HVAC, plumbing and other home-service trade businesses" },
        creator: maker,
        publisher: maker,
        offers: plans.length ? plans.map((plan) => offer(plan.label, plan.priceCents)) : [offer(null, base)],
      },
    ],
  };
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}

/** Every crawler, AI ones included, may read the public site. Owner, admin and API paths are private anyway. */
export const ROBOTS_TXT = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Disallow: /app
Disallow: /c/
Disallow: /d/
Disallow: /dial/

Sitemap: ${SITE_URL}/sitemap.xml
`;

export function sitemapXml(): string {
  const urls = SITEMAP_PATHS.map((path) => `<url><loc>${SITE_URL}${path}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}
