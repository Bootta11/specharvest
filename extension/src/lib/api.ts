import type { Collection, CrawlRequest, ExtensionWhoami, InspectResult, Job } from "@specharvest/shared";
import { getSettings } from "./settings.ts";

/** REST calls from the popup / options page, with the extension token (the server allows extension origins). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, auth?: { serverUrl: string; token: string }): Promise<T> {
  const { serverUrl, token } = auth ?? (await getSettings());
  if (!serverUrl || !token) throw new ApiError(401, "Not connected");
  const res = await fetch(serverUrl + path, {
    ...init,
    headers: { "X-Api-Key": token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const whoami = (serverUrl: string, token: string) => call<ExtensionWhoami>("/api/extension/whoami", {}, { serverUrl, token });
export const listJobs = () => call<Job[]>("/api/jobs");
export const stopJob = (id: number) => call<Job>(`/api/jobs/${id}/stop`, { method: "POST" });
export const listCollections = () => call<Collection[]>("/api/collections");
export const inspect = (url: string) => call<InspectResult>("/api/crawl/inspect", { method: "POST", body: JSON.stringify({ url, runner: "browser" }) });
export const startCrawl = (req: CrawlRequest) => call<Job>("/api/crawl", { method: "POST", body: JSON.stringify(req) });
