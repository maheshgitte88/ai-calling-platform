/** Tiny time helpers shared across the backend. */

/** Current UTC time in ISO-8601 format. */
export function nowIso() {
  return new Date().toISOString();
}
