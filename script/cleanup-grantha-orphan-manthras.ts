/**
 * Remove Strapi manthra rows with blank ShlokaManthraNumber ("No number" in Mantras tab).
 *
 * Usage:
 *   GRANTHA_DOC_ID=<uuid> npx tsx script/cleanup-grantha-orphan-manthras.ts
 *   GRANTHA_DOC_ID=<uuid> DRY_RUN=0 npx tsx script/cleanup-grantha-orphan-manthras.ts
 */
import {
  deleteOrphanMantrasForGrantha,
  listOrphanMantrasForGrantha,
} from "../server/grantha-orphan-manthras";

const granthaDocId = process.env.GRANTHA_DOC_ID?.trim();
const dryRun = process.env.DRY_RUN !== "0";

async function main() {
  if (!granthaDocId || granthaDocId.length < 10) {
    console.error("Set GRANTHA_DOC_ID to the Strapi grantha documentId");
    process.exit(1);
  }
  const orphans = await listOrphanMantrasForGrantha(granthaDocId);
  console.log(`Orphan mantras (no verse number): ${orphans.length}`);
  for (const o of orphans) {
    console.log(
      `  - ${o.documentId} order=${o.order} section=${o.sectionTitle ?? o.sectionDocumentId ?? "?"}`,
    );
  }
  if (dryRun) {
    console.log("\nDry run only. Set DRY_RUN=0 to delete these rows from Strapi.");
    return;
  }
  const result = await deleteOrphanMantrasForGrantha(granthaDocId, { dryRun: false });
  console.log(`Deleted: ${result.deleted.length}, failed: ${result.failed.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
