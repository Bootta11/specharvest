import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUserSchema, serverLlmAccessModes, type AdminSettings, type UserCreated } from "@specharvest/shared";
import { env } from "../config.ts";
import { temporaryPassword } from "../auth/crypto.ts";
import { currentUser } from "../auth/plugin.ts";
import { setSignupEnabled, signupEnabled } from "../auth/routes.ts";
import { createUser, listUsers, setUserDisabled } from "../auth/users.ts";
import { httpError } from "../lib/http-error.ts";
import { serverDailyLimitUsd, serverLlmAccess, setServerDailyLimitUsd, setServerLlmAccess } from "../llm/resolve.ts";

const adminSettings = (): AdminSettings => ({
  signupEnabled: signupEnabled(),
  serverLlmAccess: serverLlmAccess(),
  serverLlmDailyLimitUsd: serverDailyLimitUsd(),
  serverLlmConfigured: !!env.OPENROUTER_API_KEY,
});
const adminSettingsSchema = z.object({
  signupEnabled: z.boolean().optional(),
  serverLlmAccess: z.enum(serverLlmAccessModes).optional(),
  serverLlmDailyLimitUsd: z.number().min(0).max(1000).optional(),
});

const idParam = (p: unknown) => z.coerce.number().int().positive().parse((p as { id?: string }).id);

/** Admin: users and sign-up / server LLM key settings. Registered inside the admin scope (admin/routes.ts). */
export function registerUserAdminRoutes(app: FastifyInstance) {
  app.get("/users", async () => listUsers());

  // No email sending exists — the admin passes the temporary password on.
  app.post("/users", async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const password = temporaryPassword();
    const user = await createUser(body.email, password, body.role);
    return reply.status(201).send({ ...user, temporaryPassword: password } satisfies UserCreated);
  });

  app.patch("/users/:id", async (req, reply) => {
    const me = currentUser(req);
    const id = idParam(req.params);
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    if (id === me.id && disabled) throw httpError(400, "You can't disable your own account");
    const user = setUserDisabled(id, disabled);
    return user ?? reply.status(404).send({ error: "Not found" });
  });

  app.get("/settings", async (): Promise<AdminSettings> => adminSettings());

  app.put("/settings", async (req): Promise<AdminSettings> => {
    const body = adminSettingsSchema.parse(req.body);
    if (body.signupEnabled !== undefined) setSignupEnabled(body.signupEnabled);
    // Who may use the server's LLM key when they have no key of their own, and how much a day (llm/resolve.ts).
    if (body.serverLlmAccess !== undefined) setServerLlmAccess(body.serverLlmAccess);
    if (body.serverLlmDailyLimitUsd !== undefined) setServerDailyLimitUsd(body.serverLlmDailyLimitUsd);
    return adminSettings();
  });
}
