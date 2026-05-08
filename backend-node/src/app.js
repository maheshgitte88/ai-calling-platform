import cors from "cors";
import express from "express";

import { errorHandler } from "./lib/async-handler.js";
import interviewRoutes from "./interviews/routes.js";
import proctorRoutes from "./proctor/routes.js";

/**
 * Build and configure the Express application.
 *
 * Routes are split per concern in `src/<concern>/routes.js` and mounted
 * here. Async errors propagate to the central {@link errorHandler}.
 *
 * @returns {import("express").Express}
 */
export function createApp() {
  const app = express();

  // ---- middleware --------------------------------------------------------
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  // ---- liveness ----------------------------------------------------------
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // ---- feature routers ---------------------------------------------------
  app.use("/api/interviews", interviewRoutes);
  app.use("/api/interviews", proctorRoutes);

  // ---- error handler (must be last) --------------------------------------
  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
