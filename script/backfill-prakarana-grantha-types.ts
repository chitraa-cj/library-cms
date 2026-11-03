/**
 * One-off: move the 101 "Prakarana Grantha" granthas to their sub-category GranthaType
 * (classified 2026-11-03; same buckets as Sacred-Script-Hub client/src/lib/prakarana-categories.ts).
 *
 * PREREQUISITE: Strapi's grantha.GranthaType enum must already list the five
 * "Prakarana - …" values (schema.json on the box + `pm2 restart strapi-backend`),
 * otherwise every PUT 400s. Deploy the reading app that understands the new types first,
 * or these granthas drop out of its "Prakarana Granthas" home tab.
 *
 * Each PUT sends ONLY { GranthaType }. Already-moved granthas are skipped (safe to re-run);
 * `--first` writes a single grantha so draft/published behaviour can be checked first.
 *
 * Usage:
 *   npx tsx script/backfill-prakarana-grantha-types.ts            # dry run
 *   npx tsx script/backfill-prakarana-grantha-types.ts --first    # write one + verify
 *   npx tsx script/backfill-prakarana-grantha-types.ts --execute  # write all + verify
 */
import "../server/env";
import { strapiRequest } from "../server/strapi";
import { granthaTypes } from "../shared/schema";

const TYPE_BY_DOC_ID: Record<string, string> = {
  fvxvieo57zqp6rfeb5vv4cta: "Prakarana - Gitas", // Adbhutaramayana Ramagita
  glad1kujmqsakbh0sfe84fai: "Prakarana - Gitas", // Adhyatma Gita
  jhh99w85fha1id7auryv6xrz: "Prakarana - Gitas", // Arupa Gita
  c7ymftfffihx3uz3slicdeci: "Prakarana - Gitas", // aShTAvakra gItA
  wd7bdzxz12wumi61el3ieviy: "Prakarana - Gitas", // Avadhuta Gita
  brofpb25x6tgltlzh12zrkf5: "Prakarana - Gitas", // Baka gita
  mfybyz00yauzwfar8gmso23h: "Prakarana - Gitas", // Dharamvyaadha gita
  qy0xme0n0s6qzuseyjzrmi9m: "Prakarana - Gitas", // Ganesha Gita
  r8t53odojgzrhzwekzx4oktn: "Prakarana - Gitas", // Ganesha Gita Comprehensive
  n7nck658i38fc5sq34dintr4: "Prakarana - Gitas", // Guru Gita
  dpwni3g1wy4uy845gdp0gzfl: "Prakarana - Gitas", // Jayanteya Gita
  rqj5uzuj2r655b1nqef9tjfy: "Prakarana - Gitas", // Kapila Gita
  zgat36pd3bwqi4xrf9jq8mxb: "Prakarana - Gitas", // Kashyapa Gita
  f7ljw2thi8plimhn11inh30l: "Prakarana - Gitas", // Nahusha gita
  gv1vqise4wn0iokhrk4aids8: "Prakarana - Gitas", // Ribhu Gita
  jquhd6qziqk79njtr5c7l5lg: "Prakarana - Gitas", // Saraswati gita
  kspfti5ahbm02vcftz53m4gs: "Prakarana - Gitas", // Shaunaka Gita
  shccsvqrst6gj11vzopz5wta: "Prakarana - Gitas", // Shiva gita
  ftkzrc58da17wvl1vt0bwca9: "Prakarana - Gitas", // Shri Rama Gita
  egvyymauye1kzw33giuoit63: "Prakarana - Gitas", // Uddhava Gita
  ztdpmgeqj7eunhgjbs0lcdol: "Prakarana - Gitas", // Yama gita
  ca2ywh8yt3gnjk4wortvagmd: "Prakarana - Gitas", // Yudhishtira gita
  ntfozq69v2ag9ecxcz0om3nt: "Prakarana - Shankara Granthas", // Advaita Pañcaratnam
  u8sn5eg9p5cov8u3aqjvqh93: "Prakarana - Shankara Granthas", // Advaita Shatakam
  kdvwdk9vjqbtp44gzqyp9aa3: "Prakarana - Shankara Granthas", // Advaitanubhuti
  ooe2fu9ttgufw1svuzdmyhtw: "Prakarana - Shankara Granthas", // Anatma Shri Vigarhanam
  hx1wfwu0adz57cl5990hzagm: "Prakarana - Shankara Granthas", // Anātmaśrīvigarhaṇam
  qr2h305q8nf1ralaa5o5ytk9: "Prakarana - Shankara Granthas", // Aparokshanubhuthi
  mazzyims1l3upqnqruez5q1n: "Prakarana - Shankara Granthas", // Atma Bodha आत्मबोध
  smvpprx6no4rwq4u0qa3wvmv: "Prakarana - Shankara Granthas", // Atmastavah
  mk3wobg3chnw9qfoolyp53ws: "Prakarana - Shankara Granthas", // Atmavabodhanastotram
  d2651vpnwhfqj1y79amk7r1f: "Prakarana - Shankara Granthas", // Brahma gnanavali mala
  hoixp2sa6u5tzlnjep0ptyv8: "Prakarana - Shankara Granthas", // Brahmanuchintanam
  rqcwd3090z9be0wy6g5r8smu: "Prakarana - Shankara Granthas", // Daśaśloki
  f7xhgtldqvv33ckh16eqsb9w: "Prakarana - Shankara Granthas", // Dhanyashtakam
  xi8rwr7d2yi3xg6f00hnei8m: "Prakarana - Shankara Granthas", // Dhanyāṣṭakam
  s0x5fae5by5vbq8w9d118p4d: "Prakarana - Shankara Granthas", // Ekasloki
  kim8e5wt7bfm3exl02icfn2g: "Prakarana - Shankara Granthas", // Jeevan Mukthanandhalahari
  jw5znc1nbhc0z679j0ffxrgf: "Prakarana - Shankara Granthas", // Laghu Vākya Vṛtti
  np3szcvoc6tev0zceniocunv: "Prakarana - Shankara Granthas", // Mahavakya Vivaranam
  vgezpf3zd2v5y76twvb7dnxl: "Prakarana - Shankara Granthas", // Manīṣā Pañcakam
  dtyd0kmpb62pti7sknj3j0k0: "Prakarana - Shankara Granthas", // Maya Panchakam
  ibp5kvppm7xi8oo5zu6bm0m0: "Prakarana - Shankara Granthas", // Nirvanamanjari
  c1ofpv7hfk6ravmy8uxnecsh: "Prakarana - Shankara Granthas", // Pancheekaranam
  jhp7ei2vp1nfry48u6dgua8c: "Prakarana - Shankara Granthas", // Para Puja
  ptx6mswn2jfw95v58jz1bjpe: "Prakarana - Shankara Granthas", // Prabodha Sudhakara प्रबोधसुधाकरः
  fk86ceft5j7me59u5vnjjdua: "Prakarana - Shankara Granthas", // Prapancha Sara Tantra
  nblge3v83tey3lqai1q9wy9q: "Prakarana - Shankara Granthas", // Prashnottara Ratnamalika
  s72wt9frqytzgg3sfw8wlb48: "Prakarana - Shankara Granthas", // Praudhanubhuti
  y81afxfwpl095ewsqnu40hkq: "Prakarana - Shankara Granthas", // Sadhana Panchakam
  djtmv8722asy32nr86fmtmgy: "Prakarana - Shankara Granthas", // Sarva Vedanta Siddhantasaar Sangraha - वेदान्तशास्त्रसिद्धान्तसारसङ्ग्रह
  wcr0dyow3o7yswpcgkl9v3t9: "Prakarana - Shankara Granthas", // Svarupanusandhanashtakam
  vbfkcj9v60xb6l01mikngby0: "Prakarana - Shankara Granthas", // Svatmanirupanam
  a3dr7clcalyvhtevtgu97ozo: "Prakarana - Shankara Granthas", // Svatmaprakashika
  vghftx4e5apyoo9xpe0jpkdl: "Prakarana - Shankara Granthas", // Tattva Bodah
  ayq6h5oknfbc1g18v1teo7f4: "Prakarana - Shankara Granthas", // Tattvopadeshah
  xwxgji7cdd77s4iytjy3xlqp: "Prakarana - Shankara Granthas", // Upadesha Sahasri
  bnw8w7kqkhax4liss1uf2pnj: "Prakarana - Shankara Granthas", // Upadeśa‑Pañcakam
  ofx4h0x4wyd3z4a3jew7lnj1: "Prakarana - Shankara Granthas", // Vakya Vriththi
  a5dv2fo6q5a087r9h4wtt9mw: "Prakarana - Shankara Granthas", // Vivekachudamani
  wqmbas9uazatsu7u9iqhggc3: "Prakarana - Shankara Granthas", // Vākyavṛttiḥ
  hke5q44z9of46pdq8h5m65q0: "Prakarana - Shankara Granthas", // Yati Pañcakam
  fln7ocwhlvgv2m7ixrrknti8: "Prakarana - Shankara Granthas", // शतश्लोकी - Śataślokī
  y9fma1uvlxu65mvyz1emwdht: "Prakarana - Siddhi Granthas", // Advaita Chandrika
  ixm9971ao50392d0x9csot0d: "Prakarana - Siddhi Granthas", // Advaitasiddhānta Vaijayantī
  m84drug3g0roshr153nnsylp: "Prakarana - Siddhi Granthas", // Naishkarmyasidhi
  pu61ea93a3pkeby7vzh6vf7v: "Prakarana - Siddhi Granthas", // Sidhdhantha Bindu
  domymsar9l5cjdju0urhb30m: "Prakarana - Mimamsa Granthas", // Bhashyartha Ratnamala
  aiqpdcrqjfp056t5mo972lgy: "Prakarana - Mimamsa Granthas", // BhashyarthaRathnamala
  v31mzhq4925agnsj8ufyf9vl: "Prakarana - Mimamsa Granthas", // Pancheekaranam Vaarthikam
  dgu9lhmez5a2h2tze54tgmfu: "Prakarana - Mimamsa Granthas", // Purusha Suktham Bhashyam
  mxkh9r0ozvmwdizhtbitd5b2: "Prakarana - Mimamsa Granthas", // Vedanta Sutra Muktavali
  ovyiv9n603z73ivco5eh824k: "Prakarana - Mimamsa Granthas", // Yathi Dharma Sangraha
  euckqbo4nkv3cda7ay230t30: "Prakarana - Other Granthas", // Advaita Makaranda अद्वैतमकरन्दः
  oeippidsqnx90u4dbw315ma0: "Prakarana - Other Granthas", // Advaita Rasa Manjari
  j9jd467nxlk8oyw8x1i50rhb: "Prakarana - Other Granthas", // advaitaM dattAtreyavarmastotraM
  q8flr84vwn6c8kgkguqgo4vg: "Prakarana - Other Granthas", // Anubhuthi Prakasha
  c5iyap8ax1qj31b3euk1chov: "Prakarana - Other Granthas", // Atma Samadhi
  lkiq4ww8t6vzt04wr5094ky3: "Prakarana - Other Granthas", // Atmopadesha
  mjcae9rz0rlhgn6cp6v64j2q: "Prakarana - Other Granthas", // Brihadaranyaka Mitakshara
  z0506x3yfwzk36pdiy86om8a: "Prakarana - Other Granthas", // Drig Drishya-Vivek  दृग्दृश्य-विवेक
  zdta4l3fjm6gmnz61sz6qbii: "Prakarana - Other Granthas", // Drig-Drishya-Viveka
  xbjfcz3djuxb0sxvbemrn4dq: "Prakarana - Other Granthas", // Hastamalakiyam
  no7qgr1toaxka3ocf94mhm5e: "Prakarana - Other Granthas", // Jeevanmuktiviveka
  mashzlfck26iqvuzsybyb1fo: "Prakarana - Other Granthas", // Jivayatra
  zlqeja6vkegjl0q4q5zrpeq2: "Prakarana - Other Granthas", // Manasollasa Stutih by Appayya Dheekshitha
  fbvmoskwpufe9kdd1fk98v83: "Prakarana - Other Granthas", // Panchadasi
  riia0z069yeg9kd2bbsoiujm: "Prakarana - Other Granthas", // Panchadasi Patabedha
  uegz2wjbcp598z8sys64p1o5: "Prakarana - Other Granthas", // Paramartha Sara
  aesp6d5ht57jv6xkhut0x3yd: "Prakarana - Other Granthas", // Saddarshanam
  g7aiq9ec0hx32wf26bbsaj4z: "Prakarana - Other Granthas", // Shrutisarasamuddharanam
  x6fgqhcg79mok2vxeioy6gjg: "Prakarana - Other Granthas", // Suta Samhita
  mevrz7agxohjd2si13g7uirk: "Prakarana - Other Granthas", // Upadeshachaturvimshatih
  eokhdfpdyqznwn5ewknj080j: "Prakarana - Other Granthas", // Upadeshasaram
  spscf0vrbkg6tulf50j0rha8: "Prakarana - Other Granthas", // Vedanta Dindima
  ft7rrrgbwuvjz20f17us8rii: "Prakarana - Other Granthas", // Vedanta Panchadasi
  kbalo3b7oaul4dkghcwkrfgb: "Prakarana - Other Granthas", // Vedanta Paribhasha
  goqg3t303ukuhe6n71un2avn: "Prakarana - Other Granthas", // Vedanta Sara
  tn4g8eh79e6kyb1d3l2mlrck: "Prakarana - Other Granthas", // vedAntapara bhAgavataM
  n316ckeucvq1jfd6njfhg3t6: "Prakarana - Other Granthas", // vedAntaparatriveNI
  uit9l4sz26ety01ur8xxfr1v: "Prakarana - Other Granthas", // जगत् जीवः परमात्मा विचाराः
};

const execute = process.argv.includes("--execute");
const firstOnly = process.argv.includes("--first");

type Row = { documentId: string; GranthaName: string; GranthaType: string | null };

async function listGranthas(status: "published" | "draft"): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const res = await strapiRequest(
      `/api/granthas?status=${status}&fields[0]=GranthaName&fields[1]=GranthaType` +
        `&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    out.push(...res.data);
    if (page >= (res.meta?.pagination?.pageCount ?? 1)) return out;
  }
}

async function verify(): Promise<number> {
  let wrong = 0;
  for (const status of ["published", "draft"] as const) {
    const rows = await listGranthas(status);
    const counts: Record<string, number> = {};
    for (const g of rows) counts[g.GranthaType ?? "(none)"] = (counts[g.GranthaType ?? "(none)"] ?? 0) + 1;
    const off = rows.filter((g) => TYPE_BY_DOC_ID[g.documentId] && g.GranthaType !== TYPE_BY_DOC_ID[g.documentId]);
    console.log(`verify ${status}: ${rows.length} granthas, ${off.length} not yet moved`, counts);
    wrong += off.length;
  }
  return wrong;
}

async function main() {
  const unknown = [...new Set(Object.values(TYPE_BY_DOC_ID))].filter((t) => !(granthaTypes as readonly string[]).includes(t));
  if (unknown.length) throw new Error(`Not in granthaTypes: ${unknown.join(", ")}`);

  const published = await listGranthas("published");
  const byId = new Map(published.map((g) => [g.documentId, g]));
  const missing = Object.keys(TYPE_BY_DOC_ID).filter((id) => !byId.has(id));
  const stray = published.filter((g) => g.GranthaType === "Prakarana Grantha" && !TYPE_BY_DOC_ID[g.documentId]);
  const foreign = Object.keys(TYPE_BY_DOC_ID).filter((id) => {
    const t = byId.get(id)?.GranthaType;
    return t !== "Prakarana Grantha" && t !== TYPE_BY_DOC_ID[id];
  });
  if (missing.length) console.log("  mapped but not live:", missing);
  if (stray.length) console.log("  live Prakarana Grantha NOT in the mapping:", stray.map((g) => g.GranthaName));
  if (foreign.length) console.log("  mapped but currently another type:", foreign.map((id) => `${byId.get(id)?.GranthaName}=${byId.get(id)?.GranthaType}`));
  if (missing.length || stray.length || foreign.length) throw new Error("Mapping and live data disagree — not writing anything.");

  const todo = Object.keys(TYPE_BY_DOC_ID).filter((id) => byId.get(id)!.GranthaType !== TYPE_BY_DOC_ID[id]);
  console.log(`${Object.keys(TYPE_BY_DOC_ID).length} mapped, ${todo.length} to move.`);
  if (!execute && !firstOnly) {
    for (const id of todo) console.log(`  [dry] ${byId.get(id)!.GranthaName} -> ${TYPE_BY_DOC_ID[id]}`);
    console.log("Dry run only. Re-run with --first or --execute to write.");
    return;
  }

  let failed = 0;
  for (const id of firstOnly ? todo.slice(0, 1) : todo) {
    try {
      await strapiRequest(`/api/granthas/${id}`, {
        method: "PUT",
        body: JSON.stringify({ data: { GranthaType: TYPE_BY_DOC_ID[id] } }),
      });
      console.log(`  moved ${byId.get(id)!.GranthaName} -> ${TYPE_BY_DOC_ID[id]}`);
    } catch (e: any) {
      failed++;
      console.error(`  FAILED ${byId.get(id)!.GranthaName}: ${e.message}`);
    }
  }
  const wrong = await verify();
  if (failed || (execute && wrong)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
