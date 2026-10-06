import path from "node:path";
import { env as hfEnv, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { env } from "./config.ts";
import { createLogger } from "./lib/logger.ts";

const log = createLogger("embedding");

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

hfEnv.cacheDir = path.join(env.DATA_DIR, "models");

let pipePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipePromise) {
    log.info(`Loading embedding model ${MODEL_ID} (first run downloads ~25MB)`);
    pipePromise = pipeline("feature-extraction", MODEL_ID, { dtype: "q8" }) as Promise<FeatureExtractionPipeline>;
    pipePromise.catch(() => (pipePromise = null));
  }
  return pipePromise;
}

/** 384-dim, mean-pooled, L2-normalized embedding. */
export async function embed(text: string): Promise<number[]> {
  const clean = text.trim();
  if (!clean) return new Array(EMBEDDING_DIM).fill(0);
  const extractor = await getPipeline();
  const output = await extractor(clean.slice(0, 4000), { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array).slice(0, EMBEDDING_DIM);
}
