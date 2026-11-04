// Turns a local calendar date + UTC offset into the UTC [start, end) instants
// the reporter queries (unit-tested in test/reporter.test.js).
//
// The HTTP contract says /report/daily takes a *local* date. Without `tz` the
// reporter uses this machine's own offset for that date; the phone UI passes
// its own offset (e.g. "+08:00" in the Philippines) so "today" matches the
// cashier's day, not the UTC day.

"use strict";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ_RE = /^([+-])(\d{2}):(\d{2})$/;

function parseDate(date) {
  const m = typeof date === "string" && DATE_RE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  // Rejects 2026-02-30 and friends, which Date would silently roll over.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, mo, d };
}

// "+08:00" -> 480, "Z" -> 0, invalid -> null.
function parseTz(tz) {
  if (tz === "Z") return 0;
  const m = typeof tz === "string" && TZ_RE.exec(tz);
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 14 || minutes > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function formatTz(offsetMinutes) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// -> { start, end, tz } as ISO strings, or { error } with a message.
function dayRange(date, tz) {
  const parts = parseDate(date);
  if (!parts) return { error: "date is required and must be a real YYYY-MM-DD date" };

  let offset;
  if (tz === undefined || tz === "") {
    offset = -new Date(parts.y, parts.mo - 1, parts.d, 12).getTimezoneOffset();
  } else {
    offset = parseTz(tz);
    if (offset === null) return { error: 'tz must be a UTC offset such as "+08:00" or "Z"' };
  }

  const startMs = Date.UTC(parts.y, parts.mo - 1, parts.d) - offset * 60_000;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 86_400_000).toISOString(),
    tz: formatTz(offset),
  };
}

module.exports = { dayRange, parseTz, formatTz };
