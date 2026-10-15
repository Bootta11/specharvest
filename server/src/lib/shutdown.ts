import { httpError } from "./http-error.ts";

/** Set on SIGTERM: running jobs pause for the restart and nothing new starts (index.ts shutdown()). */
let shuttingDown = false;

export const beginShutdown = () => {
  shuttingDown = true;
};
export const isShuttingDown = () => shuttingDown;

/** 503 the clients retry (client/src/lib/api.ts): the request then lands on the new server. */
export const restartingError = () =>
  Object.assign(httpError(503, "The server is restarting for an update — trying again in a few seconds"), { retryAfter: 5, restarting: true });

/** Refuses work that would outlive this process (a job, a browser page) while it shuts down. */
export function assertAcceptingWork() {
  if (shuttingDown) throw restartingError();
}
