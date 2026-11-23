import { describe, expect, it } from "vitest";
import { renderMarketing } from "../src/admin/marketing.js";
import { REVIEWS, type Review } from "../src/admin/reviews.js";
import { createDemoConfig } from "../src/domain/config.js";

const sample = (n: number): Review[] => Array.from({ length: n }, (_, i) => ({ quote: `Synthetic quote ${i} <b>`, name: `Owner ${i}`, business: `Shop ${i}` }));

describe("homepage reviews", () => {
  it("ships no made-up reviews: the section is hidden until real ones are added", () => {
    expect(REVIEWS.every((review) => review.quote && review.name && review.business)).toBe(true);
    if (!REVIEWS.length) expect(renderMarketing(createDemoConfig())).not.toContain('id="reviews"');
  });

  it("shows six above the fold, folds the rest behind See more, and escapes text", () => {
    const html = renderMarketing(createDemoConfig(), sample(12));
    const [top, folded] = html.split('<details class="review-more">');
    expect(top!.match(/<figure class="review">/g)).toHaveLength(6);
    expect(folded!.match(/<figure class="review">/g)).toHaveLength(6);
    expect(html).toContain("See all 12 reviews");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("Synthetic quote 0 <b>");
  });

  it("has no See more button when everything fits", () => {
    expect(renderMarketing(createDemoConfig(), sample(4))).not.toContain("<details class=\"review-more\"");
  });
});
