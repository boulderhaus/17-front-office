import qrcode from "qrcode-generator"

/** Quiet zone around the code, in modules: the standard 4, so a camera finds the edges against any background. */
export const QR_QUIET = 4

/**
 * The QR's dark modules for `value`, with the quiet zone included in `size`. Error level L: the link is short
 * (/d/ + 8 letters), so the code stays version 2 or 3 (25 to 29 modules) and each module is big on screen.
 */
export function qrMatrix(value: string): { size: number; dark: (row: number, col: number) => boolean } {
  const qr = qrcode(0, "L")
  qr.addData(value)
  qr.make()
  const count = qr.getModuleCount()
  return {
    size: count + QR_QUIET * 2,
    dark: (row, col) => row >= QR_QUIET && col >= QR_QUIET && row < count + QR_QUIET && col < count + QR_QUIET && qr.isDark(row - QR_QUIET, col - QR_QUIET),
  }
}

/** The SVG path for the dark modules, one unit per module (viewBox 0 0 size size). */
export function qrPath(value: string): { d: string; size: number } {
  const matrix = qrMatrix(value)
  let d = ""
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) if (matrix.dark(row, col)) d += `M${col} ${row}h1v1h-1z`
  }
  return { d, size: matrix.size }
}

/** The on-screen size, rounded so every module is a whole number of CSS pixels (no uneven, blurry modules). */
export function qrPixels(minimum: number, modules: number): number {
  return Math.ceil(minimum / modules) * modules
}
