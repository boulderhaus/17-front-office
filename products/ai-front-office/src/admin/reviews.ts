/**
 * Customer reviews shown on the homepage. Real reviews only, with the customer's permission:
 * an empty list hides the whole section.
 */
export interface Review {
  quote: string;
  name: string;
  /** e.g. "Owner, Gulf Air Heating & Cooling" */
  business: string;
  /** e.g. "Sarasota, FL" */
  place?: string;
  stars?: 1 | 2 | 3 | 4 | 5;
}

export const REVIEWS: Review[] = [];

/** How many cards show before "See more". */
const ABOVE_FOLD = 6;

export function renderReviews(reviews: Review[]): string {
  if (!reviews.length) return "";
  const card = (review: Review) => {
    const stars = review.stars ?? 5;
    const initials = review.name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();
    return `<figure class="review"><div class="review-stars" role="img" aria-label="${stars} out of 5 stars">${"★".repeat(stars)}<span>${"★".repeat(5 - stars)}</span></div><blockquote>“${esc(review.quote)}”</blockquote><figcaption><span class="review-avatar" aria-hidden="true">${esc(initials)}</span><span><strong>${esc(review.name)}</strong><small>${esc(review.business)}${review.place ? ` · ${esc(review.place)}` : ""}</small></span></figcaption></figure>`;
  };
  const top = reviews.slice(0, ABOVE_FOLD);
  const rest = reviews.slice(ABOVE_FOLD);
  return `<section class="wrap section reviews" id="reviews"><div class="reviews-head"><p class="eyebrow">From the owners</p><h2>Fewer missed calls.<br><em>In their words.</em></h2></div><div class="review-wall">${top.map(card).join("")}</div>${rest.length ? `<details class="review-more"><summary><span class="when-closed">See all ${reviews.length} reviews</span><span class="when-open">Show fewer</span></summary><div class="review-wall">${rest.map(card).join("")}</div></details>` : ""}</section>`;
}

export const reviewStyles = `.reviews-head{text-align:center}.review-wall{columns:3 300px;column-gap:20px;margin-top:40px}.review-more .review-wall{margin-top:20px}.review{break-inside:avoid;margin:0 0 20px;background:#fff;border:1px solid #dce1dd;border-radius:16px;padding:22px;box-shadow:0 8px 24px #073a6d0d}.review-stars{color:var(--ink);letter-spacing:2px;font-size:14px}.review-stars span{color:#073a6d33}.review blockquote{margin:12px 0 18px;font-size:16px;line-height:1.5}.review figcaption{display:flex;align-items:center;gap:12px}.review-avatar{display:grid;place-items:center;flex:none;width:38px;height:38px;border-radius:50%;background:var(--yellow);border:1.5px solid var(--ink);font-size:13px;font-weight:800}.review figcaption strong{display:block;font-size:15px;line-height:1.2}.review figcaption small{display:block;font-size:12px;opacity:.8}.reviews:has(.review-more:not([open]))>.review-wall{position:relative;max-height:620px;overflow:hidden}.reviews:has(.review-more:not([open]))>.review-wall:after{content:"";position:absolute;inset:auto 0 0;height:180px;background:linear-gradient(transparent,var(--paper))}.review-more summary{list-style:none;cursor:pointer;display:flex;justify-content:center;margin:8px auto 0;width:fit-content;min-height:48px;align-items:center;padding:12px 22px;border:1.5px solid var(--ink);border-radius:6px;background:var(--yellow);font-weight:750;box-shadow:3px 3px 0 var(--ink)}.review-more summary::-webkit-details-marker{display:none}.review-more[open] summary{order:2;margin-top:0}.review-more[open]{display:flex;flex-direction:column}.review-more .when-open,.review-more[open] .when-closed{display:none}.review-more[open] .when-open{display:inline}@media(max-width:640px){.review-wall{columns:1;margin-top:28px}.reviews:has(.review-more:not([open]))>.review-wall{max-height:560px}}`;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}
