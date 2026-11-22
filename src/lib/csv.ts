/**
 * Escapes a single CSV cell value per RFC 4180:
 *  - If the value contains a comma, double-quote, newline or carriage-return,
 *    it is wrapped in double-quotes and any embedded double-quotes are doubled.
 *  - Empty/null values are emitted as an empty unquoted field.
 */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value);
  if (/[,"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(cells: (string | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/** Joins a header and rows into a CRLF-terminated CSV document. */
export function csvDocument(header: string, rows: string[]): string {
  return [header, ...rows].join('\r\n') + '\r\n';
}
