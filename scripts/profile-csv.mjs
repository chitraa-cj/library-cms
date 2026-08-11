import fs from "node:fs";
import { parseCSV } from "./lib-csv.mjs";
const CSV = "Chandogya-Anandagiri Teeka v1.0.csv";
const rows = parseCSV(fs.readFileSync(CSV, "utf8"));
console.log("Header:", JSON.stringify(rows[0]));
const data = rows.slice(1).filter((r) => r.some((c) => c && c.trim() !== ""));
console.log("Data rows:", data.length);

// verse number column analysis
const verses = data.map((r) => (r[0] || "").trim());
const empties = data.filter((r) => !(r[0] || "").trim()).length;
console.log("Empty verse-no rows:", empties);
console.log("Rows with empty Anandagiri text:", data.filter((r) => !(r[1] || "").trim()).length);
console.log("\nFirst 15 verse numbers:", verses.slice(0, 15));
console.log("Last 10 verse numbers:", verses.slice(-10));

// distinct format check: expect like 1.1.1
const bad = verses.filter((v) => !/^\d+\.\d+\.\d+$/.test(v));
console.log(`\nVerse numbers NOT matching ^d.d.d$ : ${bad.length}`);
console.log(bad.slice(0, 40));

// duplicates
const seen = {}; const dups = [];
for (const v of verses) { seen[v] = (seen[v] || 0) + 1; }
for (const [v, n] of Object.entries(seen)) if (n > 1) dups.push(`${v} x${n}`);
console.log(`\nDuplicate verse numbers: ${dups.length}`, dups.slice(0, 40));

// sample content
console.log("\n=== sample row[0] Anandagiri text (first 400 chars) ===");
console.log(JSON.stringify(data[0][1].slice(0, 400)));
console.log("\n=== does any cell contain newlines? ===");
console.log("rows w/ embedded \\n in text:", data.filter((r) => (r[1] || "").includes("\n")).length);
