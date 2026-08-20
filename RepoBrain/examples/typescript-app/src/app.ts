/**
 * Builds the express application and wires routes to their module handlers.
 * Route handlers stay thin: they parse input and delegate to module functions.
 */

import express, { type Express, type Request, type Response } from "express";
import { asyncRoute, badRequest, errorHandler } from "./common/http.js";
import { logger } from "./common/logger.js";
import { createLead } from "./modules/leads/createLead.js";
import { leadInputSchema } from "./modules/leads/lead.schema.js";
import { buildOrder } from "./modules/orders/calcTotal.js";
import { orderInputSchema } from "./modules/orders/order.schema.js";
import { createUser, listUsers } from "./modules/users/user.service.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // POST /leads -> createLead
  app.post(
    "/leads",
    asyncRoute(async (req: Request, res: Response) => {
      const parsed = leadInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest("invalid lead payload", parsed.error.flatten());
      }
      const lead = await createLead(parsed.data);
      res.status(201).json(lead);
    }),
  );

  // POST /orders -> handler that uses calcTotal (via buildOrder)
  app.post(
    "/orders",
    asyncRoute(async (req: Request, res: Response) => {
      const parsed = orderInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest("invalid order payload", parsed.error.flatten());
      }
      const order = buildOrder(
        parsed.data.items,
        parsed.data.discount,
        parsed.data.currency,
      );
      logger.info("order priced", { orderId: order.id, total: order.total });
      res.status(201).json(order);
    }),
  );

  app.post(
    "/users",
    asyncRoute(async (req: Request, res: Response) => {
      const user = await createUser(req.body);
      res.status(201).json(user);
    }),
  );

  app.get(
    "/users",
    asyncRoute(async (_req: Request, res: Response) => {
      res.json(await listUsers());
    }),
  );

  app.use(errorHandler);
  return app;
}
