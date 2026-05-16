import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const filePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/pages/InterviewPrecheck.jsx",
);
const lines = fs.readFileSync(filePath, "utf8").split("\n");

const iLink = lines.findIndex((l) => l.includes("{meta?.linkExpiresAt && ("));
const iFooter = lines.findIndex((l) => l.includes("style={pStyles.footerBar}"));
if (iLink < 0 || iFooter < 0) {
  console.error("markers", { iLink, iFooter });
  process.exit(1);
}

const camInner = lines.slice(991, 1021);
const identityInner = lines.slice(1030, 1084);
const screenInner = lines.slice(1092, 1107);
const audioInner = lines.slice(1115, 1149);
const instructionsInner = lines.slice(961, 983);

const TAG = "d" + "iv";
const o = (cls) => `<${TAG} style={${cls}}>`;

const block = [
  `          ${o("pStyles.mainGrid")}`,
  `          <${TAG} style={pStyles.row2} data-ij-precheck-row2>`,
  `            ${o("pStyles.panel")}`,
  `            <${TAG} style={pStyles.sectionLabel}>Camera and microphone</${TAG}>`,
  `            <p style={pStyles.panelHint}>Allow camera and microphone for this video interview.</p>`,
  ...camInner,
  `            </${TAG}>`,
  `            ${o("pStyles.panel")}`,
  `            <${TAG} style={pStyles.sectionLabel}>Identity snapshot</${TAG}>`,
  `            <p style={pStyles.panelHint}>Capture a clear photo of your face for session verification.</p>`,
  ...identityInner,
  `            </${TAG}>`,
  `          </${TAG}>`,
  `          <${TAG} style={pStyles.row2} data-ij-precheck-row2>`,
  `            ${o("pStyles.panel")}`,
  `            <${TAG} style={pStyles.sectionLabel}>Screen monitoring</${TAG}>`,
  `            <p style={pStyles.panelHint}>Share your entire screen or window (not only this tab).</p>`,
  ...screenInner,
  `            </${TAG}>`,
  `            ${o("pStyles.panel")}`,
  `            <${TAG} style={pStyles.sectionLabel}>Microphone audio test</${TAG}>`,
  `            <p style={pStyles.panelHint}>Record yourself saying the phrase below.</p>`,
  ...audioInner,
  `            </${TAG}>`,
  `          </${TAG}>`,
  `          ${o("pStyles.instructionsPanel")}`,
  `            <${TAG} style={pStyles.sectionLabel}>Instructions</${TAG}>`,
  `            ${o("pStyles.instructionsScroll")}`,
  ...instructionsInner,
  `            </${TAG}>`,
  `          </${TAG}>`,
  `          </${TAG}>`,
  "",
];

const out = [...lines.slice(0, iLink), ...block, ...lines.slice(iFooter)];
fs.writeFileSync(filePath, out.join("\n"));
console.log("patched", filePath, "lines", out.length);
