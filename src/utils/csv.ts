/**
 * Escape a single CSV cell value.
 *
 * Two distinct concerns, both load-bearing:
 *
 *  1. **Formula injection.** A value that starts with `=`, `+`, `-`, or `@`
 *     is interpreted by Excel / Google Sheets as a formula on open, and a
 *     crafted string like `=cmd|'/c calc'!A1` can run code on the admin's
 *     machine. Prefixing with a single quote neutralises the leading character
 *     while still showing the visible text. The check is deliberately
 *     restricted to the FIRST character — the formula parsers key off the
 *     leading byte, so a comma or quote that happens to follow is irrelevant.
 *
 *  2. **Delimiters and newlines.** A value containing `"`, `,`, `\n`, or `\r`
 *     must be wrapped in quotes, with any embedded quote doubled. RFC 4180.
 *
 * `null` and `undefined` become the empty string. Numbers and booleans go
 * through `String()`. The result is always a string safe to drop between
 * commas in a row.
 */
export const escapeCsvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';

  let str = String(value);

  // Prevent spreadsheet formula injection when opened in Excel / Sheets.
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }

  if (
    str.includes('"') ||
    str.includes(',') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
};