import {
  FaceLandmarker,
  FilesetResolver,
  ImageSegmenter,
} from "@mediapipe/tasks-vision";

const TASKS_VERSION = "0.10.35";
const LOCAL_WASM_PATH = "/mediapipe/wasm";
const CDN_WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const LOCAL_FACE_MODEL = "/mediapipe/face_landmarker.task";
const CDN_FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const LOCAL_SEGMENTER_MODEL = "/mediapipe/selfie_segmenter.tflite";
const CDN_SEGMENTER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let enginePromise = null;
let imageEnginePromise = null;

const LEFT_EYE_OUTER = 33;
const LEFT_EYE_INNER = 133;
const RIGHT_EYE_INNER = 362;
const RIGHT_EYE_OUTER = 263;
const LEFT_UPPER_EYELID = 159;
const LEFT_LOWER_EYELID = 145;
const RIGHT_UPPER_EYELID = 386;
const RIGHT_LOWER_EYELID = 374;
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;
const NOSE_TIP = 1;
const CHIN = 152;

/** Face pose limits (~20% relaxed vs original). */
const FACE_YAW_MAX = 22;
const FACE_PITCH_UP_MAX = 14;
const FACE_PITCH_DOWN_MAX = 18;
const FACE_ROLL_MAX = 22;
const FACE_FALLBACK_YAW_MAX = 26;
const FACE_FALLBACK_PITCH_UP = 50;
const FACE_FALLBACK_PITCH_DOWN = 94;

const EYE_HORIZONTAL_CENTER_BAND = 0.16;
const EYE_VERTICAL_UP_BAND = 0.32;
const EYE_VERTICAL_DOWN_BAND = 0.26;
const EYE_ADAPTIVE_MIN_SAMPLES = 12;
const EYE_ADAPTIVE_K_HORIZONTAL = 3.0;
const EYE_ADAPTIVE_K_VERTICAL = 3.2;
const EYE_ADAPTIVE_BAND_MIN = 0.12;
const EYE_ADAPTIVE_BAND_MAX = 0.34;
const EYE_LID_SPAN_MIN = 0.0055;
const EYE_CALIBRATION_MAX_SAMPLES = 200;
/** Eye toast / flag: gaze away from center for this long (matches 3×1s ticks in UI). */
const EYE_WARNING_SUSTAINED_MS = 3000;
/** Reading pattern: off-center time in this window must exceed threshold. */
const READING_PATTERN_WINDOW_MS = 20_000;
const READING_PATTERN_OFFSCREEN_MS = 9_000;
const EYE_STATS_WINDOW_MS = 60_000;

async function resourceExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "force-cache" });
    return res.ok;
  } catch {
    return false;
  }
}

async function chooseAsset(localUrl, fallbackUrl) {
  return (await resourceExists(localUrl)) ? localUrl : fallbackUrl;
}

async function createEngine() {
  const originalInfo = console.info;
  console.info = (...args) => {
    const text = args.map((arg) => String(arg)).join(" ");
    if (text.includes("Created TensorFlow Lite XNNPACK delegate for CPU")) return;
    originalInfo.apply(console, args);
  };
  try {
  const wasmPath = (await resourceExists(`${LOCAL_WASM_PATH}/vision_wasm_internal.wasm`))
    ? LOCAL_WASM_PATH
    : CDN_WASM_PATH;
  const vision = await FilesetResolver.forVisionTasks(wasmPath);
  const faceModel = await chooseAsset(LOCAL_FACE_MODEL, CDN_FACE_MODEL);
  const segmenterModel = await chooseAsset(LOCAL_SEGMENTER_MODEL, CDN_SEGMENTER_MODEL);

  const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: faceModel },
    runningMode: "VIDEO",
    numFaces: 2,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });

  let imageSegmenter = null;
  try {
    imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: segmenterModel },
      runningMode: "VIDEO",
      outputCategoryMask: true,
    });
  } catch {
    imageSegmenter = null;
  }

  return { faceLandmarker, imageSegmenter, modelReady: true, wasmPath, faceModel, segmenterModel };
  } finally {
    console.info = originalInfo;
  }
}

async function createImageEngine() {
  const originalInfo = console.info;
  console.info = (...args) => {
    const text = args.map((arg) => String(arg)).join(" ");
    if (text.includes("Created TensorFlow Lite XNNPACK delegate for CPU")) return;
    originalInfo.apply(console, args);
  };
  try {
  const wasmPath = (await resourceExists(`${LOCAL_WASM_PATH}/vision_wasm_internal.wasm`))
    ? LOCAL_WASM_PATH
    : CDN_WASM_PATH;
  const vision = await FilesetResolver.forVisionTasks(wasmPath);
  const faceModel = await chooseAsset(LOCAL_FACE_MODEL, CDN_FACE_MODEL);
  const segmenterModel = await chooseAsset(LOCAL_SEGMENTER_MODEL, CDN_SEGMENTER_MODEL);
  const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: faceModel },
    runningMode: "IMAGE",
    numFaces: 2,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  let imageSegmenter = null;
  try {
    imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: segmenterModel },
      runningMode: "IMAGE",
      outputCategoryMask: true,
    });
  } catch {
    imageSegmenter = null;
  }
  return { faceLandmarker, imageSegmenter, modelReady: true, wasmPath, faceModel, segmenterModel };
  } finally {
    console.info = originalInfo;
  }
}

export async function getProctorEngine() {
  if (!enginePromise) {
    enginePromise = createEngine().catch((err) => ({
      modelReady: false,
      error: err?.message || String(err),
      faceLandmarker: null,
      imageSegmenter: null,
    }));
  }
  return enginePromise;
}

async function getImageProctorEngine() {
  if (!imageEnginePromise) {
    imageEnginePromise = createImageEngine().catch((err) => ({
      modelReady: false,
      error: err?.message || String(err),
      faceLandmarker: null,
      imageSegmenter: null,
    }));
  }
  return imageEnginePromise;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function meanBrightnessFromVideo(videoEl, sampleSize = 80) {
  const canvas = document.createElement("canvas");
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const ctx = canvas.getContext("2d");
  if (!ctx || !videoEl?.videoWidth || !videoEl?.videoHeight) {
    return { brightnessMean: null, brightnessVariance: null, lightingOk: null };
  }
  ctx.drawImage(videoEl, 0, 0, sampleSize, sampleSize);
  const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
  let sum = 0;
  let sumSq = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return {
    brightnessMean: Math.round(mean),
    brightnessVariance: Math.round(variance),
    lightingOk: mean >= 60 && mean <= 220 && variance >= 80,
  };
}

function meanBrightnessFromCanvasSource(source, sampleSize = 80) {
  const canvas = document.createElement("canvas");
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const ctx = canvas.getContext("2d");
  if (!ctx || !source?.width || !source?.height) {
    return { brightnessMean: null, brightnessVariance: null, lightingOk: null };
  }
  ctx.drawImage(source, 0, 0, sampleSize, sampleSize);
  const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
  let sum = 0;
  let sumSq = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return {
    brightnessMean: Math.round(mean),
    brightnessVariance: Math.round(variance),
    lightingOk: mean >= 60 && mean <= 220 && variance >= 80,
  };
}

function safeLandmark(landmarks, index) {
  const p = landmarks?.[index];
  if (!p) return null;
  return { x: Number(p.x), y: Number(p.y), z: Number(p.z || 0) };
}

function averagePoint(points) {
  const valid = points.filter(Boolean);
  if (!valid.length) return null;
  return {
    x: valid.reduce((sum, p) => sum + p.x, 0) / valid.length,
    y: valid.reduce((sum, p) => sum + p.y, 0) / valid.length,
    z: valid.reduce((sum, p) => sum + p.z, 0) / valid.length,
  };
}

function safeRatio(numerator, denominator, fallback = 0) {
  return Math.abs(denominator) < 1e-9 ? fallback : numerator / denominator;
}

function eulerFromTransformMatrix(matrix4x4) {
  const data = matrix4x4?.data || matrix4x4;
  if (!data || data.length < 16) return null;
  const r02 = Number(data[2]);
  const r10 = Number(data[4]);
  const r11 = Number(data[5]);
  const r12 = Number(data[6]);
  const r22 = Number(data[10]);
  const pitch = Math.asin(clamp(-r12, -1, 1));
  const yaw = Math.atan2(r02, r22);
  const roll = Math.atan2(r10, r11);
  return {
    yaw: Math.round((yaw * 180) / Math.PI),
    pitch: Math.round((pitch * 180) / Math.PI),
    roll: Math.round((roll * 180) / Math.PI),
  };
}

function irisMetrics(marks) {
  const leftOuter = safeLandmark(marks, LEFT_EYE_OUTER);
  const leftInner = safeLandmark(marks, LEFT_EYE_INNER);
  const leftIris = safeLandmark(marks, LEFT_IRIS_CENTER);
  const rightInner = safeLandmark(marks, RIGHT_EYE_INNER);
  const rightOuter = safeLandmark(marks, RIGHT_EYE_OUTER);
  const rightIris = safeLandmark(marks, RIGHT_IRIS_CENTER);
  if (!leftOuter || !leftInner || !leftIris || !rightInner || !rightOuter || !rightIris) return null;

  const leftX = safeRatio(leftIris.x - leftOuter.x, Math.max(Math.abs(leftInner.x - leftOuter.x), 1e-6), 0.5);
  const rightX = safeRatio(rightIris.x - rightInner.x, Math.max(Math.abs(rightOuter.x - rightInner.x), 1e-6), 0.5);
  const xNorm = (leftX + rightX) / 2;

  const eyeCenterY = (leftOuter.y + leftInner.y + rightOuter.y + rightInner.y) / 4;
  const leftUpper = safeLandmark(marks, LEFT_UPPER_EYELID);
  const leftLower = safeLandmark(marks, LEFT_LOWER_EYELID);
  const rightUpper = safeLandmark(marks, RIGHT_UPPER_EYELID);
  const rightLower = safeLandmark(marks, RIGHT_LOWER_EYELID);
  if (!leftUpper || !leftLower || !rightUpper || !rightLower) return null;
  const lidSpan = (Math.abs(leftLower.y - leftUpper.y) + Math.abs(rightLower.y - rightUpper.y)) / 2;
  const yNorm = safeRatio(((leftIris.y + rightIris.y) / 2) - eyeCenterY, Math.max(lidSpan, 1e-6), 0);
  return { xNorm, yNorm, lidSpan };
}

function classifyEyeDirection(metrics, calibration) {
  if (!metrics || metrics.lidSpan < EYE_LID_SPAN_MIN) return "unknown";
  const hasCalibration = calibration?.sampleCount >= EYE_ADAPTIVE_MIN_SAMPLES;
  const centerX = hasCalibration ? calibration.xMean : 0.5;
  const centerY = hasCalibration ? calibration.yMean : 0;
  const horizontalBand = hasCalibration
    ? clamp(EYE_ADAPTIVE_K_HORIZONTAL * Math.max(calibration.xStd, 0.018), EYE_ADAPTIVE_BAND_MIN, EYE_ADAPTIVE_BAND_MAX)
    : EYE_HORIZONTAL_CENTER_BAND;
  const verticalBand = hasCalibration
    ? clamp(EYE_ADAPTIVE_K_VERTICAL * Math.max(calibration.yStd, 0.025), EYE_ADAPTIVE_BAND_MIN, EYE_ADAPTIVE_BAND_MAX)
    : EYE_VERTICAL_DOWN_BAND;

  if (metrics.xNorm < centerX - horizontalBand) return "left";
  if (metrics.xNorm > centerX + horizontalBand) return "right";
  if (metrics.yNorm < centerY - Math.max(verticalBand, EYE_VERTICAL_UP_BAND)) return "up";
  if (metrics.yNorm > centerY + Math.max(verticalBand, EYE_VERTICAL_DOWN_BAND)) return "down";
  return "center";
}

function faceSignals(faceLandmarks, transformMatrix = null, calibration = null) {
  if (!faceLandmarks?.length) {
    return {
      facePresent: false,
      faceCount: 0,
      faceOrientation: "unknown",
      frontalOk: false,
      headYaw: null,
      headPitch: null,
      headRoll: null,
      eyeDirection: "unknown",
    };
  }

  const marks = faceLandmarks[0];
  const leftEye = averagePoint([safeLandmark(marks, LEFT_EYE_OUTER), safeLandmark(marks, LEFT_EYE_INNER)]);
  const rightEye = averagePoint([safeLandmark(marks, RIGHT_EYE_INNER), safeLandmark(marks, RIGHT_EYE_OUTER)]);
  const nose = safeLandmark(marks, NOSE_TIP) || safeLandmark(marks, 4);
  const chin = safeLandmark(marks, CHIN);
  const mouth = averagePoint([safeLandmark(marks, 13), safeLandmark(marks, 14)]);
  const eyeCenter = averagePoint([leftEye, rightEye]);
  const eyeDx = Math.max(0.001, Math.abs((rightEye?.x || 0) - (leftEye?.x || 0)));
  const eyeDy = (rightEye?.y || 0) - (leftEye?.y || 0);
  const fallbackRoll = Math.round((Math.atan2(eyeDy, eyeDx) * 180) / Math.PI);
  const fallbackYaw = nose && eyeCenter ? Math.round(((nose.x - eyeCenter.x) / eyeDx) * 100) : null;
  const fallbackPitch =
    nose && eyeCenter && chin ? Math.round(((nose.y - eyeCenter.y) / Math.max(0.001, chin.y - eyeCenter.y)) * 100) : null;
  const euler = eulerFromTransformMatrix(transformMatrix);
  const headYaw = euler?.yaw ?? fallbackYaw;
  const headPitch = euler?.pitch ?? fallbackPitch;
  const headRoll = euler?.roll ?? fallbackRoll;

  let faceOrientation = "frontal";
  if (euler) {
    if (headYaw <= -FACE_YAW_MAX) faceOrientation = "left";
    else if (headYaw >= FACE_YAW_MAX) faceOrientation = "right";
    else if (headPitch <= -FACE_PITCH_UP_MAX) faceOrientation = "up";
    else if (headPitch >= FACE_PITCH_DOWN_MAX) faceOrientation = "down";
  } else if (headYaw != null && headYaw > FACE_FALLBACK_YAW_MAX) faceOrientation = "right";
  else if (headYaw != null && headYaw < -FACE_FALLBACK_YAW_MAX) faceOrientation = "left";
  else if (headPitch != null && headPitch < FACE_FALLBACK_PITCH_UP) faceOrientation = "up";
  else if (headPitch != null && headPitch > FACE_FALLBACK_PITCH_DOWN) faceOrientation = "down";
  else if (Math.abs(headRoll) > FACE_ROLL_MAX) faceOrientation = "tilted";

  const frontalOk = faceOrientation === "frontal" && Math.abs(headRoll || 0) <= FACE_ROLL_MAX;
  const metrics = irisMetrics(marks);
  const eyeDirection = frontalOk ? classifyEyeDirection(metrics, calibration) : "head_not_frontal";
  return {
    facePresent: true,
    faceCount: faceLandmarks.length,
    faceOrientation,
    frontalOk,
    headYaw,
    headPitch,
    headRoll,
    eyeDirection,
    eyeReliable: Boolean(metrics && metrics.lidSpan >= EYE_LID_SPAN_MIN),
    irisXNorm: metrics ? Math.round(metrics.xNorm * 1000) / 1000 : null,
    irisYNorm: metrics ? Math.round(metrics.yNorm * 1000) / 1000 : null,
  };
}

function backgroundSignals(segmenterResult) {
  const mask = segmenterResult?.categoryMask;
  if (!mask?.getAsUint8Array) {
    return { backgroundCleanScore: null, backgroundPersonRatio: null };
  }
  try {
    const data = mask.getAsUint8Array();
    if (!data?.length) return { backgroundCleanScore: null, backgroundPersonRatio: null };
    let person = 0;
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] > 0) person += 1;
    }
    const ratio = person / data.length;
    return {
      backgroundPersonRatio: Math.round(ratio * 1000) / 1000,
      backgroundCleanScore: Math.round(clamp(1 - Math.abs(0.42 - ratio), 0, 1) * 100),
    };
  } catch {
    return { backgroundCleanScore: null, backgroundPersonRatio: null };
  }
}

export async function analyzeProctorFrame(videoEl, options = {}) {
  const lighting = meanBrightnessFromVideo(videoEl);
  const engine = await getProctorEngine();
  if (!engine.modelReady || !videoEl?.videoWidth || !videoEl?.videoHeight) {
    return {
      proctorModelReady: false,
      proctorModelError: engine.error || null,
      ...lighting,
      facePresent: null,
      faceCount: null,
      faceOrientation: "unknown",
      frontalOk: null,
      eyeDirection: "unknown",
      backgroundCleanScore: null,
      backgroundPersonRatio: null,
    };
  }

  const ts = performance.now();
  let faceResult = null;
  let segmenterResult = null;
  try {
    faceResult = engine.faceLandmarker.detectForVideo(videoEl, ts);
  } catch {
    faceResult = null;
  }
  try {
    segmenterResult = engine.imageSegmenter?.segmentForVideo?.(videoEl, ts);
  } catch {
    segmenterResult = null;
  }

  return {
    proctorModelReady: true,
    ...lighting,
    ...faceSignals(
      faceResult?.faceLandmarks || [],
      faceResult?.facialTransformationMatrixes?.[0] || null,
      options.calibration || null,
    ),
    ...backgroundSignals(segmenterResult),
  };
}

export async function analyzeIdentityImageBlob(blob) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return {
      proctorModelReady: false,
      proctorModelError: "Could not decode captured image.",
      facePresent: false,
      frontalOk: false,
      lightingOk: false,
    };
  }
  const lighting = meanBrightnessFromCanvasSource(bitmap);
  const engine = await getImageProctorEngine();
  if (!engine.modelReady) {
    return {
      proctorModelReady: false,
      proctorModelError: engine.error || null,
      ...lighting,
      facePresent: null,
      frontalOk: null,
      faceOrientation: "unknown",
    };
  }
  let faceResult = null;
  let segmenterResult = null;
  try {
    faceResult = engine.faceLandmarker.detect(bitmap);
  } catch {
    faceResult = null;
  }
  try {
    segmenterResult = engine.imageSegmenter?.segment?.(bitmap);
  } catch {
    segmenterResult = null;
  }
  const result = {
    proctorModelReady: true,
    ...lighting,
    ...faceSignals(
      faceResult?.faceLandmarks || [],
      faceResult?.facialTransformationMatrixes?.[0] || null,
    ),
    ...backgroundSignals(segmenterResult),
  };
  bitmap.close?.();
  return result;
}

function readingPatternScoreFrom(offscreenMs, movementCount, sustainedMs) {
  return clamp(
    Math.round((offscreenMs / 1000) * 2.2 + movementCount * 2.5 + Math.max(0, sustainedMs - 2000) / 120),
    0,
    100,
  );
}

function pruneEyeTicks(ticks, now, windowMs = EYE_STATS_WINDOW_MS) {
  const cutoff = now - windowMs;
  while (ticks.length && ticks[0].at < cutoff) {
    ticks.shift();
  }
}

function sumOffscreenMsInWindow(ticks, now, windowMs) {
  const cutoff = now - windowMs;
  let offscreenMs = 0;
  for (const tick of ticks) {
    if (tick.at >= cutoff && tick.offCenter) offscreenMs += tick.delta;
  }
  return offscreenMs;
}

function readingPatternStats(ticks, now) {
  const offscreenMs = sumOffscreenMsInWindow(ticks, now, READING_PATTERN_WINDOW_MS);
  return {
    readingPatternOffscreenSecondsWindow: Math.round(offscreenMs / 1000),
    readingPatternWarning: offscreenMs > READING_PATTERN_OFFSCREEN_MS,
  };
}

function windowEyeStats(ticks, now) {
  pruneEyeTicks(ticks, now, EYE_STATS_WINDOW_MS);
  let offscreenMs = 0;
  let movementCount = 0;
  for (const tick of ticks) {
    offscreenMs += tick.offCenter ? tick.delta : 0;
    if (tick.dirChanged) movementCount += 1;
  }
  const readingPatternScoreWindow = readingPatternScoreFrom(offscreenMs, movementCount, 0);
  return {
    readingPatternScoreWindow,
    offscreenEyeSecondsWindow: Math.round(offscreenMs / 1000),
    eyeMovementCountWindow: movementCount,
  };
}

export function createProctorAccumulator() {
  let lastTs = Date.now();
  let notFrontalMs = 0;
  let missingFaceMs = 0;
  let eyeMovementCount = 0;
  let offscreenEyeMs = 0;
  let lastEyeDirection = "";
  let currentEyeDirection = "";
  let currentEyeStartedAt = Date.now();
  let centerXMean = 0.5;
  let centerYMean = 0;
  let xM2 = 0;
  let yM2 = 0;
  let centerSamples = 0;
  let lastSample = {};
  const eyeTicks = [];

  const calibration = () => ({
    xMean: centerXMean,
    yMean: centerYMean,
    xStd: centerSamples > 1 ? Math.sqrt(xM2 / (centerSamples - 1)) : 0,
    yStd: centerSamples > 1 ? Math.sqrt(yM2 / (centerSamples - 1)) : 0,
    sampleCount: centerSamples,
  });

  const updateCenterStats = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (centerSamples >= EYE_CALIBRATION_MAX_SAMPLES) return;
    centerSamples += 1;
    const dx = x - centerXMean;
    centerXMean += dx / centerSamples;
    xM2 += dx * (x - centerXMean);
    const dy = y - centerYMean;
    centerYMean += dy / centerSamples;
    yM2 += dy * (y - centerYMean);
  };

  return {
    calibration,
    add(sample) {
      const now = Date.now();
      const delta = Math.min(5000, Math.max(0, now - lastTs));
      lastTs = now;
      lastSample = sample || {};
      if (sample?.frontalOk === false) notFrontalMs += delta;
      if (sample?.facePresent === false) missingFaceMs += delta;

      let dirChanged = false;
      const trackableEye =
        sample?.eyeDirection && !["unknown", "head_not_frontal"].includes(sample.eyeDirection);

      if (sample?.frontalOk === true && sample?.eyeDirection === "center") {
        updateCenterStats(Number(sample.irisXNorm), Number(sample.irisYNorm));
      }
      if (trackableEye && lastEyeDirection && sample.eyeDirection !== lastEyeDirection) {
        eyeMovementCount += 1;
        dirChanged = true;
      }
      if (trackableEye) {
        if (sample.eyeDirection !== currentEyeDirection) {
          currentEyeDirection = sample.eyeDirection;
          currentEyeStartedAt = now;
        }
        if (sample.eyeDirection !== "center") offscreenEyeMs += delta;
        lastEyeDirection = sample.eyeDirection;
      }

      eyeTicks.push({
        at: now,
        delta,
        offCenter: trackableEye && sample.eyeDirection !== "center",
        dirChanged,
        direction: trackableEye ? sample.eyeDirection : "",
        dirStartedAt: currentEyeStartedAt,
      });
      pruneEyeTicks(eyeTicks, now, EYE_STATS_WINDOW_MS);
    },
    summary() {
      const now = Date.now();
      const sustainedMs =
        currentEyeDirection && currentEyeDirection !== "center" ? now - currentEyeStartedAt : 0;
      const readingPatternScore = readingPatternScoreFrom(offscreenEyeMs, eyeMovementCount, sustainedMs);
      const windowStats = windowEyeStats(eyeTicks, now);
      const readingStats = readingPatternStats(eyeTicks, now);
      const eyeOffCenterLive =
        Boolean(currentEyeDirection) &&
        !["unknown", "head_not_frontal", "center"].includes(currentEyeDirection);
      return {
        ...lastSample,
        notFrontalSeconds: Math.round(notFrontalMs / 1000),
        missingFaceSeconds: Math.round(missingFaceMs / 1000),
        offscreenEyeSeconds: Math.round(offscreenEyeMs / 1000),
        eyeMovementCount,
        readingPatternScore,
        ...windowStats,
        ...readingStats,
        eyeSustainedDirection: currentEyeDirection || "center",
        eyeSustainedSeconds: Math.round(sustainedMs / 1000),
        /** Gaze away from center for ≥3s (same idea as face/frontal streak toasts). */
        eyeWarning: eyeOffCenterLive && sustainedMs >= EYE_WARNING_SUSTAINED_MS,
        eyeCalibrationSamples: centerSamples,
      };
    },
  };
}

export async function getNetworkSignals() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  let apiPingMs = null;
  try {
    const started = performance.now();
    await fetch("/api/interviews/sessions?limit=1", { method: "GET", cache: "no-store" });
    apiPingMs = Math.round(performance.now() - started);
  } catch {
    apiPingMs = null;
  }
  return {
    networkEffectiveType: conn?.effectiveType || null,
    networkDownlink: conn?.downlink ?? null,
    networkRtt: conn?.rtt ?? null,
    apiPingMs,
  };
}
