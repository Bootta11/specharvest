import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { env } from "../config.ts";
import { EMBEDDING_DIM } from "../embedding.ts";

const TABLE = "item_vectors";

let tablePromise: Promise<lancedb.Table> | null = null;

async function openTable(): Promise<lancedb.Table> {
  const conn = await lancedb.connect(path.join(env.DATA_DIR, "lancedb"));
  const names = await conn.tableNames();
  if (names.includes(TABLE)) return conn.openTable(TABLE);
  // Seed row fixes the schema (vector dim + column types), then is removed.
  const table = await conn.createTable(TABLE, [{ item_id: -1, collection_id: -1, vector: new Array(EMBEDDING_DIM).fill(0) }]);
  await table.delete("item_id = -1");
  return table;
}

function getTable(): Promise<lancedb.Table> {
  if (!tablePromise) {
    tablePromise = openTable();
    tablePromise.catch(() => (tablePromise = null));
  }
  return tablePromise;
}

export async function upsertVector(itemId: number, collectionId: number, vector: number[]) {
  const table = await getTable();
  await table
    .mergeInsert("item_id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute([{ item_id: itemId, collection_id: collectionId, vector }]);
}

export async function deleteVectors(itemIds: number[]) {
  if (itemIds.length === 0) return;
  const table = await getTable();
  for (let i = 0; i < itemIds.length; i += 500) {
    await table.delete(`item_id IN (${itemIds.slice(i, i + 500).join(",")})`);
  }
}

/**
 * Cosine distance per item id, restricted to the given candidates (ids are
 * integers we generated, so inlining them in the filter is safe).
 */
export async function rankByVector(vector: number[], candidateIds: number[] | null, limit: number): Promise<Map<number, number>> {
  const table = await getTable();
  let q = table.vectorSearch(vector).distanceType("cosine").limit(limit);
  if (candidateIds) {
    if (candidateIds.length === 0) return new Map();
    q = q.where(`item_id IN (${candidateIds.join(",")})`).limit(Math.max(limit, candidateIds.length));
  }
  const rows = (await q.toArray()) as Array<{ item_id: number; _distance: number }>;
  return new Map(rows.map((r) => [Number(r.item_id), Number(r._distance)]));
}
