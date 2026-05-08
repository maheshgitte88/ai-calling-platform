/**
 * Express-friendly HTTP error.
 *
 * Throw inside an async route handler / service to send a structured response
 * with the right status code:
 *
 *     throw new HttpError(404, "Interview session not found");
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code (e.g. 404, 409).
   * @param {string} message Error message returned to the client as `error`.
   * @param {Record<string, unknown>} [details] Optional extra fields merged into the JSON body.
   */
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}
