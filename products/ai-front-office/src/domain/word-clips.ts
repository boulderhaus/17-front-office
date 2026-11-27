import { wordClipKey } from "../ports.js";

/**
 * "Say it" clips for Settings > Names and words (walk 11-26, SET-05). The app stops recording after about
 * 5 seconds; the byte cap is what the server enforces (5 s of iPhone AAC is ~80 KB, Chrome Opus ~30 KB).
 */
export const WORD_CLIP_MAX_BYTES = 256_000;
export const WORD_CLIP_MIN_BYTES = 400;
/** The longest a clip may say it is; the app stops at 5 s. */
export const WORD_CLIP_MAX_MS = 8_000;

type ClipType = "audio/webm" | "audio/mp4" | "audio/ogg";

/** The base type of what the browser recorded ("audio/webm;codecs=opus" is audio/webm), or null when we don't take it. */
export function clipType(declared: unknown): ClipType | null {
  if (typeof declared !== "string") return null;
  const base = declared.split(";")[0]!.trim().toLowerCase();
  if (base === "audio/webm" || base === "video/webm") return "audio/webm";
  if (base === "audio/mp4" || base === "audio/x-m4a" || base === "audio/m4a" || base === "video/mp4" || base === "audio/aac") return "audio/mp4";
  if (base === "audio/ogg") return "audio/ogg";
  return null;
}

/** The bytes really are that container (EBML, ISO "ftyp", "OggS"), so nothing else is stored or served as audio. */
export function clipBytesMatch(type: ClipType, audio: Buffer): boolean {
  if (type === "audio/webm") return audio.length > 4 && audio.readUInt32BE(0) === 0x1a45dfa3;
  if (type === "audio/mp4") return audio.length > 8 && audio.toString("latin1", 4, 8) === "ftyp";
  return audio.toString("latin1", 0, 4) === "OggS";
}

export type ClipProblem = { status: number; error: string };

export interface ClipUpload {
  term: string;
  mimeType: ClipType;
  audio: Buffer;
}

/** Checks one upload ({ term, mimeType, audio: base64, durationMs? }); the error is one plain line. */
export function parseClipUpload(body: unknown): ClipUpload | ClipProblem {
  const value = (body ?? {}) as { term?: unknown; mimeType?: unknown; audio?: unknown; durationMs?: unknown };
  const term = typeof value.term === "string" ? value.term.replace(/\s+/g, " ").trim() : "";
  if (!term) return { status: 400, error: "Type the word first, then say it." };
  if (term.length > 120 || term.includes(":")) return { status: 400, error: "Use a shorter word, with no colon." };
  const mimeType = clipType(value.mimeType);
  if (!mimeType) return { status: 415, error: "This browser records in a format we can’t use. Type how it sounds instead." };
  if (typeof value.audio !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audio)) return { status: 400, error: "That recording didn’t come through. Try again." };
  if (typeof value.durationMs === "number" && value.durationMs > WORD_CLIP_MAX_MS) return { status: 413, error: "Keep it to one word, about 5 seconds." };
  const audio = Buffer.from(value.audio, "base64");
  if (audio.length > WORD_CLIP_MAX_BYTES) return { status: 413, error: "Keep it to one word, about 5 seconds." };
  if (audio.length < WORD_CLIP_MIN_BYTES) return { status: 400, error: "We didn’t hear anything. Try again." };
  if (!clipBytesMatch(mimeType, audio)) return { status: 415, error: "That recording didn’t come through. Try again." };
  return { term, mimeType, audio };
}

/** What speech-to-text heard, tidied for the "sounds like" field: no end punctuation or quotes, one line, 240 max. */
export function cleanHeard(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text.replace(/[\r\n]+/g, " ").replace(/:/g, " ").replace(/^[\s"'“”‘’«»()[\]…*.,!?¡¿;-]+|[\s"'“”‘’«»()[\]…*.,!?;-]+$/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
  return cleaned || null;
}

/** The pronunciation list with this word's "sounds like" set (added at the end when new, at most 100). */
export function withPronunciation(list: Array<{ term: string; spokenAs: string }>, term: string, spokenAs: string): Array<{ term: string; spokenAs: string }> {
  const key = wordClipKey(term);
  const at = list.findIndex((item) => wordClipKey(item.term) === key);
  if (at >= 0) return list.map((item, index) => (index === at ? { term: item.term, spokenAs } : item));
  return list.length >= 100 ? list : [...list, { term, spokenAs }];
}
