import type { FastifyInstance } from "fastify";
import * as db from "../db/sqlite.ts";
import { getProviderCredits } from "../llm/credits.ts";

/** Admin: everyone's LLM spend and the server key's balance. Registered inside the admin scope (admin/routes.ts). */
export function registerUsageAdminRoutes(app: FastifyInstance) {
  app.get("/usage", async () => db.usageSummary(Date.now(), null));

  // Remaining OpenRouter balance — the shared server account.
  app.get("/credits", async () => getProviderCredits());
}
