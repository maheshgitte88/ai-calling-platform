import {
  AzureBlobUpload,
  EncodedFileOutput,
  EncodedFileType,
} from "livekit-server-sdk";
import { getEgressClient } from "./clients.js";

/**
 * RoomComposite egress recording → Azure Blob storage.
 *
 * Logging is intentionally verbose because failures (no egress worker, bad
 * Azure creds, room missing on the server) all surface as opaque "no
 * response from servers" Twirp errors.
 */

/**
 * @param {Object} params
 * @param {string} params.roomName
 * @param {string} params.filepath - Blob path in the Azure container.
 * @param {string} [params.layout] - LiveKit layout id, e.g. "grid".
 * @param {boolean} [params.audioOnly]
 * @param {string} params.azureAccountName
 * @param {string} params.azureAccountKey
 * @param {string} params.azureContainerName
 */
export async function startRoomCompositeRecording({
  roomName,
  filepath,
  layout = "grid",
  audioOnly = false,
  azureAccountName,
  azureAccountKey,
  azureContainerName,
}) {
  console.info(
    "[recording] startRoomCompositeRecording request",
    JSON.stringify({ roomName, filepath, layout, audioOnly, azureContainerName }),
  );

  const fileOutput = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath,
    output: {
      case: "azure",
      value: new AzureBlobUpload({
        accountName: azureAccountName,
        accountKey: azureAccountKey,
        containerName: azureContainerName,
      }),
    },
  });

  try {
    const info = await getEgressClient().startRoomCompositeEgress(roomName, fileOutput, {
      layout,
      audioOnly: Boolean(audioOnly),
    });
    console.info(
      "[recording] startRoomCompositeRecording success",
      JSON.stringify({ roomName, egressId: info?.egressId, status: info?.status }),
    );
    return info;
  } catch (err) {
    console.error(
      "[recording] startRoomCompositeRecording failed",
      JSON.stringify({ roomName, message: err?.message || String(err) }),
    );
    throw err;
  }
}

/**
 * Stop a previously-started egress. No-op when `egressId` is empty.
 *
 * @param {string} egressId
 */
export async function stopRecordingEgress(egressId) {
  if (!egressId) return null;
  console.info("[recording] stopRecordingEgress request", JSON.stringify({ egressId }));
  try {
    const info = await getEgressClient().stopEgress(egressId);
    console.info(
      "[recording] stopRecordingEgress success",
      JSON.stringify({ egressId, status: info?.status }),
    );
    return info;
  } catch (err) {
    console.error(
      "[recording] stopRecordingEgress failed",
      JSON.stringify({ egressId, message: err?.message || String(err) }),
    );
    throw err;
  }
}
