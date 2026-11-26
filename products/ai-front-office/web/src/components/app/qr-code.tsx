import { useEffect, useState } from "react"
import { qrPixels } from "@/lib/qr"

/**
 * A QR code as an inline SVG: pure black on white with the standard 4-module quiet zone, drawn at least `size` CSS
 * pixels and rounded so each module is whole pixels, so a phone camera reads it off a laptop screen at once.
 * The encoder loads only when a QR is shown (computers), never on phones.
 */
export function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const [path, setPath] = useState<{ d: string; size: number } | null>(null)
  useEffect(() => {
    let live = true
    void import("@/lib/qr").then(({ qrPath }) => { if (live) setPath(qrPath(value)) }).catch(() => undefined)
    return () => { live = false }
  }, [value])
  const box = path?.size ?? 33
  const pixels = qrPixels(size, box)
  return (
    <svg role="img" aria-label={label} width={pixels} height={pixels} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" className="shrink-0 bg-white">
      <rect width={box} height={box} fill="#ffffff" />
      {path ? <path d={path.d} fill="#000000" /> : null}
    </svg>
  )
}
