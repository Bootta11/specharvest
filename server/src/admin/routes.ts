import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth/plugin.ts";
import type { BurstManager } from "../crawler/burst/index.ts";
import { registerBurstRoutes } from "../crawler/burst/routes.ts";
import { registerBrowserRoutes } from "../crawler/browsers-routes.ts";
import { registerUsageAdminRoutes } from "./usage-routes.ts";
import { registerUserAdminRoutes } from "./users-routes.ts";

export const ADMIN_PREFIX = "/api/admin";

type Registrar = (admin: FastifyInstance) => void;

/**
 * The one admin boundary: every route registered here lives under /api/admin and is admin-only through a single
 * hook, so a handler can't forget the check. Admin handlers never call requireAdmin themselves (admin/guard.test.ts).
 */
export function adminScope(app: FastifyInstance, ...registrars: Registrar[]) {
  return app.register(
    async (admin) => {
      admin.addHook("onRequest", async (req) => void requireAdmin(req));
      for (const register of registrars) register(admin);
    },
    { prefix: ADMIN_PREFIX },
  );
}

/** The admin dashboard's API (client/src/admin). */
export function registerAdminRoutes(app: FastifyInstance, getBurst: () => BurstManager) {
  return adminScope(app, registerUserAdminRoutes, registerUsageAdminRoutes, registerBrowserRoutes, (admin) => registerBurstRoutes(admin, getBurst));
}
