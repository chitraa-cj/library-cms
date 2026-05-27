import "../server/env";
import { strapiRequest } from "../server/strapi";
import { blocksToText, filledLangs, MANTRA_FULL_QUERY } from "./lib/hermex-grantha-sync";

const G = "ngjdm2fcgp0ogp16jcey3vo1";

async function main() {
  let page = 1;
  const all: any[] = [];
  while (true) {
    const res = await strapiRequest(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${G}` +
        `&fields[0]=documentId&fields[1]=ShlokaManthraNumber&pagination[pageSize]=100&pagination[page]=${page}&sort=order:asc`,
    );
    all.push(...(res?.data ?? []));
    if (page >= (res?.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }

  console.log("Mantra | Shloka OT | Bhashyam OT | Teeka OT (Anandagiri) | English SK");
  for (const ref of all) {
    const m = (await strapiRequest(`/api/manthras/${ref.documentId}${MANTRA_FULL_QUERY}`))?.data;
    const sk = filledLangs(m.ShlokaManthraEntry);
    const bh = filledLangs(m.BhashyamEntry);
    const teeka = (m.Teekas ?? []).find((t: any) => /anandagiri/i.test(t.teeka?.TeekaName || t.TeekaName || ""));
    const tk = teeka ? filledLangs(teeka.TeekaEntry) : new Set();
    const engSk = blocksToText(m.ShlokaManthraEntry?.EnglishTranslationText).length > 0;
    console.log(
      `${ref.ShlokaManthraNumber} | ${sk.size} | ${bh.size} | ${tk.size} | eng=${engSk ? "yes" : "no"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
