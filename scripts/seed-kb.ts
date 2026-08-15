/**
 * Fills in kb_chunks.embedding for every row seeded without one.
 *
 * Runs the MiniLM model locally, so this costs nothing and needs no API key.
 * First run downloads ~90MB of weights and caches them.
 *
 *   pnpm seed:kb
 */
import { embedMany, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../src/lib/embeddings";
import { supabase } from "../src/lib/supabase";

interface ChunkRow {
  id: string;
  content: string;
}

async function main() {
  const { data, error } = await supabase
    .from("kb_chunks")
    .select("id, content")
    .is("embedding", null)
    .returns<ChunkRow[]>();

  if (error) throw new Error(`Failed to read kb_chunks: ${error.message}`);

  const rows = data ?? [];

  if (rows.length === 0) {
    console.log("Nothing to embed — every kb_chunk already has a vector.");
    return;
  }

  console.log(
    `Embedding ${rows.length} chunk(s) with ${EMBEDDING_MODEL} ` +
      `(${EMBEDDING_DIMENSIONS} dims). First run downloads the model.`,
  );

  const vectors = await embedMany(rows.map((row) => row.content));

  for (const [index, row] of rows.entries()) {
    const embedding = vectors[index];
    if (!embedding) throw new Error(`No vector produced for chunk ${row.id}`);

    const { error: updateError } = await supabase
      .from("kb_chunks")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", row.id);

    if (updateError) {
      throw new Error(`Failed to store vector for ${row.id}: ${updateError.message}`);
    }

    process.stdout.write(`  ${index + 1}/${rows.length}\r`);
  }

  console.log(`\nEmbedded ${rows.length} chunk(s).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
