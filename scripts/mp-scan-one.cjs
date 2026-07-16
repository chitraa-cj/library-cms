/**
 * SAFE on-box single-snapshot scanner for Maya Panchakam.
 * Reads ONE snapshot (id from argv), decompresses it, extracts only the tiny
 * Maya Panchakam grantha(s), prints a per-verse content summary, and exits.
 *
 * Safety: run with `node --max-old-space-size=1400`. Only ONE snapshot is ever
 * in memory; the process exits immediately after, fully reclaiming RAM. If a
 * snapshot were somehow too big, V8 throws "heap out of memory" and THIS process
 * dies cleanly — it can never swap the box to death the way a 26-in-one-loop did.
 */
const { Client } = require("pg");
const zlib = require("zlib");

const GRANTHA_DOC = "ewi0kldbomxr4iiib8jgjttp";
const LIVE = {
  hjsyqe16yo3n10zcg7iwujqh: "1.1", qqzf7saswd7cox8v2uek2ztl: "1.2",
  kl0c4mks0vhpkc6bhf8ujwve: "1.3", xej0ysykupooswcdfbl1p0g4: "1.4",
  glp22m2cfdvh4lyqsilwxumo: "1.5", jbiapq3dxo52t8osrgvm3948: "1.6",
};
const L = (x) => (typeof x === "string" ? x.trim().length : 0);

function decompress(raw) {
  if (raw && raw._compressed === true && typeof raw.data === "string") {
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"));
  }
  return raw; // legacy uncompressed
}

async function main() {
  const id = parseInt(process.argv[2], 10);
  const base = process.env.DATABASE_URL.split("?")[0];
  const c = new Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query("SELECT data FROM grantha_backups WHERE id=$1", [id]);
  await c.end();
  if (!r.rows.length) { console.log(`snap#${id} NOT_FOUND`); return; }

  const d = decompress(r.rows[0].data);
  const matches = (d.granthas || []).filter(
    (x) => x.documentId === GRANTHA_DOC || /maya\s*panchakam/i.test(x.GranthaName || "")
  );
  let grand = 0;
  const lines = [`snap#${id} grantha_matches=${matches.length}`];
  for (const g of matches) {
    const gDoc = g.documentId;
    const secDocs = new Set((d.sections || []).filter((s) => s.grantha?.documentId === gDoc).map((s) => s.documentId));
    const mans = (d.manthras || []).filter((m) => secDocs.has(m.Section?.documentId ?? m.section?.documentId ?? ""));
    lines.push(`  gDoc=${gDoc}${gDoc === GRANTHA_DOC ? " (LIVE)" : " (DUP?)"} name="${g.GranthaName}" sections=${secDocs.size} manthras=${mans.length}`);
    let full = 0;
    for (const m of mans) {
      const s = m.ShlokaManthraEntry || {}, b = m.BhashyamEntry || {}, tk = m.Teekas || [];
      const tkTxt = tk.filter((t) => L(t.TeekaEntry?.SanskritTextEntry) || L(t.TeekaEntry?.EnglishTranslationText) || (t.TeekaEntry?.OtherTranslations || []).length).length;
      const shlOt = (s.OtherTranslations || []).filter((x) => L(x.TranslationText)).length;
      const has = L(s.SanskritTextEntry) || L(s.EnglishTranslationText) || L(b.SanskritTextEntry) || L(b.EnglishTranslationText) || tkTxt;
      if (has) full++;
      const tag = LIVE[m.documentId] ? `LIVE#${LIVE[m.documentId]}` : "(other)";
      lines.push(`    ${m.documentId} ${tag} #${m.ShlokaManthraNumber} | shlSkt=${L(s.SanskritTextEntry)} shlEng=${L(s.EnglishTranslationText)} shlOT=${shlOt} bhSkt=${L(b.SanskritTextEntry)} bhEng=${L(b.EnglishTranslationText)} teeka=${tk.length}(txt=${tkTxt})`);
    }
    lines.push(`    content=${full}/${mans.length}`);
    grand += full;
  }
  lines.push(`  SUMMARY snap#${id} total_with_content=${grand}`);
  console.log(lines.join("\n"));
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
