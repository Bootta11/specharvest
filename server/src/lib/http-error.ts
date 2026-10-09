import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { createLogger, errorMessage } from "./logger.ts";

const log = createLogger("http");

/** An Error the Fastify error handler turns into `{ error }` with this status. */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Fastify error handler. Invalid input → 400 with the (first) issues. Errors that carry a status — httpError,
 * LLM key problems, refused targets, Fastify's own (413, 415, 429…) — keep their message. Anything else is a
 * bug or an internal failure (SQLite, LanceDB, file system): the client gets a generic 500, the log the details.
 */
export function errorHandler(err: Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) return reply.status(400).send({ error: "Invalid request", issues: err.issues.slice(0, 20) });
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 600) {
    if (status >= 500) log.error(`${req.method} ${req.url} → ${status}`, errorMessage(err));
    return reply.status(status).send({ error: errorMessage(err) });
  }
  log.error(`${req.method} ${req.url} failed`, err.stack ?? errorMessage(err));
  return reply.status(500).send({ error: "Internal error" });
}
