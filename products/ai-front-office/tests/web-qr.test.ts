import jsQRModule from "jsqr";
import { describe, expect, it } from "vitest";
import { qrMatrix, qrPixels, QR_QUIET } from "../web/src/lib/qr.js";

// jsqr is CommonJS with `exports.default`: under NodeNext the callable is on `.default`.
const jsQR = (jsQRModule as unknown as { default: typeof jsQRModule.default }).default ?? (jsQRModule as unknown as typeof jsQRModule.default);

/** Rasterize the QR exactly as the page draws it (whole pixels per module, black on white), then decode it. */
function render(value: string, minimum: number): { width: number; data: Uint8ClampedArray; modulePx: number } {
  const matrix = qrMatrix(value);
  const width = qrPixels(minimum, matrix.size);
  const modulePx = width / matrix.size;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = matrix.dark(Math.floor(y / modulePx), Math.floor(x / modulePx)) ? 0 : 255;
      const at = (y * width + x) * 4;
      data[at] = v; data[at + 1] = v; data[at + 2] = v; data[at + 3] = 255;
    }
  }
  return { width, data, modulePx };
}

describe("the computer's QR code", () => {
  const link = "https://callotto.co/d/Ab3dE6fG";

  it("decodes back to the short link, drawn at 180 px or more with whole-pixel modules", () => {
    const { width, data, modulePx } = render(link, 184);
    expect(width).toBeGreaterThanOrEqual(180);
    expect(Number.isInteger(modulePx)).toBe(true);
    expect(modulePx).toBeGreaterThanOrEqual(5);
    expect(jsQR(data, width, width)?.data).toBe(link);
  });

  it("is a small, sparse code (version 2 or 3) with a 4-module quiet zone", () => {
    const matrix = qrMatrix(link);
    expect(matrix.size - QR_QUIET * 2).toBeLessThanOrEqual(29);
    for (let index = 0; index < matrix.size; index += 1) {
      expect(matrix.dark(0, index)).toBe(false);
      expect(matrix.dark(QR_QUIET - 1, index)).toBe(false);
    }
  });
});
