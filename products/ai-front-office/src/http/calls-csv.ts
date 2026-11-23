import type { CallRecord } from "../domain/models.js";

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

/** The shop's calls as a spreadsheet: date, caller name, callback number, address, problem, outcome. Newest first. */
export function callsCsv(calls: CallRecord[], timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" });
  const rows = [...calls]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((call) => [
      date.format(new Date(call.startedAt)),
      call.fields.callerName,
      phone(call.fields.callbackNumber ?? call.fromNumber),
      call.fields.address,
      call.fields.problemDescription,
      OUTCOME_WORDS[call.outcome] ?? call.outcome,
    ].map(cell).join(","));
  // A byte-order mark so Excel opens the accents and dashes in callers' words correctly.
  return `﻿${["Date", "Caller name", "Callback number", "Address", "Problem", "Outcome"].map(cell).join(",")}\r\n${rows.map((row) => `${row}\r\n`).join("")}`;
}
