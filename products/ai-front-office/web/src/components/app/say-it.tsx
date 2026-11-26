import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Loader2, Mic, Play, Plus, Square, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import type { ApiSettings } from "@/lib/types"
import { cn } from "@/lib/utils"
import { blankRow, rowsFrom, textFrom, withLine, wordKey, type WordRow } from "@/lib/words"

/** The app stops recording by itself after this long (the server caps the bytes). */
const MAX_MS = 5_000
type Clip = NonNullable<ApiSettings["wordClips"]>[number]
type SaidResult = { term: string; heard: string | null; savedAt: string; pronunciations: string | null }

/** What this browser records in that the server takes: Chrome webm/Opus, iPhone Safari mp4/AAC, Firefox ogg. */
function recordType(): string | undefined {
  const recorder = typeof window !== "undefined" ? window.MediaRecorder : undefined
  if (!recorder?.isTypeSupported) return undefined
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => recorder.isTypeSupported(type))
}
const canRecord = () => typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder === "function"

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "")
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export interface SayItProps {
  /** The saved "Word: sounds like" lines (the form value). */
  text: string
  onText: (text: string) => void
  clips: Clip[]
  /** The server saved this clip (and maybe its "sounds like"): show it as saved. */
  onSaid: (result: SaidResult) => void
  onUnsaid: (term: string) => void
}

/**
 * Settings > Names and words (walk 11-26, SET-05): the owner says the word, we keep it and turn it into the
 * "sounds like" text Otto reads (Otto's voice can't play a clip). The typed "sounds like" stays as the fallback.
 */
export function NamesAndWords({ text, onText, clips, onSaid, onUnsaid }: SayItProps) {
  const clipTerms = clips.map((clip) => clip.term)
  const [rows, setRows] = useState<WordRow[]>(() => withOneRow(rowsFrom(text, clipTerms)))
  // A saved value from outside (Save, Discard, a clip filling its row) wins over the rows on screen.
  useEffect(() => {
    setRows((current) => (textFrom(current) === text && sameClipRows(current, clipTerms) ? current : withOneRow(rowsFrom(text, clipTerms))))
  }, [text, clipTerms.join("\n")]) // eslint-disable-line react-hooks/exhaustive-deps
  // A browser that can't record at all turns Say it off; a blocked microphone only says so, and the next tap asks again.
  const [unsupported] = useState(() => !canRecord())
  const [problem, setProblem] = useState<string | null>(() => (unsupported ? "This browser can’t record. Type how it sounds." : null))
  const player = useRef<HTMLAudioElement | null>(null)

  const change = (next: WordRow[]) => { setRows(next); onText(textFrom(next)) }
  const edit = (id: string, patch: Partial<WordRow>) => change(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const clipFor = (term: string) => clips.find((clip) => wordKey(clip.term) === wordKey(term) && term.trim())

  const removeRecording = async (term: string) => {
    try {
      await api("/api/app/words/clip", { method: "DELETE", body: { term } })
      onUnsaid(term)
      toast.success("Recording removed.")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t change. Please try again.")
      return false
    }
  }
  const removeRow = async (row: WordRow) => {
    if (clipFor(row.term) && !(await removeRecording(row.term))) return
    change(withOneRow(rows.filter((item) => item.id !== row.id)))
  }
  const play = (clip: Clip) => {
    player.current?.pause()
    const audio = new Audio(`/api/app/words/clip?term=${encodeURIComponent(clip.term)}&v=${encodeURIComponent(clip.savedAt)}`)
    player.current = audio
    void audio.play().catch(() => toast.error("That didn’t play. Turn the sound up and try again."))
  }

  return (
    <div className="grid gap-3">
      <p className="text-[15px] text-muted-foreground text-pretty">{problem ?? "Tap Say it and say the word."}</p>
      <ul className="grid">
        {rows.map((row) => {
          const clip = clipFor(row.term)
          return (
            <li key={row.id} className="grid gap-2 border-t py-3 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-2">
                <Input aria-label="Word" placeholder="Word, like Myakka" className="h-12 flex-1 bg-card" value={row.term} maxLength={120} onChange={(event) => edit(row.id, { term: event.target.value.replace(/:/g, "") })} />
                <SayItButton term={row.term} disabled={unsupported} said={Boolean(clip)}
                  onProblem={setProblem}
                  onSaid={(result) => {
                    onSaid(result)
                    if (result.heard) setRows((current) => current.map((item) => (item.id === row.id ? { ...item, soundsLike: result.heard! } : item)))
                    toast.success(result.heard ? "Saved." : "Saved your voice. Type how it sounds, too.")
                  }} />
                <Button type="button" variant="ghost" className="size-12 shrink-0 text-muted-foreground lg:pointer-fine:size-11" aria-label={row.term.trim() ? `Remove ${row.term.trim()}` : "Remove this word"} onClick={() => void removeRow(row)}><X className="size-5" /></Button>
              </div>
              <label className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-[15px] text-muted-foreground">Sounds like</span>
                <Input aria-label={row.term.trim() ? `How ${row.term.trim()} sounds` : "How it sounds"} placeholder="Type how it sounds" className="h-12 min-w-0 flex-1 bg-card" value={row.soundsLike} maxLength={240}
                  onChange={(event) => edit(row.id, { soundsLike: event.target.value })} />
              </label>
              {clip && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-emerald-800"><CheckCircle2 className="size-5 shrink-0" />Voice saved</span>
                  <button type="button" className="inline-flex min-h-11 items-center gap-1.5 text-[15px] font-semibold underline underline-offset-4" onClick={() => play(clip)}><Play className="size-4" />Play</button>
                  <button type="button" className="inline-flex min-h-11 items-center text-[15px] text-muted-foreground underline underline-offset-4" onClick={() => void removeRecording(clip.term)}>Remove recording</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <Button type="button" size="tap" variant="outline" className="w-full bg-card sm:w-60" onClick={() => setRows([...rows, blankRow()])}><Plus />Add a word</Button>
    </div>
  )
}

const withOneRow = (rows: WordRow[]) => (rows.length ? rows : [blankRow()])
const sameClipRows = (rows: WordRow[], clipTerms: string[]) => clipTerms.every((term) => rows.some((row) => wordKey(row.term) === wordKey(term)))

/** Tap, say the word, tap again (or it stops by itself after 5 seconds); the clip goes to the server. */
function SayItButton({ term, disabled, said, onSaid, onProblem }: { term: string; disabled: boolean; said: boolean; onSaid: (result: SaidResult) => void; onProblem: (line: string | null) => void }) {
  const [state, setState] = useState<"idle" | "recording" | "saving">("idle")
  const [left, setLeft] = useState(MAX_MS / 1000)
  const recorder = useRef<MediaRecorder | null>(null)
  const timers = useRef<number[]>([])
  const clear = () => { for (const timer of timers.current) window.clearTimeout(timer); timers.current = [] }
  useEffect(() => () => { clear(); recorder.current?.state === "recording" && recorder.current.stop() }, [])

  const start = async () => {
    if (!term.trim()) { toast.error("Type the word first, then say it."); return }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ""
      onProblem(name === "NotAllowedError" || name === "SecurityError" ? "Your microphone is off. Type how it sounds." : "We couldn’t find a microphone. Type how it sounds.")
      return
    }
    onProblem(null)
    const type = recordType()
    let media: MediaRecorder
    try { media = new MediaRecorder(stream, type ? { mimeType: type } : undefined) } catch {
      for (const track of stream.getTracks()) track.stop()
      onProblem("This browser can’t record. Type how it sounds.")
      return
    }
    const chunks: Blob[] = []
    const began = Date.now()
    media.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    media.onstop = async () => {
      clear()
      for (const track of stream.getTracks()) track.stop()
      setState("saving")
      try {
        const blob = new Blob(chunks, { type: media.mimeType || type || "audio/webm" })
        const result = await api<SaidResult>("/api/app/words/clip", { method: "POST", body: { term: term.trim(), mimeType: blob.type, audio: await base64Of(blob), durationMs: Date.now() - began } })
        onSaid(result)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That didn’t save. Please try again.")
      } finally {
        setState("idle")
      }
    }
    recorder.current = media
    media.start()
    setState("recording")
    setLeft(MAX_MS / 1000)
    for (let second = 1; second < MAX_MS / 1000; second += 1) timers.current.push(window.setTimeout(() => setLeft(MAX_MS / 1000 - second), second * 1000))
    timers.current.push(window.setTimeout(() => { if (media.state === "recording") media.stop() }, MAX_MS))
  }
  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop() }

  const recording = state === "recording"
  const label = recording ? `Stop (${left})` : state === "saving" ? "Saving" : said ? "Say it again" : "Say it"
  return (
    <Button type="button" variant={recording ? "destructive" : "outline"} disabled={disabled || state === "saving"} aria-label={term.trim() ? `${label}: ${term.trim()}` : label} aria-pressed={recording}
      className={cn("h-12 w-28 shrink-0 rounded-full px-3 text-[15px] font-semibold lg:pointer-fine:h-11", !recording && "bg-card")}
      onClick={() => void (recording ? stop() : start())}>
      {state === "saving" ? <Loader2 className="size-4.5 animate-spin" /> : recording ? <Square className="size-4 fill-current" /> : <Mic className="size-4.5" />}
      <span>{recording ? `Stop ${left}` : state === "saving" ? "Saving" : said ? "Again" : "Say it"}</span>
    </Button>
  )
}

export { withLine }
