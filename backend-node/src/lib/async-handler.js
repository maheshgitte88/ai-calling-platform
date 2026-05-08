import { HttpError } from "./http-error.js";

/**
 * Wrap an async Express handler so any thrown error is forwarded to
 * `next(err)` (and from there to the global error middleware).
 *
 * @param {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => Promise<unknown>} handler
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => void}
 */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Global Express error handler.
 *
 * - {@link HttpError}s send their declared status + message + details.
 * - Multer "file too large" errors map to HTTP 413.
 * - Anything else returns 400 with the error message (preserving the
 *   pre-refactor behaviour of the original try/catch blocks).
 *
 * @type {import("express").ErrorRequestHandler}
 */
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
  }
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Proctor frame exceeds size limit" });
  }
  return res.status(400).json({ error: err?.message || "Bad request" });
}
