/** An Error the Fastify error handler turns into `{ error }` with this status. */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
