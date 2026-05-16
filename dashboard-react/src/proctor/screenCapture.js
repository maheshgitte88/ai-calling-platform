let screenStream = null;

export function getScreenCaptureStream() {
  return screenStream;
}

export function isScreenCaptureActive() {
  const track = screenStream?.getVideoTracks?.()[0];
  const displaySurface = track?.getSettings?.().displaySurface;
  return Boolean(
    screenStream?.active &&
      track?.readyState === "live" &&
      displaySurface !== "browser",
  );
}

export function getScreenCaptureInfo() {
  const track = screenStream?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.() || {};
  return {
    active: isScreenCaptureActive(),
    displaySurface: settings.displaySurface || null,
    label: track?.label || "",
  };
}

export async function requestScreenCapture() {
  if (isScreenCaptureActive()) return screenStream;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen capture is not supported in this browser.");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: "monitor",
      frameRate: { ideal: 2, max: 5 },
    },
    audio: false,
  });
  const track = stream.getVideoTracks?.()[0];
  const displaySurface = track?.getSettings?.().displaySurface;
  if (displaySurface === "browser") {
    stream.getTracks?.().forEach((t) => t.stop());
    throw new Error("Please share your entire screen or browser window, not only this interview tab.");
  }
  screenStream = stream;
  return stream;
}

export function stopScreenCapture() {
  screenStream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  });
  screenStream = null;
}

export async function captureStreamFrame(stream, options = {}) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || track.readyState !== "live") return null;

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);

  await new Promise((resolve) => {
    const done = () => resolve();
    video.onloadedmetadata = done;
    video.oncanplay = done;
    const p = video.play();
    if (p?.catch) p.catch(() => resolve());
    setTimeout(resolve, options.timeoutMs || 1500);
  });

  const width = video.videoWidth || track.getSettings?.().width || 1280;
  const height = video.videoHeight || track.getSettings?.().height || 720;
  if (!width || !height) return null;

  const targetW = Math.min(options.maxWidth || 1280, width);
  const targetH = Math.max(1, Math.round((height / width) * targetW));
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, targetW, targetH);

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", options.quality ?? 0.72);
  });
  if (!blob) return null;
  return { blob, width: targetW, height: targetH };
}
