/**
 * One-off backfill of the new Strapi `grantha.PrakaranaCategory` field for the 101
 * Prakarana Granthas, classified on 2026-11-03 (same buckets as Sacred-Script-Hub
 * client/src/lib/prakarana-categories.ts).
 *
 * PREREQUISITE: the Strapi grantha schema must already carry
 *   "PrakaranaCategory": { "type": "string" }
 * (edit ~/library/strapi-backend/src/api/grantha/content-types/grantha/schema.json on the
 * box + `pm2 restart strapi-backend`), otherwise every PUT 400s with "Invalid key".
 *
 * Each PUT sends ONLY { PrakaranaCategory } — no other grantha field, relation or content
 * is touched. Granthas that already carry the right value are skipped, so re-runs are safe.
 *
 * Usage:
 *   npx tsx script/backfill-prakarana-category.ts            # dry run
 *   npx tsx script/backfill-prakarana-category.ts --execute  # write + verify
 */
import "../server/env";
import { strapiRequest } from "../server/strapi";
import { prakaranaCategories } from "../shared/schema";

const CATEGORY_BY_DOC_ID: Record<string, (typeof prakaranaCategories)[number]> = {
  fvxvieo57zqp6rfeb5vv4cta: "Gitas", // Adbhutaramayana Ramagita
  glad1kujmqsakbh0sfe84fai: "Gitas", // Adhyatma Gita
  jhh99w85fha1id7auryv6xrz: "Gitas", // Arupa Gita
  c7ymftfffihx3uz3slicdeci: "Gitas", // aShTAvakra gItA
  wd7bdzxz12wumi61el3ieviy: "Gitas", // Avadhuta Gita
  brofpb25x6tgltlzh12zrkf5: "Gitas", // Baka gita
  mfybyz00yauzwfar8gmso23h: "Gitas", // Dharamvyaadha gita
  qy0xme0n0s6qzuseyjzrmi9m: "Gitas", // Ganesha Gita
  r8t53odojgzrhzwekzx4oktn: "Gitas", // Ganesha Gita Comprehensive
  n7nck658i38fc5sq34dintr4: "Gitas", // Guru Gita
  dpwni3g1wy4uy845gdp0gzfl: "Gitas", // Jayanteya Gita
  rqj5uzuj2r655b1nqef9tjfy: "Gitas", // Kapila Gita
  zgat36pd3bwqi4xrf9jq8mxb: "Gitas", // Kashyapa Gita
  f7ljw2thi8plimhn11inh30l: "Gitas", // Nahusha gita
  gv1vqise4wn0iokhrk4aids8: "Gitas", // Ribhu Gita
  jquhd6qziqk79njtr5c7l5lg: "Gitas", // Saraswati gita
  kspfti5ahbm02vcftz53m4gs: "Gitas", // Shaunaka Gita
  shccsvqrst6gj11vzopz5wta: "Gitas", // Shiva gita
  ftkzrc58da17wvl1vt0bwca9: "Gitas", // Shri Rama Gita
  egvyymauye1kzw33giuoit63: "Gitas", // Uddhava Gita
  ztdpmgeqj7eunhgjbs0lcdol: "Gitas", // Yama gita
  ca2ywh8yt3gnjk4wortvagmd: "Gitas", // Yudhishtira gita
  ntfozq69v2ag9ecxcz0om3nt: "Shankara Granthas", // Advaita Pañcaratnam
  u8sn5eg9p5cov8u3aqjvqh93: "Shankara Granthas", // Advaita Shatakam
  kdvwdk9vjqbtp44gzqyp9aa3: "Shankara Granthas", // Advaitanubhuti
  ooe2fu9ttgufw1svuzdmyhtw: "Shankara Granthas", // Anatma Shri Vigarhanam
  hx1wfwu0adz57cl5990hzagm: "Shankara Granthas", // Anātmaśrīvigarhaṇam
  qr2h305q8nf1ralaa5o5ytk9: "Shankara Granthas", // Aparokshanubhuthi
  mazzyims1l3upqnqruez5q1n: "Shankara Granthas", // Atma Bodha आत्मबोध
  smvpprx6no4rwq4u0qa3wvmv: "Shankara Granthas", // Atmastavah
  mk3wobg3chnw9qfoolyp53ws: "Shankara Granthas", // Atmavabodhanastotram
  d2651vpnwhfqj1y79amk7r1f: "Shankara Granthas", // Brahma gnanavali mala
  hoixp2sa6u5tzlnjep0ptyv8: "Shankara Granthas", // Brahmanuchintanam
  rqcwd3090z9be0wy6g5r8smu: "Shankara Granthas", // Daśaśloki
  f7xhgtldqvv33ckh16eqsb9w: "Shankara Granthas", // Dhanyashtakam
  xi8rwr7d2yi3xg6f00hnei8m: "Shankara Granthas", // Dhanyāṣṭakam
  s0x5fae5by5vbq8w9d118p4d: "Shankara Granthas", // Ekasloki
  kim8e5wt7bfm3exl02icfn2g: "Shankara Granthas", // Jeevan Mukthanandhalahari
  jw5znc1nbhc0z679j0ffxrgf: "Shankara Granthas", // Laghu Vākya Vṛtti
  np3szcvoc6tev0zceniocunv: "Shankara Granthas", // Mahavakya Vivaranam
  vgezpf3zd2v5y76twvb7dnxl: "Shankara Granthas", // Manīṣā Pañcakam
  dtyd0kmpb62pti7sknj3j0k0: "Shankara Granthas", // Maya Panchakam
  ibp5kvppm7xi8oo5zu6bm0m0: "Shankara Granthas", // Nirvanamanjari
  c1ofpv7hfk6ravmy8uxnecsh: "Shankara Granthas", // Pancheekaranam
  jhp7ei2vp1nfry48u6dgua8c: "Shankara Granthas", // Para Puja
  ptx6mswn2jfw95v58jz1bjpe: "Shankara Granthas", // Prabodha Sudhakara प्रबोधसुधाकरः
  fk86ceft5j7me59u5vnjjdua: "Shankara Granthas", // Prapancha Sara Tantra
  nblge3v83tey3lqai1q9wy9q: "Shankara Granthas", // Prashnottara Ratnamalika
  s72wt9frqytzgg3sfw8wlb48: "Shankara Granthas", // Praudhanubhuti
  y81afxfwpl095ewsqnu40hkq: "Shankara Granthas", // Sadhana Panchakam
  djtmv8722asy32nr86fmtmgy: "Shankara Granthas", // Sarva Vedanta Siddhantasaar Sangraha - वेदान्तशास्त्रसिद्धान्तसारसङ्ग्रह
  wcr0dyow3o7yswpcgkl9v3t9: "Shankara Granthas", // Svarupanusandhanashtakam
  vbfkcj9v60xb6l01mikngby0: "Shankara Granthas", // Svatmanirupanam
  a3dr7clcalyvhtevtgu97ozo: "Shankara Granthas", // Svatmaprakashika
  vghftx4e5apyoo9xpe0jpkdl: "Shankara Granthas", // Tattva Bodah
  ayq6h5oknfbc1g18v1teo7f4: "Shankara Granthas", // Tattvopadeshah
  xwxgji7cdd77s4iytjy3xlqp: "Shankara Granthas", // Upadesha Sahasri
  bnw8w7kqkhax4liss1uf2pnj: "Shankara Granthas", // Upadeśa‑Pañcakam
  ofx4h0x4wyd3z4a3jew7lnj1: "Shankara Granthas", // Vakya Vriththi
  a5dv2fo6q5a087r9h4wtt9mw: "Shankara Granthas", // Vivekachudamani
  wqmbas9uazatsu7u9iqhggc3: "Shankara Granthas", // Vākyavṛttiḥ
  hke5q44z9of46pdq8h5m65q0: "Shankara Granthas", // Yati Pañcakam
  fln7ocwhlvgv2m7ixrrknti8: "Shankara Granthas", // शतश्लोकी - Śataślokī
  y9fma1uvlxu65mvyz1emwdht: "Siddhi Granthas", // Advaita Chandrika
  ixm9971ao50392d0x9csot0d: "Siddhi Granthas", // Advaitasiddhānta Vaijayantī
  m84drug3g0roshr153nnsylp: "Siddhi Granthas", // Naishkarmyasidhi
  pu61ea93a3pkeby7vzh6vf7v: "Siddhi Granthas", // Sidhdhantha Bindu
  domymsar9l5cjdju0urhb30m: "Mimamsa Granthas", // Bhashyartha Ratnamala
  aiqpdcrqjfp056t5mo972lgy: "Mimamsa Granthas", // BhashyarthaRathnamala
  v31mzhq4925agnsj8ufyf9vl: "Mimamsa Granthas", // Pancheekaranam Vaarthikam
  dgu9lhmez5a2h2tze54tgmfu: "Mimamsa Granthas", // Purusha Suktham Bhashyam
  mxkh9r0ozvmwdizhtbitd5b2: "Mimamsa Granthas", // Vedanta Sutra Muktavali
  ovyiv9n603z73ivco5eh824k: "Mimamsa Granthas", // Yathi Dharma Sangraha
  euckqbo4nkv3cda7ay230t30: "Other Granthas", // Advaita Makaranda अद्वैतमकरन्दः
  oeippidsqnx90u4dbw315ma0: "Other Granthas", // Advaita Rasa Manjari
  j9jd467nxlk8oyw8x1i50rhb: "Other Granthas", // advaitaM dattAtreyavarmastotraM
  q8flr84vwn6c8kgkguqgo4vg: "Other Granthas", // Anubhuthi Prakasha
  c5iyap8ax1qj31b3euk1chov: "Other Granthas", // Atma Samadhi
  lkiq4ww8t6vzt04wr5094ky3: "Other Granthas", // Atmopadesha
  mjcae9rz0rlhgn6cp6v64j2q: "Other Granthas", // Brihadaranyaka Mitakshara
  z0506x3yfwzk36pdiy86om8a: "Other Granthas", // Drig Drishya-Vivek  दृग्दृश्य-विवेक
  zdta4l3fjm6gmnz61sz6qbii: "Other Granthas", // Drig-Drishya-Viveka
  xbjfcz3djuxb0sxvbemrn4dq: "Other Granthas", // Hastamalakiyam
  no7qgr1toaxka3ocf94mhm5e: "Other Granthas", // Jeevanmuktiviveka
  mashzlfck26iqvuzsybyb1fo: "Other Granthas", // Jivayatra
  zlqeja6vkegjl0q4q5zrpeq2: "Other Granthas", // Manasollasa Stutih by Appayya Dheekshitha
  fbvmoskwpufe9kdd1fk98v83: "Other Granthas", // Panchadasi
  riia0z069yeg9kd2bbsoiujm: "Other Granthas", // Panchadasi Patabedha
  uegz2wjbcp598z8sys64p1o5: "Other Granthas", // Paramartha Sara
  aesp6d5ht57jv6xkhut0x3yd: "Other Granthas", // Saddarshanam
  g7aiq9ec0hx32wf26bbsaj4z: "Other Granthas", // Shrutisarasamuddharanam
  x6fgqhcg79mok2vxeioy6gjg: "Other Granthas", // Suta Samhita
  mevrz7agxohjd2si13g7uirk: "Other Granthas", // Upadeshachaturvimshatih
  eokhdfpdyqznwn5ewknj080j: "Other Granthas", // Upadeshasaram
  spscf0vrbkg6tulf50j0rha8: "Other Granthas", // Vedanta Dindima
  ft7rrrgbwuvjz20f17us8rii: "Other Granthas", // Vedanta Panchadasi
  kbalo3b7oaul4dkghcwkrfgb: "Other Granthas", // Vedanta Paribhasha
  goqg3t303ukuhe6n71un2avn: "Other Granthas", // Vedanta Sara
  tn4g8eh79e6kyb1d3l2mlrck: "Other Granthas", // vedAntapara bhAgavataM
  n316ckeucvq1jfd6njfhg3t6: "Other Granthas", // vedAntaparatriveNI
  uit9l4sz26ety01ur8xxfr1v: "Other Granthas", // जगत् जीवः परमात्मा विचाराः
};

const execute = process.argv.includes("--execute");

type Row = { documentId: string; GranthaName: string; GranthaType: string | null; PrakaranaCategory?: string | null };

async function listGranthas(status: "published" | "draft"): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const res = await strapiRequest(
      `/api/granthas?status=${status}&fields[0]=GranthaName&fields[1]=GranthaType&fields[2]=PrakaranaCategory` +
        `&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    out.push(...res.data);
    if (page >= (res.meta?.pagination?.pageCount ?? 1)) return out;
  }
}

async function main() {
  const bad = Object.values(CATEGORY_BY_DOC_ID).filter((c) => !prakaranaCategories.includes(c));
  if (bad.length) throw new Error(`Unknown categories: ${bad.join(", ")}`);

  const published = await listGranthas("published");
  const prakarana = published.filter((g) => g.GranthaType === "Prakarana Grantha");
  const unmapped = prakarana.filter((g) => !CATEGORY_BY_DOC_ID[g.documentId]);
  const missing = Object.keys(CATEGORY_BY_DOC_ID).filter((id) => !prakarana.some((g) => g.documentId === id));
  console.log(`Prakarana Granthas live: ${prakarana.length}, mapped: ${Object.keys(CATEGORY_BY_DOC_ID).length}`);
  if (unmapped.length) console.log("  live but NOT in the mapping:", unmapped.map((g) => g.GranthaName));
  if (missing.length) console.log("  mapped but not a live Prakarana Grantha:", missing);
  if (unmapped.length || missing.length) throw new Error("Mapping and live data disagree — not writing anything.");

  const todo = prakarana.filter((g) => g.PrakaranaCategory !== CATEGORY_BY_DOC_ID[g.documentId]);
  console.log(`${todo.length} to set, ${prakarana.length - todo.length} already correct.`);
  if (!execute) {
    for (const g of todo) console.log(`  [dry] ${g.GranthaName} -> ${CATEGORY_BY_DOC_ID[g.documentId]}`);
    console.log("Dry run only. Re-run with --execute to write.");
    return;
  }

  let failed = 0;
  for (const g of todo) {
    try {
      await strapiRequest(`/api/granthas/${g.documentId}`, {
        method: "PUT",
        body: JSON.stringify({ data: { PrakaranaCategory: CATEGORY_BY_DOC_ID[g.documentId] } }),
      });
      console.log(`  set ${g.GranthaName} -> ${CATEGORY_BY_DOC_ID[g.documentId]}`);
    } catch (e: any) {
      failed++;
      console.error(`  FAILED ${g.GranthaName}: ${e.message}`);
    }
  }

  // Verify on BOTH the published and the draft rows.
  for (const status of ["published", "draft"] as const) {
    const rows = (await listGranthas(status)).filter((g) => g.GranthaType === "Prakarana Grantha");
    const wrong = rows.filter((g) => g.PrakaranaCategory !== CATEGORY_BY_DOC_ID[g.documentId]);
    const counts: Record<string, number> = {};
    for (const g of rows) counts[g.PrakaranaCategory ?? "(none)"] = (counts[g.PrakaranaCategory ?? "(none)"] ?? 0) + 1;
    console.log(`verify ${status}: ${rows.length} granthas, ${wrong.length} wrong`, counts);
    for (const g of wrong) console.log(`  WRONG ${g.GranthaName}: ${g.PrakaranaCategory ?? "(none)"}`);
    if (wrong.length) failed++;
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
