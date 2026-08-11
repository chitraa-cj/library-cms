/** Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas/newlines, "" escapes. */
export function parseCSV(text) {
  // strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip, handle on \n */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  // last field/row (if file doesn't end with newline)
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
