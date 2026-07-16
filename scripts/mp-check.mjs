/**
 * LOCAL (laptop) decompress + inspect a single snapshot for Maya Panchakam.
 * Reads gzip bytes from stdin, extracts the grantha's manthras by known live documentIds,
 * and reports per-verse content lengths. Runs on the laptop — zero load on production.
 */
import { gunzipSync } from "node:zlib";

const LIVE = {
  hjsyqe16yo3n10zcg7iwujqh: "1.1",
  qqzf7saswd7cox8v2uek2ztl: "1.2",
  kl0c4mks0vhpkc6bhf8ujwve: "1.3",
  xej0ysykupooswcdfbl1p0g4: "1.4",
  glp22m2cfdvh4lyqsilwxumo: "1.5",
  jbiapq3dxo52t8osrgvm3948: "1.6",
};
const GRANTHA_DOC = "ewi0kldbomxr4iiib8jgjttp";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const b64 = Buffer.concat(chunks).toString("utf8").trim();
if (b64.length === 0 || b64 === "\\N") { console.log("EMPTY_BLOB (legacy uncompressed or missing)"); process.exit(0); }
const gz = Buffer.from(b64, "base64");

const d = JSON.parse(gunzipSync(gz).toString("utf8"));
const L = (x) => (typeof x === "string" ? x.trim().length : 0);

// Find ALL Maya Panchakam granthas (handles duplicates with different docIds)
const matches = (d.granthas || []).filter(
  (x) => x.documentId === GRANTHA_DOC || /maya\s*panchakam/i.test(x.GranthaName || "")
);
console.log(`grantha_matches=${matches.length}`);

let grandFull = 0;
for (const g of matches) {
  const gDoc = g.documentId;
  const secDocs = new Set((d.sections || []).filter((s) => s.grantha?.documentId === gDoc).map((s) => s.documentId));
  const mans = (d.manthras || []).filter((m) => secDocs.has(m.Section?.documentId ?? m.section?.documentId ?? ""));
  const isLive = gDoc === GRANTHA_DOC;
  console.log(`GRANTHA gDoc=${gDoc}${isLive ? " (LIVE)" : " (DUPLICATE?)"} name="${g.GranthaName}" sections=${secDocs.size} manthras=${mans.length}`);
  let full = 0;
  for (const m of mans) {
    const s = m.ShlokaManthraEntry || {};
    const b = m.BhashyamEntry || {};
    const tk = m.Teekas || [];
    const tkTxt = tk.filter((t) => L(t.TeekaEntry?.SanskritTextEntry) || L(t.TeekaEntry?.EnglishTranslationText) || (t.TeekaEntry?.OtherTranslations || []).length).length;
    const shlOt = (s.OtherTranslations || []).filter((r) => L(r.TranslationText)).length;
    const known = LIVE[m.documentId] ? `LIVE#${LIVE[m.documentId]}` : "(other-docId)";
    const has = L(s.SanskritTextEntry) || L(s.EnglishTranslationText) || L(b.SanskritTextEntry) || L(b.EnglishTranslationText) || tkTxt;
    if (has) full++;
    console.log(`  ${m.documentId} ${known} #${m.ShlokaManthraNumber} | shlSkt=${L(s.SanskritTextEntry)} shlEng=${L(s.EnglishTranslationText)} shlOT=${shlOt} bhSkt=${L(b.SanskritTextEntry)} bhEng=${L(b.EnglishTranslationText)} teeka=${tk.length}(txt=${tkTxt})`);
  }
  console.log(`  content=${full}/${mans.length}`);
  grandFull += full;
}
console.log(`SUMMARY total_manthras_with_content=${grandFull}`);
