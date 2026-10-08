import { LocationInputSchema, type Me, OrganizationInputSchema } from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { notFound } from "../errors";
import { usesSampleData } from "../providers";
import { parseJson, uuidParam } from "../validation";

export const organizationRoutes = new Hono<AppEnv>();

organizationRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const me: Me = {
    user_id: user.id,
    email: user.email,
    organizations: await c.get("store").listOrganizations(),
    sample_data: usesSampleData(c.env),
  };
  return c.json(me);
});

organizationRoutes.post("/organizations", async (c) => {
  const { name } = await parseJson(c, OrganizationInputSchema);
  return c.json(await c.get("store").createOrganization(name), 201);
});

organizationRoutes.patch("/organizations/:organizationId", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const { name } = await parseJson(c, OrganizationInputSchema);
  const renamed = await c.get("store").renameOrganization(organizationId, name);
  if (!renamed) throw notFound("Organization");
  return c.json(renamed);
});

organizationRoutes.get("/organizations/:organizationId/locations", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  return c.json(await c.get("store").listLocations(organizationId));
});

organizationRoutes.post("/organizations/:organizationId/locations", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const input = await parseJson(c, LocationInputSchema);
  return c.json(await c.get("store").createLocation(organizationId, input), 201);
});
