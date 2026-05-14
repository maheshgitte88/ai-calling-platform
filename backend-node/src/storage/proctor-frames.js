import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { env } from "../config.js";

/**
 * Azure Blob Storage helpers for proctor frame uploads.
 *
 * The container client is constructed lazily on first use so unit tests and
 * import-time tooling don't crash when Azure env vars are absent.
 */

let _containerClient = null;

function getContainerClient() {
  if (_containerClient) return _containerClient;

  const account = env.AZURE_STORAGE_ACCOUNT_NAME;
  const key = env.AZURE_STORAGE_ACCOUNT_KEY;
  const container = env.AZURE_STORAGE_CONTAINER_NAME;
  if (!account || !key || !container) {
    throw new Error("Azure storage env not configured for proctor uploads");
  }

  const credential = new StorageSharedKeyCredential(account, key);
  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    credential,
  );
  _containerClient = service.getContainerClient(container);
  return _containerClient;
}

function safeSegment(value, fallback) {
  return String(value || fallback || "x").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Build the deterministic Azure path for a given session/capture moment.
 *
 *     interviews/<interview>/<candidate>/<session>/proctor/<timestamp>.jpg
 */
export function proctorFrameBlobPath(session, capturedAtIso) {
  const interview = safeSegment(session?.interview_id, "interview");
  const candidate = safeSegment(session?.candidate_id, "candidate");
  const sessionId = safeSegment(session?.session_id, "session");
  const stamp = String(capturedAtIso || new Date().toISOString()).replace(/[:.]/g, "-");
  return `interviews/${interview}/${candidate}/${sessionId}/proctor/${stamp}.jpg`;
}

/**
 * Pre-interview identity snapshot (candidate checklist / audit).
 *
 *     interviews/<interview>/<candidate>/<session>/precheck/<timestamp>.jpg
 */
export function precheckIdentityBlobPath(session, capturedAtIso) {
  const interview = safeSegment(session?.interview_id, "interview");
  const candidate = safeSegment(session?.candidate_id, "candidate");
  const sessionId = safeSegment(session?.session_id, "session");
  const stamp = String(capturedAtIso || new Date().toISOString()).replace(/[:.]/g, "-");
  return `interviews/${interview}/${candidate}/${sessionId}/precheck/${stamp}.jpg`;
}

/**
 * Upload a proctor frame buffer to Azure Blob Storage.
 *
 * Metadata keys/values are sanitized to Azure's allowed alphabet/length so
 * arbitrary client payloads can never reject an upload.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer
 * @param {string} params.blobPath
 * @param {string} [params.contentType]
 * @param {Record<string, unknown>} [params.metadata]
 * @returns {Promise<{container: string, blobPath: string, url: string, sizeBytes: number}>}
 */
export async function uploadProctorFrame({
  buffer,
  blobPath,
  contentType = "image/jpeg",
  metadata = {},
}) {
  if (!buffer || !buffer.length) {
    throw new Error("Empty proctor frame buffer");
  }
  const container = getContainerClient();
  const blockBlob = container.getBlockBlobClient(blobPath);

  const sanitizedMeta = {};
  for (const [k, v] of Object.entries(metadata || {})) {
    if (v == null) continue;
    const key = String(k).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
    const val = String(v).slice(0, 256);
    if (key) sanitizedMeta[key] = val;
  }

  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: sanitizedMeta,
  });

  return {
    container: container.containerName,
    blobPath,
    url: blockBlob.url,
    sizeBytes: buffer.length,
  };
}
