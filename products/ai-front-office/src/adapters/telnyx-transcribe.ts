/**
 * Speech-to-text for Settings > Names and words "Say it" clips (walk 11-26, SET-05): Otto's voice reads text and
 * can't play a clip, so what the owner said is turned into the row's "sounds like" text.
 * Telnyx: POST /v2/ai/audio/transcriptions, multipart (model, file), Bearer API key; answers { text }.
 */

/** Multilingual (street names are often Spanish), and it takes webm, mp4 and ogg. TELNYX_STT_MODEL overrides it. */
export const DEFAULT_TELNYX_STT_MODEL = "openai/whisper-large-v3-turbo";
const TRANSCRIBE_URL = "https://api.telnyx.com/v2/ai/audio/transcriptions";
const TIMEOUT_MS = 15_000;
const EXTENSIONS: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg" };

export interface Transcriber {
  /** What was said, or null when nothing usable came back. Throws on provider failure. */
  transcribe(audio: Buffer, mimeType: string): Promise<string | null>;
}

export class TelnyxTranscriber implements Transcriber {
  constructor(private readonly apiKey: string, private readonly model: string, private readonly fetcher: typeof fetch = fetch) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<string | null> {
    const form = new FormData();
    form.set("model", this.model);
    form.set("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `word.${EXTENSIONS[mimeType] ?? "webm"}`);
    const response = await this.fetcher(TRANSCRIBE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Telnyx transcription failed with ${response.status}`);
    const payload = await response.json().catch(() => null) as { text?: unknown } | null;
    return typeof payload?.text === "string" ? payload.text : null;
  }
}
