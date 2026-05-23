// dashboard/public/lib/redact.js
//
// v2.8.18 — defense-in-depth UI redaction. The CLI guard at
// lib/accounts.sh blocks new api-key aliases, but legacy accounts.conf
// rows can still have keys as the alias (e.g. operator hand-edited).
// All places the dashboard renders an alias should pipe through this.
//
// Pattern: `escapeText(redactAlias(alias))` — escape comes after redact
// so the masked dots are HTML-safe.
//
// Copy-to-clipboard sites keep the FULL alias so legitimate `subctl
// auth <provider> <alias>` commands still work — only the displayed
// text is masked.
export function redactAlias(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  // Match common API-key prefixes; redact to prefix(12)…suffix(8).
  // Long enough to disambiguate, short enough that the screenshot
  // doesn't leak credentials.
  if (/^(sk-|pk-|Bearer\s)/i.test(s)) {
    if (s.length <= 16) return s.slice(0, 4) + "…" + s.slice(-3);
    return s.slice(0, 12) + "…" + s.slice(-8);
  }
  return s;
}
