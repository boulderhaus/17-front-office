import { CALL_PATH_LIVE_WINDOW_MS } from "../domain/call-path.js";
import type { CallRecord } from "../domain/models.js";

/** The export's file name: the product's name and the day it was made. */
export function callsCsvFileName(now: Date): string {
  return `call-otto-calls-${now.toISOString().slice(0, 10)}.csv`;
}

const OUTCOME_WORDS: Record<string, string> = {
  in_progress: "On the call",
  booked: "Booked",
  pending_confirmation: "Needs your OK",
  handoff_queued: "Call back",
  ignored_spam: "Spam",
  failed: "Failed",
};

/**
 * One cell, quoted for CSV. A value a spreadsheet would run as a formula (=, +, -, @, tab, return)
 * gets a leading apostrophe, so a caller can't plant a formula in the owner's spreadsheet.
 */
function cell(value: string | null | undefined): string {
  let text = (value ?? "").replace(/\r\n?/g, "\n");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** "+19415550142" → "(941) 555-0142", the way an owner dials it back. */
function phone(value: string | null): string | null {
  const us = value ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value) : null;
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : value;
}

/**
 * A call still marked in progress after it hung up (its record not back yet) or long past any real call's
 * length is not "On the call" in a spreadsheet read later.
 */
function outcome(call: CallRecord, now: Date | undefined): string {
  if (call.outcome === "in_progress" && (call.endedAt !== null || (now && now.getTime() - Date.parse(call.startedAt) >= CALL_PATH_LIVE_WINDOW_MS))) return "Call ended";
  return OUTCOME_WORDS[call.outcome] ?? call.outcome;
}

/** The shop's calls as a spreadsheet: date, caller name, callback number, address, problem, outcome. Newest first. */
export function callsCsv(calls: CallRecord[], timeZone: string, now?: Date): string {
  const date = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" });
  const rows = [...calls]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((call) => [
      date.format(new Date(call.startedAt)),
      call.fields.callerName,
      phone(call.fields.callbackNumber ?? call.fromNumber),
      call.fields.address?.trim() || null,
      call.fields.problemDescription.trim() || null,
      outcome(call, now),
    ].map(cell).join(","));
  // A byte-order mark so Excel opens the accents and dashes in callers' words correctly.
  return `﻿${["Date", "Caller name", "Callback number", "Address", "Problem", "Outcome"].map(cell).join(",")}\r\n${rows.map((row) => `${row}\r\n`).join("")}`;
}
