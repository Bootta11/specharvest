import type { Collection, CrawlRequest, ExtensionWhoami, InspectResult, Job } from "@specharvest/shared";
import type { ServerEntry } from "./settings.ts";

/** REST calls from the popup / options page to one paired server, with its token (the server allows extension origins). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Auth = Pick<ServerEntry, "serverUrl" | "token">;

async function call<T>(auth: Auth, path: string, init: RequestInit = {}): Promise<T> {
  const { serverUrl, token } = auth;
  if (!serverUrl || !token) throw new ApiError(401, "Not connected");
  const res = await fetch(serverUrl + path, {
    ...init,
    headers: { "X-Api-Key": token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const whoami = (auth: Auth) => call<ExtensionWhoami>(auth, "/api/extension/whoami");
export const listJobs = (auth: Auth) => call<Job[]>(auth, "/api/jobs");
export const stopJob = (auth: Auth, id: number) => call<Job>(auth, `/api/jobs/${id}/stop`, { method: "POST" });
export const listCollections = (auth: Auth) => call<Collection[]>(auth, "/api/collections");
export const inspect = (auth: Auth, url: string) => call<InspectResult>(auth, "/api/crawl/inspect", { method: "POST", body: JSON.stringify({ url, runner: "browser" }) });
export const startCrawl = (auth: Auth, req: CrawlRequest) => call<Job>(auth, "/api/crawl", { method: "POST", body: JSON.stringify(req) });
