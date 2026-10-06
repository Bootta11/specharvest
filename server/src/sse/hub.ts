import type { ServerResponse } from "node:http";
import type { JobEvent } from "@specharvest/shared";

interface BufferedEvent {
  seq: number;
  data: JobEvent;
}

/** Per-subscriber filter, e.g. only the jobs one user may see. */
type EventFilter = (data: JobEvent) => boolean;

interface Channel {
  subscribers: Map<ServerResponse, EventFilter | undefined>;
  buffer: BufferedEvent[];
  nextSeq: number;
  closeTimer?: NodeJS.Timeout;
}

const MAX_BUFFER = 500;
const channels = new Map<string, Channel>();

function channel(id: string): Channel {
  let c = channels.get(id);
  if (!c) {
    c = { subscribers: new Map(), buffer: [], nextSeq: 1 };
    channels.set(id, c);
  }
  return c;
}

function write(res: ServerResponse, seq: number, data: JobEvent) {
  res.write(`id: ${seq}\nevent: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Late subscribers get the buffered history replayed first (fast jobs can
 * finish before the client's EventSource connects); a reconnecting
 * EventSource sends Last-Event-ID so only newer events are replayed.
 */
export function subscribe(
  channelId: string,
  res: ServerResponse,
  lastEventId?: string,
  opts: { replay?: boolean; initial?: JobEvent[]; filter?: EventFilter } = {},
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":ok\n\n");
  const c = channel(channelId);
  let last = lastEventId ? Number(lastEventId) : NaN;
  // An id beyond anything this process issued means the server restarted — replay all.
  if (Number.isFinite(last) && last >= c.nextSeq) last = NaN;
  // `initial` replaces replay for channels where history is stale (e.g. the all-jobs feed sends a fresh snapshot).
  for (const data of opts.initial ?? []) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (opts.replay !== false) {
    for (const e of c.buffer) if ((!Number.isFinite(last) || e.seq > last) && (!opts.filter || opts.filter(e.data))) write(res, e.seq, e.data);
  }
  c.subscribers.set(res, opts.filter);
  const ping = setInterval(() => res.write(":ping\n\n"), 20_000);
  res.on("close", () => {
    clearInterval(ping);
    c.subscribers.delete(res);
  });
}

export function publish(channelId: string, data: JobEvent) {
  const c = channel(channelId);
  const seq = c.nextSeq++;
  c.buffer.push({ seq, data });
  if (c.buffer.length > MAX_BUFFER) {
    // Always keep the latest "job" snapshot even when trimming logs.
    c.buffer = c.buffer.slice(-MAX_BUFFER);
  }
  for (const [res, filter] of c.subscribers) if (!filter || filter(data)) write(res, seq, data);
}

/** Drops the channel's history some time after the job ended. */
export function retireChannel(channelId: string, afterMs = 10 * 60_000) {
  const c = channels.get(channelId);
  if (!c) return;
  clearTimeout(c.closeTimer);
  c.closeTimer = setTimeout(() => {
    for (const res of c.subscribers.keys()) res.end();
    channels.delete(channelId);
  }, afterMs);
  c.closeTimer.unref();
}

/** Cancels a pending retire, for a job that runs again (resumed crawl). */
export function reviveChannel(channelId: string) {
  const c = channels.get(channelId);
  if (!c) return;
  clearTimeout(c.closeTimer);
  c.closeTimer = undefined;
}
