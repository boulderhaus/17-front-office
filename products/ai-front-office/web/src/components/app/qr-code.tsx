import { useEffect, useState } from "react"

/**
 * A QR code as an inline SVG (dark squares on white, with the standard 4-module quiet zone), so a computer can
 * hand this page to the owner's phone. The encoder loads only when a QR is shown (computers), never on phones.
 */
export function QrCode({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const [path, setPath] = useState<{ d: string; count: number } | null>(null)
  useEffect(() => {
    let live = true
    void import("qrcode-generator").then(({ default: qrcode }) => {
      const qr = qrcode(0, "M")
      qr.addData(value)
      qr.make()
      const count = qr.getModuleCount()
      let d = ""
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`
      }
      if (live) setPath({ d, count })
    }).catch(() => undefined)
    return () => { live = false }
  }, [value])
  const box = (path?.count ?? 25) + 8
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" className="shrink-0 rounded-md border border-brand-ink/15 bg-white">
      <rect width={box} height={box} fill="#ffffff" />
      {path ? <path d={path.d} fill="#0b2545" /> : null}
    </svg>
  )
}
