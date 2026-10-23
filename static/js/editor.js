const DOTS_PER_MM = 8;
const DRAFT_STORAGE_KEY = "label-studio-draft-v1";
const ORIGINAL_IMAGE_DB_NAME = "label-studio-original-images";
const ORIGINAL_IMAGE_STORE_NAME = "images";
const SVG_NS = "http://www.w3.org/2000/svg";
const STANDARD_PAPER_SIZES = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  B0: [1000, 1414],
  B1: [707, 1000],
  B2: [500, 707],
  B3: [353, 500],
  B4: [250, 353],
  B5: [176, 250],
};

const canvas = document.querySelector("#label-canvas");
const canvasWrap = document.querySelector("#canvas-wrap");
const canvasWorkspace = document.querySelector("#canvas-workspace");
const propertiesPanel = document.querySelector("#property-fields");
const emptyInspector = document.querySelector("#empty-inspector");
const layerList = document.querySelector("#layer-list");
const toast = document.querySelector("#toast");
const qrCache = new Map();
const qrRequests = new Map();
const imageSourceCache = new Map();
const stickerEmbeddingRequests = new WeakMap();
const STICKERS = [
  { file: "price-tag.svg", label: "Sale tag sticker" },
  { file: "shopping-cart.svg", label: "Shopping cart sticker" },
  { file: "shopping-bags.svg", label: "Shopping bags sticker" },
  { file: "apple.svg", label: "Apple sticker" },
  { file: "herb.svg", label: "Herb sticker" },
  { file: "gift.svg", label: "Gift sticker" },
  { file: "basket.svg", label: "Basket sticker" },
  { file: "hot.svg", label: "Hot item sticker" },
  { file: "sale.svg", label: "Sale sticker" },
  { file: "discount-50.svg", label: "50 percent off sticker" },
  { file: "new.svg", label: "New arrival sticker" },
  { file: "best-seller.svg", label: "Best seller sticker" },
  { file: "clearance.svg", label: "Clearance sticker" },
];
const FONT_AWESOME_ICONS = [
  { className: "fa-barcode", codepoint: "f02a", label: "FA barcode" },
  { className: "fa-tag", codepoint: "f02b", label: "FA price tag" },
  { className: "fa-qrcode", codepoint: "f029", label: "FA QR code" },
  { className: "fa-mug-hot", codepoint: "f7b6", label: "FA coffee" },
  { className: "fa-truck-fast", codepoint: "f48b", label: "FA delivery truck" },
  { className: "fa-image", codepoint: "f03e", label: "FA image" },
];
const SHAPES = [
  { type: "rect", label: "Rectangle", preview: "□" },
  { type: "ellipse", label: "Circle", preview: "○" },
  { type: "line", label: "Line", preview: "—" },
  { type: "star", label: "Star", preview: "★" },
  { type: "quote", label: "Quote", preview: "❝" },
  { type: "arrow-up", label: "Arrow up", preview: "↑" },
  { type: "arrow-down", label: "Arrow down", preview: "↓" },
  { type: "arrow-left", label: "Arrow left", preview: "←" },
  { type: "arrow-right", label: "Arrow right", preview: "→" },
];
const SHAPE_TYPES = new Set(SHAPES.map(({ type }) => type));
const FRAME_STYLES = [
  { style: "classic", label: "Frame classic" },
  { style: "double", label: "Frame double" },
  { style: "corners", label: "Frame corners" },
  { style: "dashed", label: "Frame dashed" },
];

let printerConfig = null;
let selectedId = null;
let zoom = 1;
let dragState = null;
let elementResizeState = null;
let elementRotateState = null;
let saveTimer = null;
let toastTimer = null;
let currentTab = "properties";
let resizeState = null;
let overflowingElementIds = [];
let saveStatusKey = "New design";
let draftAutoSaveEnabled = false;
let printerStatusKey = "Connecting";
let printerPortKey = "Reading port...";
let printerPortText = "";
let printerStatusRequestPending = false;
let state = {
  widthMm: 50,
  heightMm: 30,
  gapMm: 2,
  safeMarginMm: 2,
  dynamicCsv: "",
  elements: [],
};
let dynamicRows = [];
let dynamicHeaders = [];
let dynamicCsvError = "";
let previewRowIndex = 0;
let batchPrinting = false;
let templateCatalog = [];
let userTemplates = [];
let userTemplatesLoadError = false;
let fingerprintUserIdPromise = null;
let batchPreviewScrollHandler = null;
let batchPreviewGeneration = 0;
let originalImageDatabasePromise = null;

function makeId() {
  return `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function escapeXml(value) {
  return escapeHtml(value);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function selectedElement() {
  return state.elements.find((element) => element.id === selectedId) ?? null;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function updatePrinterStatus(key) {
  printerStatusKey = key;
  const status = document.querySelector("#printer-status");
  status.textContent = translate(key);
  status.classList.toggle("offline", key === "Printer offline" || key === "Missing printer config" || key === "Printer status unknown");
  status.classList.toggle("not-ready", key === "Printer not ready");
  status.classList.toggle("connected", key === "Printer connected");
  status.classList.toggle("checking", key === "Checking printer" || key === "Connecting");
  document.querySelector("#printer-ready").hidden = key !== "Ready";
}

async function refreshPrinterStatus() {
  if (!printerConfig || printerStatusRequestPending || batchPrinting) return;
  printerStatusRequestPending = true;
  try {
    const response = await fetch("/api/printer-status", { cache: "no-store" });
    if (!response.ok) throw new Error(`Printer status check failed (${response.status}).`);
    const result = await response.json();
    const statusKeys = {
      ready: "Ready",
      connected: "Printer connected",
      offline: "Printer offline",
      "not-ready": "Printer not ready",
      unconfigured: "Missing printer config",
      unknown: "Printer status unknown",
    };
    updatePrinterStatus(statusKeys[result.state] ?? "Printer status unknown");
  } catch (error) {
    console.error("Printer status check failed:", error);
    updatePrinterStatus("Printer status unknown");
  } finally {
    printerStatusRequestPending = false;
  }
}

function scheduleSave() {
  saveStatusKey = "Unsaved changes";
  document.querySelector("#save-state").textContent = translate(saveStatusKey);
  if (!draftAutoSaveEnabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistDraft(true), 350);
}

function persistDraft(isAutomatic = false) {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(state));
    saveStatusKey = isAutomatic ? "Draft autosaved" : "Draft saved";
    document.querySelector("#save-state").textContent = translate(saveStatusKey);
    if (!isAutomatic) showToast(translate("Draft saved"));
  } catch (error) {
    console.error("Draft save failed:", error);
    showToast(translate("Cannot save draft"), true);
  }
}

function saveDraft() {
  clearTimeout(saveTimer);
  draftAutoSaveEnabled = true;
  persistDraft();
}

function validDesign(candidate) {
  return candidate
    && Number.isFinite(Number(candidate.widthMm))
    && Number(candidate.widthMm) > 0
    && Number.isFinite(Number(candidate.heightMm))
    && Number(candidate.heightMm) > 0
    && (
      candidate.safeMarginMm === undefined
      || (
        Number.isFinite(Number(candidate.safeMarginMm))
        && Number(candidate.safeMarginMm) >= 0
        && Number(candidate.safeMarginMm) * 2 < Math.min(Number(candidate.widthMm), Number(candidate.heightMm))
      )
    )
    && Array.isArray(candidate.elements)
    && candidate.elements.every((item) => item && typeof item.id === "string" && typeof item.type === "string");
}

function restoreDesign() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "null");
    if (!validDesign(saved)) return false;
    if (isLegacyStarterDesign(saved)) {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      return false;
    }
    state = { ...state, ...saved };
    draftAutoSaveEnabled = true;
    return true;
  } catch {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    return false;
  }
}

function isLegacyStarterDesign(design) {
  if (design.elements.length !== 5 || design.dynamicCsv) return false;
  const texts = new Set(design.elements
    .filter((item) => item.type === "text")
    .map((item) => item.text));
  return texts.has("CA PHE RANG XAY")
    && texts.has("GOI 250 g")
    && texts.has("89.000 d")
    && design.elements.some((item) => (
      item.type === "qr" && item.data === "SAMPLE|CA PHE RANG XAY|250g|89000 VND"
    ))
    && design.elements.some((item) => item.type === "barcode" && item.data === "8938505974194");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        cell += character;
      }
    } else if (afterQuote && character === ",") {
      row.push(cell);
      cell = "";
      afterQuote = false;
    } else if (afterQuote && (character === "\n" || character === "\r")) {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      afterQuote = false;
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else if (afterQuote && /\s/.test(character)) {
      continue;
    } else if (afterQuote) {
      throw new Error(translate("CSV invalid quote"));
    } else if (character === '"') {
      if (cell.length) throw new Error(translate("CSV invalid quote"));
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error(translate("CSV unterminated quote"));
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error(translate("CSV invalid headers"));
  }
  const records = rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(translate("CSV row width error", { row: index + 2, expected: headers.length, actual: values.length }));
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
  return { headers, records };
}

function dynamicColumns() {
  const columns = new Set();
  for (const item of state.elements) {
    for (const key of ["text", "data", "src"]) {
      for (const match of String(item[key] ?? "").matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
        columns.add(match[1].trim());
      }
    }
  }
  return columns;
}

function refreshDynamicRows({ syncInput = false } = {}) {
  if (syncInput) document.querySelector("#dynamic-csv").value = state.dynamicCsv ?? "";
  dynamicRows = [];
  dynamicHeaders = [];
  dynamicCsvError = "";
  try {
    const parsed = parseCsv(state.dynamicCsv ?? "");
    dynamicHeaders = parsed.headers;
    dynamicRows = parsed.records;
    const missing = [...dynamicColumns()].filter((column) => !dynamicHeaders.includes(column));
    if (dynamicRows.length && missing.length) {
      dynamicCsvError = translate("CSV missing columns", { columns: missing.join(", ") });
    }
  } catch (error) {
    dynamicCsvError = error.message;
  }
  previewRowIndex = Math.min(previewRowIndex, Math.max(0, dynamicRows.length - 1));
  const preview = document.querySelector("#dynamic-preview");
  preview.replaceChildren();
  dynamicRows.forEach((record, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1}${dynamicHeaders.length ? ` · ${record[dynamicHeaders[0]]}` : ""}`;
    preview.append(option);
  });
  preview.disabled = !dynamicRows.length || Boolean(dynamicCsvError) || batchPrinting;
  preview.value = String(previewRowIndex);
  const status = document.querySelector("#dynamic-status");
  status.classList.toggle("error", Boolean(dynamicCsvError));
  status.textContent = dynamicCsvError || (dynamicRows.length
    ? translate("CSV row count", { rows: dynamicRows.length, columns: dynamicHeaders.length })
    : translate("CSV empty hint"));
  const hasDynamicTemplate = dynamicColumns().size > 0;
  document.querySelector("#print-label").disabled = batchPrinting
    || Boolean(dynamicCsvError)
    || (hasDynamicTemplate && !dynamicRows.length);
  document.querySelector("#preview-all-labels").disabled =
    !dynamicRows.length || Boolean(dynamicCsvError) || batchPrinting;
  document.querySelector("#print-batch").disabled = !dynamicRows.length || Boolean(dynamicCsvError) || batchPrinting;
  document.querySelector("#print-batch-paper").disabled = !dynamicRows.length || Boolean(dynamicCsvError) || batchPrinting;
  updatePaperLayoutSummary();
}

function activeDynamicRecord() {
  return dynamicRows[previewRowIndex] ?? null;
}

function resolveDynamicValue(value, record) {
  return String(value ?? "").replace(/{{\s*([^{}]+?)\s*}}/g, (placeholder, column) => (
    record && Object.hasOwn(record, column.trim()) ? record[column.trim()] : placeholder
  ));
}

function renderedElements(record = activeDynamicRecord(), design = state) {
  return design.elements.map((item) => {
    const rendered = { ...item };
    for (const key of ["text", "data", "src"]) {
      if (typeof item[key] === "string") rendered[key] = resolveDynamicValue(item[key], record);
    }
    if (item.type === "qr") {
      rendered.qrSource = qrCache.get(rendered.data)
        ?? (rendered.data === item.data ? item.qrSource : null);
    }
    return rendered;
  });
}

function updateCanvasSize() {
  const width = number(state.widthMm, 50);
  const height = number(state.heightMm, 30);
  canvas.setAttribute("viewBox", `0 0 ${width} ${height}`);
  canvas.setAttribute("width", String(width * DOTS_PER_MM));
  canvas.setAttribute("height", String(height * DOTS_PER_MM));
  canvas.style.width = `${width * DOTS_PER_MM * zoom}px`;
  canvas.style.height = `${height * DOTS_PER_MM * zoom}px`;
  canvasWrap.style.width = `${width * DOTS_PER_MM * zoom}px`;
  canvasWrap.style.height = `${height * DOTS_PER_MM * zoom}px`;
  document.querySelector("#canvas-size-label").textContent = `${width} × ${height} mm`;
  document.querySelector("#canvas-resolution").textContent =
    `${Math.round(DOTS_PER_MM * 25.4)} DPI · ${translate("Custom label")}`;
}

function ean13CheckDigit(firstTwelve) {
  const sum = [...firstTwelve].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return String((10 - (sum % 10)) % 10);
}

function ean13Svg(item) {
  let value = String(item.data ?? "").replace(/\s/g, "");
  if (/^\d{12}$/.test(value)) value += ean13CheckDigit(value);
  if (!/^\d{13}$/.test(value) || ean13CheckDigit(value.slice(0, 12)) !== value[12]) {
    throw new Error(translate("Barcode EAN-13 invalid"));
  }

  const left = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  const groupG = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
  const right = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
  const parity = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
  let modules = "101";
  for (let index = 0; index < 6; index += 1) {
    const digit = Number(value[index + 1]);
    modules += (parity[Number(value[0])][index] === "L" ? left : groupG)[digit];
  }
  modules += "01010";
  for (const digit of value.slice(7)) modules += right[Number(digit)];
  modules += "101";

  const quiet = 7;
  const total = modules.length + quiet * 2;
  const moduleWidth = item.w / total;
  const barHeight = item.h * 0.74;
  let bars = "";
  for (let index = 0; index < modules.length; index += 1) {
    if (modules[index] === "1") {
      const guard = index < 3 || (index >= 45 && index < 50) || index >= 92;
      const height = barHeight + (guard ? item.h * 0.1 : 0);
      bars += `<rect x="${(quiet + index) * moduleWidth}" y="0" width="${moduleWidth}" height="${height}" fill="#000"/>`;
    }
  }
  return `<rect width="${item.w}" height="${item.h}" fill="#fff"/>${bars}<text x="${item.w / 2}" y="${item.h * 0.98}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${Math.min(item.h * 0.2, 1.15)}" fill="#000">${value}</text>`;
}

function textSvg(item) {
  const lines = String(item.text ?? "").split(/\r?\n/);
  const anchor = item.align === "center" ? "middle" : item.align === "right" ? "end" : "start";
  const x = item.align === "center" ? item.w / 2 : item.align === "right" ? item.w : 0;
  const fontSize = number(item.fontSize, 2.5);
  const weight = item.bold ? 700 : 400;
  const baselineOffset = item.fitVertical ? 1.05 : 0.86;
  const lineHeight = fontSize;
  const textHeight = lines.length * lineHeight;
  const verticalOffset = item.verticalAlign === "middle"
    ? (item.h - textHeight) / 2
    : item.verticalAlign === "bottom" ? item.h - textHeight : 0;
  return lines.map((line, index) => `<text x="${x}" y="${verticalOffset + fontSize * (index + baselineOffset)}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${escapeXml(item.fill ?? "#111111")}">${escapeXml(line)}</text>`).join("");
}

function fitTextFontToHeight(item) {
  const lineCount = String(item.text ?? "").split(/\r?\n/).length;
  item.fontSize = Math.min(25, item.h / (lineCount + .3));
  item.fitVertical = true;
}

function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    let line = "";
    for (const token of paragraph.match(/\s+|\S+/gu) ?? []) {
      if (/^\s+$/u.test(token)) {
        if (line && measure(line + token) <= maxWidth) line += token;
        continue;
      }
      if (measure(line + token) <= maxWidth) {
        line += token;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      for (const character of Array.from(token)) {
        if (line && measure(line + character) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function fitTextSvg(item) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return "";
  const weight = item.bold ? 700 : 400;
  const lineHeight = 1.2;
  const layoutAt = (fontSize) => {
    context.font = `${weight} ${fontSize * DOTS_PER_MM}px Arial,sans-serif`;
    const inset = Math.min(item.w / 4, fontSize * 0.15);
    const maxWidth = Math.max(0.01, item.w - inset * 2);
    const lines = wrapText(
      item.text,
      maxWidth,
      (text) => context.measureText(text).width / DOTS_PER_MM,
    );
    return { lines, inset };
  };
  let low = 0.01;
  let high = Math.max(0.01, item.h / lineHeight);
  let best = { fontSize: low, ...layoutAt(low) };
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const fontSize = (low + high) / 2;
    const layout = layoutAt(fontSize);
    const { lines } = layout;
    if (lines.length * fontSize * lineHeight <= item.h) {
      best = { fontSize, ...layout };
      low = fontSize;
    } else {
      high = fontSize;
    }
  }
  const { fontSize, lines, inset } = best;
  const anchor = item.align === "center" ? "middle" : item.align === "right" ? "end" : "start";
  const x = item.align === "center" ? item.w / 2 : item.align === "right" ? item.w - inset : inset;
  const textHeight = lines.length * fontSize * lineHeight;
  const verticalOffset = item.verticalAlign === "top"
    ? 0
    : item.verticalAlign === "bottom" ? item.h - textHeight : (item.h - textHeight) / 2;
  const firstBaseline = verticalOffset + fontSize * 0.9;
  return lines.map((line, index) => (
    `<text x="${x}" y="${firstBaseline + index * fontSize * lineHeight}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${escapeXml(item.fill ?? "#111111")}">${escapeXml(line)}</text>`
  )).join("");
}

function shapeSvg(item, width, height) {
  const fill = escapeXml(item.fill ?? "#ffffff");
  const stroke = escapeXml(item.stroke ?? "#111111");
  const strokeWidth = number(item.strokeWidth, .3);
  if (item.type === "rect") {
    return `<rect x="0" y="0" width="${width}" height="${height}" rx="${number(item.radius, 0)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  if (item.type === "ellipse") {
    return `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  }
  if (item.type === "line") {
    return `<line x1="0" y1="0" x2="${width}" y2="${height}" stroke="${stroke}" stroke-width="${number(item.strokeWidth, .3)}"/>`;
  }
  if (item.type === "star") {
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2;
    const points = Array.from({ length: 10 }, (_, index) => {
      const pointRadius = index % 2 === 0 ? radius : radius * .43;
      const angle = -Math.PI / 2 + (index * Math.PI) / 5;
      return `${centerX + Math.cos(angle) * pointRadius},${centerY + Math.sin(angle) * pointRadius}`;
    }).join(" ");
    return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
  }
  if (item.type === "quote") {
    return `<svg x="0" y="0" width="${width}" height="${height}" viewBox="0 0 48 24" preserveAspectRatio="none"><path d="M2 2h18v8h-8l8 12H2zM27 2h18v8h-8l8 12H27z" fill="${fill}" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  }
  const arrowPoints = {
    "arrow-up": "10,1 19,10 14,10 14,19 6,19 6,10 1,10",
    "arrow-down": "6,1 14,1 14,10 19,10 10,19 1,10 6,10",
    "arrow-left": "1,10 10,1 10,6 19,6 19,14 10,14 10,19",
    "arrow-right": "1,6 10,6 10,1 19,10 10,19 10,14 1,14",
  }[item.type];
  if (arrowPoints) {
    return `<svg x="0" y="0" width="${width}" height="${height}" viewBox="0 0 20 20" preserveAspectRatio="none"><polygon points="${arrowPoints}" fill="${fill}" stroke="${stroke}" stroke-width=".7" stroke-linejoin="round"/></svg>`;
  }
  return "";
}

function frameSvg(item, width, height) {
  const stroke = escapeXml(item.stroke ?? "#176c50");
  const strokeWidth = Math.min(Math.max(0.1, number(item.strokeWidth, .45)), Math.min(width, height) / 4);
  const inset = strokeWidth / 2;
  const frameWidth = Math.max(0, width - strokeWidth);
  const frameHeight = Math.max(0, height - strokeWidth);
  const radius = Math.min(
    Math.max(0, number(item.radius, 2)),
    frameWidth / 2,
    frameHeight / 2,
  );
  const style = FRAME_STYLES.some(({ style: candidate }) => candidate === item.frameStyle)
    ? item.frameStyle
    : "classic";
  if (style === "corners") {
    const arm = Math.min(4, frameWidth * .18, frameHeight * .18);
    const left = inset;
    const top = inset;
    const right = width - inset;
    const bottom = height - inset;
    return `<path d="M${left} ${top + arm}V${top}H${left + arm} M${right - arm} ${top}H${right}V${top + arm} M${left} ${bottom - arm}V${bottom}H${left + arm} M${right - arm} ${bottom}H${right}V${bottom - arm}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const dash = style === "dashed" ? ` stroke-dasharray="${Math.max(1, strokeWidth * 3)} ${Math.max(1, strokeWidth * 2)}"` : "";
  const outer = `<rect x="${inset}" y="${inset}" width="${frameWidth}" height="${frameHeight}" rx="${radius}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dash}/>`;
  if (style !== "double") return outer;
  const secondInset = Math.min(strokeWidth * 2.4, Math.min(width, height) * .12);
  const innerStroke = Math.max(.1, strokeWidth * .65);
  const innerWidth = Math.max(0, width - secondInset * 2 - innerStroke);
  const innerHeight = Math.max(0, height - secondInset * 2 - innerStroke);
  const innerRadius = Math.min(Math.max(0, radius - secondInset), innerWidth / 2, innerHeight / 2);
  return `${outer}<rect x="${secondInset + innerStroke / 2}" y="${secondInset + innerStroke / 2}" width="${innerWidth}" height="${innerHeight}" rx="${innerRadius}" fill="none" stroke="${stroke}" stroke-width="${innerStroke}"/>`;
}

function elementSvg(item) {
  const width = Math.max(0.2, number(item.w, 1));
  const height = Math.max(0.2, number(item.h, 1));
  let content = "";
  if (item.type === "text") {
    content = textSvg({ ...item, w: width, h: height });
  } else if (item.type === "fitText") {
    content = `<svg x="0" y="0" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">${fitTextSvg({ ...item, w: width, h: height })}</svg>`;
  } else if (item.type === "qr") {
    const source = item.qrSource;
    content = source
      ? `<rect width="${width}" height="${height}" fill="#fff"/><image href="${source}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" image-rendering="pixelated"/>`
      : `<rect width="${width}" height="${height}" fill="#fff" stroke="#d9e1dc" stroke-dasharray=".6 .5"/><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="1.1" fill="#76817a">QR</text>`;
  } else if (item.type === "barcode") {
    try {
      content = ean13Svg({ ...item, w: width, h: height });
      item.barcodeError = "";
    } catch (error) {
      item.barcodeError = error.message;
      content = `<rect width="${width}" height="${height}" fill="#fff" stroke="#d98e89" stroke-dasharray=".6 .5"/><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="1" fill="#9b4843">EAN-13</text>`;
    }
  } else if (item.type === "frame") {
    content = frameSvg(item, width, height);
  } else if (SHAPE_TYPES.has(item.type)) {
    content = shapeSvg(item, width, height);
  } else if (item.type === "fontAwesome") {
    const icon = FONT_AWESOME_ICONS.find(({ className }) => className === item.iconName) ?? FONT_AWESOME_ICONS[0];
    const glyph = String.fromCodePoint(Number.parseInt(icon.codepoint, 16));
    const size = Math.min(width, height) * .85;
    content = `<style>@font-face{font-family:LabelFontAwesome;src:url('/static/fonts/fa-solid-900.woff2') format('woff2');font-weight:900}</style><text x="${width / 2}" y="${height / 2 + size * .35}" text-anchor="middle" font-family="LabelFontAwesome" font-weight="900" font-size="${size}" fill="${escapeXml(item.fill ?? "#111111")}">${glyph}</text>`;
  } else if (item.type === "image" && item.src) {
    content = `<image href="${escapeXml(item.src)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  let selection = "";
  if (!window.exporting && item.id === selectedId) {
    selection = `<rect class="selection-outline" x="-.45" y="-.45" width="${width + .9}" height="${height + .9}" fill="none" stroke="#21835b" stroke-width=".3" stroke-dasharray="1 .6" pointer-events="none"/>`;
    const handles = [
      { kind: "n", x: width / 2, y: 0, title: "Resize element height" },
      { kind: "ne", x: width, y: 0, title: "Resize element both" },
      { kind: "e", x: width, y: height / 2, title: "Resize element width" },
      { kind: "se", x: width, y: height, title: "Resize element both" },
      { kind: "s", x: width / 2, y: height, title: "Resize element height" },
      { kind: "sw", x: 0, y: height, title: "Resize element both" },
      { kind: "w", x: 0, y: height / 2, title: "Resize element width" },
      { kind: "nw", x: 0, y: 0, title: "Resize element both" },
    ];
    selection += handles.map(({ kind, x, y, title }) => (
      `<g class="element-resize-handle" data-element-resize="${kind}"><title>${translate(title)}</title><circle cx="${x}" cy="${y}" r="1.5" fill="transparent"/><circle cx="${x}" cy="${y}" r=".65" fill="#21835b" stroke="#fff" stroke-width=".25" pointer-events="none"/></g>`
    )).join("");
    selection += `<g class="element-rotate-handle" data-element-rotate="true"><title>${translate("Rotate element")}</title><line x1="${width / 2}" y1="-.45" x2="${width / 2}" y2="-2" stroke="#21835b" stroke-width=".25" pointer-events="none"/><circle cx="${width / 2}" cy="-3.1" r="1.45" fill="#fff" stroke="#21835b" stroke-width=".35" pointer-events="none"/><path d="M${width / 2 - .62} -3.15a.65.65 0 1 1 .9.58m-.03-.54.04.62-.58-.18" fill="none" stroke="#21835b" stroke-width=".2" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/><circle cx="${width / 2}" cy="-3.1" r="2" fill="transparent"/></g>`;
  }
  const hitArea = `<rect width="${width}" height="${height}" fill="transparent" pointer-events="all"/>`;
  const rotation = number(item.rotation, 0);
  return `<g data-id="${escapeXml(item.id)}" transform="translate(${number(item.x)},${number(item.y)}) rotate(${rotation} ${width / 2} ${height / 2})" class="canvas-element">${hitArea}${content}${selection}</g>`;
}

function svgMarkup(record = activeDynamicRecord(), design = state) {
  window.exporting = true;
  const markup = `<svg xmlns="${SVG_NS}" width="${design.widthMm * DOTS_PER_MM}" height="${design.heightMm * DOTS_PER_MM}" viewBox="0 0 ${design.widthMm} ${design.heightMm}"><rect width="${design.widthMm}" height="${design.heightMm}" fill="#ffffff"/>${renderedElements(record, design).map(elementSvg).join("")}</svg>`;
  window.exporting = false;
  return markup;
}

function renderCanvas({ refreshInspector = true, refreshQr = true } = {}) {
  state.elements.filter((item) => item.type === "frame").forEach(constrainFrameToSafeArea);
  updateCanvasSize();
  overflowingElementIds = state.elements
    .filter((item) => (
      item.x < state.safeMarginMm
      || item.y < state.safeMarginMm
      || item.x + item.w > state.widthMm - state.safeMarginMm
      || item.y + item.h > state.heightMm - state.safeMarginMm
    ))
    .map((item) => item.id);
  const inset = state.safeMarginMm;
  const safeArea = `<rect class="safe-area-guide" x="${inset}" y="${inset}" width="${Math.max(0, state.widthMm - inset * 2)}" height="${Math.max(0, state.heightMm - inset * 2)}" fill="none" stroke="${overflowingElementIds.length ? "#d3544e" : "#27865f"}" stroke-width=".25" stroke-dasharray="1.2 .8" pointer-events="none"/>`;
  canvas.innerHTML = `<rect class="label-background" x="0" y="0" width="${state.widthMm}" height="${state.heightMm}" fill="#fff"/>${renderedElements().map(elementSvg).join("")}${safeArea}`;
  canvas.setAttribute("xmlns", SVG_NS);
  state.elements.forEach(inlineStickerSource);
  const safeAreaStatus = document.querySelector("#safe-area-status");
  safeAreaStatus.textContent = overflowingElementIds.length
    ? translate("Safe area overflow", { count: overflowingElementIds.length })
    : translate("Safe area ok");
  safeAreaStatus.classList.toggle("overflow", overflowingElementIds.length > 0);
  if (refreshInspector) renderProperties();
  renderLayers();
  if (refreshQr) requestQrImages();
}

function requestQrImages() {
  for (const item of renderedElements()) {
    if (item.type !== "qr" || !item.data || /{{\s*[^{}]+?\s*}}/.test(item.data)) continue;
    requestQrImage(item.data)
      .then(() => {
        if (state.elements.some((element) => element.id === item.id)) {
          renderCanvas({ refreshQr: false });
        }
      })
      .catch((error) => {
        console.error("QR generation failed:", error);
        showToast(translate("Cannot read QR"), true);
      });
  }
}

function requestQrImage(value) {
  if (qrCache.has(value)) return Promise.resolve(qrCache.get(value));
  if (qrRequests.has(value)) return qrRequests.get(value);
  const request = fetch("/api/qr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) {
      console.error("QR API error:", result.error);
      throw new Error(translate("Cannot read QR"));
    }
    if (typeof result.dataUrl !== "string") throw new Error(translate("Cannot read QR"));
    qrCache.set(value, result.dataUrl);
    return result.dataUrl;
  }).finally(() => qrRequests.delete(value));
  qrRequests.set(value, request);
  return request;
}

function displayName(item) {
  if (item.type === "text" || item.type === "fitText") return item.text || translate(item.type === "fitText" ? "Fit text" : "Text");
  if (item.type === "qr") return translate("QR code");
  if (item.type === "barcode") return translate("EAN-13 barcode");
  if (item.type === "image") return translate("Image");
  if (item.type === "fontAwesome") {
    const icon = FONT_AWESOME_ICONS.find(({ className }) => className === item.iconName);
    return translate(icon?.label ?? "Font Awesome");
  }
  if (item.type === "frame") {
    const frame = FRAME_STYLES.find(({ style }) => style === item.frameStyle);
    return translate(frame?.label ?? "Frame classic");
  }
  const shape = SHAPES.find(({ type }) => type === item.type);
  if (shape) return translate(shape.label);
  return item.type === "rect"
    ? translate("Rectangle")
    : item.type === "ellipse" ? translate("Circle") : translate("Line");
}

function elementIcon(type) {
  return {
    text: "fa-font",
    fitText: "fa-text-width",
    qr: "fa-qrcode",
    barcode: "fa-barcode",
    rect: "fa-square",
    ellipse: "fa-circle",
    line: "fa-grip-lines",
    image: "fa-image",
    fontAwesome: "fa-icons",
    star: "fa-star",
    quote: "fa-quote-left",
    "arrow-up": "fa-arrow-up",
    "arrow-down": "fa-arrow-down",
    "arrow-left": "fa-arrow-left",
    "arrow-right": "fa-arrow-right",
    frame: "fa-border-all",
  }[type] ?? "fa-square";
}

function field(label, key, value, options = {}) {
  const id = `prop-${key}`;
  const translatedLabel = translate(label);
  const type = options.type ?? "number";
  if (type === "textarea") {
    return `<div class="field-row single"><label class="field-label" for="${id}">${translatedLabel}</label><textarea class="field-input" id="${id}" data-prop="${key}" rows="3">${escapeHtml(value ?? "")}</textarea></div>`;
  }
  if (type === "select") {
    const choices = options.choices.map(([choice, title]) => `<option value="${choice}" ${String(value) === choice ? "selected" : ""}>${title}</option>`).join("");
    return `<div class="field-row single"><label class="field-label" for="${id}">${translatedLabel}</label><select class="field-select" id="${id}" data-prop="${key}">${choices}</select></div>`;
  }
  if (type === "color") {
    return `<div class="field-row single"><label class="field-label" for="${id}">${translatedLabel}</label><input class="field-color" id="${id}" type="color" data-prop="${key}" value="${escapeHtml(value || "#111111")}"></div>`;
  }
  if (type === "checkbox") {
    return `<div class="field-row single"><label class="check-field"><input type="checkbox" data-prop="${key}" ${value ? "checked" : ""}>${translatedLabel}</label></div>`;
  }
  const inputType = options.type === "text" ? "text" : "number";
  const min = options.min !== undefined ? `min="${options.min}"` : "";
  const max = options.max !== undefined ? `max="${options.max}"` : "";
  const step = options.step ?? "0.1";
  return `<div class="field-row single"><label class="field-label" for="${id}">${translatedLabel}</label><input class="field-input" id="${id}" data-prop="${key}" type="${inputType}" ${inputType === "number" ? `step="${step}" ${min} ${max}` : ""} value="${escapeHtml(value ?? "")}"></div>`;
}

function renderProperties() {
  const item = selectedElement();
  emptyInspector.hidden = Boolean(item);
  propertiesPanel.hidden = !item;
  if (!item) return;

  let content = `<div class="selected-title"><span class="selected-type-icon"><i class="fa-solid ${elementIcon(item.type)}" aria-hidden="true"></i></span><div><strong>${escapeHtml(displayName(item).slice(0, 25))}</strong><span>${item.type.toUpperCase()} · ${Math.round(item.x * 10) / 10}, ${Math.round(item.y * 10) / 10} mm</span></div></div>`;
  content += `<div class="property-group"><p class="property-group-title">${translate("Position and size")}</p><div class="field-row">${field("X", "x", item.x)}${field("Y", "y", item.y)}</div><div class="field-row">${field("Width", "w", item.w, { min: .2 })}${field("Height", "h", item.h, { min: .2 })}</div>${field("Rotation", "rotation", number(item.rotation, 0), { min: -360, max: 360, step: 1 })}<p class="hint">${translate("Resize modifier hint")}</p><div class="align-actions"><button class="small-action" data-align="center-x">${translate("Align center horizontally")}</button><button class="small-action" data-align="center-y">${translate("Align center vertically")}</button></div></div>`;
  if (item.type === "text" || item.type === "fitText") {
    const fontSizeField = item.type === "text"
      ? `<div class="field-row">${field("Font size", "fontSize", item.fontSize, { min: .4, max: 25 })}${field("Text color", "fill", item.fill, { type: "color" })}</div>`
      : `<div class="field-row">${field("Text color", "fill", item.fill, { type: "color" })}</div><p class="hint">${translate("Fit text hint")}</p>`;
    const verticalAlign = item.verticalAlign ?? (item.type === "fitText" ? "middle" : "top");
    content += `<div class="property-group"><p class="property-group-title">${translate("Typography")}</p>${field("Content", "text", item.text, { type: "textarea" })}${fontSizeField}${field("Horizontal alignment", "align", item.align ?? "left", { type: "select", choices: [["left", translate("Left")], ["center", translate("Center")], ["right", translate("Right")]] })}${field("Vertical alignment", "verticalAlign", verticalAlign, { type: "select", choices: [["top", translate("Top")], ["middle", translate("Middle")], ["bottom", translate("Bottom")]] })}${field("Bold", "bold", item.bold, { type: "checkbox" })}</div>`;
  } else if (item.type === "qr") {
    content += `<div class="property-group"><p class="property-group-title">${translate("QR content")}</p>${field("Content", "data", item.data, { type: "textarea" })}<p class="hint">${translate("QR quiet zone hint")}</p></div>`;
  } else if (item.type === "barcode") {
    content += `<div class="property-group"><p class="property-group-title">${translate("EAN-13 barcode")}</p>${field("12 or 13 digits", "data", item.data, { type: "text" })}<p class="hint">${translate("Barcode hint")}</p>${item.barcodeError ? `<p class="hint" style="color:#a54843">${escapeHtml(item.barcodeError)}</p>` : ""}</div>`;
  } else if (SHAPE_TYPES.has(item.type) && item.type !== "line") {
    content += `<div class="property-group"><p class="property-group-title">${translate("Colors")}</p>${field("Fill color", "fill", item.fill, { type: "color" })}${field("Stroke color", "stroke", item.stroke, { type: "color" })}${field("Stroke width", "strokeWidth", item.strokeWidth, { min: 0, max: 5 })}</div>`;
  } else if (item.type === "frame") {
    const frameChoices = FRAME_STYLES.map(({ style, label }) => [style, translate(label)]);
    content += `<div class="property-group"><p class="property-group-title">${translate("Colors")}</p>${field("Frame style", "frameStyle", item.frameStyle, { type: "select", choices: frameChoices })}<div class="field-row">${field("Stroke color", "stroke", item.stroke, { type: "color" })}${field("Stroke width", "strokeWidth", item.strokeWidth, { min: .1, max: 3 })}</div>${field("Corner radius", "radius", item.radius, { min: 0, max: Math.min(item.w, item.h) / 2 })}</div>`;
  } else if (item.type === "line") {
    content += `<div class="property-group"><p class="property-group-title">${translate("Stroke")}</p>${field("Stroke color", "stroke", item.stroke, { type: "color" })}${field("Stroke width mm", "strokeWidth", item.strokeWidth, { min: .1, max: 5 })}</div>`;
  } else if (item.type === "fontAwesome") {
    const iconChoices = FONT_AWESOME_ICONS.map(({ className, label }) => [className, translate(label)]);
    content += `<div class="property-group"><p class="property-group-title">${translate("Colors")}</p>${field("Icon", "iconName", item.iconName, { type: "select", choices: iconChoices })}${field("Fill color", "fill", item.fill, { type: "color" })}</div>`;
  } else if (item.type === "image") {
    content += `<div class="property-group"><p class="property-group-title">${translate("Image source")}</p>${field("Content", "src", item.src, { type: "textarea" })}<p class="hint">${translate("Image source hint")}</p><button class="small-action" data-edit-image="${item.id}" type="button"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${translate("Edit image")}</button></div>`;
  }
  content += `<div class="property-group"><button class="small-action" data-delete="${item.id}" style="width:100%;color:#a74d47">${translate("Delete element")}</button></div>`;
  propertiesPanel.innerHTML = content;
}

function renderLayers() {
  document.querySelector("#layer-count").textContent = String(state.elements.length);
  layerList.innerHTML = [...state.elements].reverse().map((item) => {
    const index = state.elements.findIndex((element) => element.id === item.id);
    return `<div class="layer-item ${item.id === selectedId ? "selected" : ""}" data-layer="${item.id}"><span class="layer-symbol"><i class="fa-solid ${elementIcon(item.type)}" aria-hidden="true"></i></span><span class="layer-name">${escapeHtml(displayName(item))}</span><span class="layer-order"><button data-order="${index}" data-direction="1" title="${translate("Move layer up")}"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button data-order="${index}" data-direction="-1" title="${translate("Move layer down")}"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button></span></div>`;
  }).join("");
}

function addElement(type, extras = {}) {
  const templates = {
    text: { name: translate("Text"), x: 3, y: 4, w: 23, h: 5, text: translate("Enter text"), fontSize: 2.8, fill: "#111111", bold: true, align: "left", verticalAlign: "top" },
    fitText: { name: translate("Fit text"), x: 3, y: 4, w: 26, h: 10, text: translate("Enter text"), fill: "#111111", bold: false, align: "left", verticalAlign: "middle" },
    qr: { name: translate("QR code"), x: Math.max(1, state.widthMm - 17), y: 2, w: 15, h: 15, data: "https://example.com" },
    barcode: { name: translate("EAN-13 barcode"), x: 2, y: Math.max(1, state.heightMm - 9), w: Math.min(32, state.widthMm - 4), h: 7, data: "8938505974194" },
    rect: { name: translate("Rectangle"), x: 3, y: 3, w: 15, h: 10, fill: "#ffffff", stroke: "#111111", strokeWidth: .3, radius: 0 },
    ellipse: { name: translate("Circle"), x: 3, y: 3, w: 12, h: 12, fill: "#ffffff", stroke: "#111111", strokeWidth: .3 },
    line: { name: translate("Line"), x: 2, y: 5, w: 20, h: .2, stroke: "#111111", strokeWidth: .3 },
    star: { name: translate("Star"), x: 3, y: 3, w: 12, h: 12, fill: "#ffffff", stroke: "#111111", strokeWidth: .3 },
    quote: { name: translate("Quote"), x: 3, y: 3, w: 20, h: 10, fill: "#ffffff", stroke: "#111111", strokeWidth: .3 },
    "arrow-up": { name: translate("Arrow up"), x: 3, y: 3, w: 12, h: 12, fill: "#111111", stroke: "#111111", strokeWidth: .3 },
    "arrow-down": { name: translate("Arrow down"), x: 3, y: 3, w: 12, h: 12, fill: "#111111", stroke: "#111111", strokeWidth: .3 },
    "arrow-left": { name: translate("Arrow left"), x: 3, y: 3, w: 12, h: 12, fill: "#111111", stroke: "#111111", strokeWidth: .3 },
    "arrow-right": { name: translate("Arrow right"), x: 3, y: 3, w: 12, h: 12, fill: "#111111", stroke: "#111111", strokeWidth: .3 },
    fontAwesome: { name: translate("Font Awesome"), x: 3, y: 3, w: 9, h: 9, iconName: "fa-tag", fill: "#111111" },
    image: { name: translate("Image"), x: 2, y: 2, w: 20, h: 15, src: "" },
  };
  const item = { id: makeId(), type, rotation: 0, ...templates[type], ...extras };
  state.elements.push(item);
  selectedId = item.id;
  refreshDynamicRows();
  renderCanvas();
  scheduleSave();
}

function renderStickerPicker() {
  const list = document.querySelector("#sticker-picker-list");
  list.replaceChildren();
  for (const sticker of STICKERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset-picker-option";
    button.dataset.sticker = sticker.file;
    const image = document.createElement("img");
    image.src = `/static/stickers/${sticker.file}`;
    image.alt = translate(sticker.label);
    image.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = translate(sticker.label);
    button.append(image, label);
    list.append(button);
  }
}

function renderFontAwesomePicker() {
  const list = document.querySelector("#fa-picker-list");
  list.replaceChildren();
  for (const icon of FONT_AWESOME_ICONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset-picker-option fa-picker-option";
    button.dataset.iconName = icon.className;
    const preview = document.createElement("i");
    preview.className = `fa-solid ${icon.className}`;
    preview.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = translate(icon.label);
    button.append(preview, label);
    list.append(button);
  }
}

function renderShapePicker() {
  const list = document.querySelector("#shape-picker-list");
  list.replaceChildren();
  for (const shape of SHAPES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset-picker-option shape-picker-option";
    button.dataset.shapeType = shape.type;
    const preview = document.createElement("span");
    preview.className = "shape-picker-preview";
    preview.setAttribute("aria-hidden", "true");
    preview.textContent = shape.preview;
    const label = document.createElement("span");
    label.textContent = translate(shape.label);
    button.append(preview, label);
    list.append(button);
  }
}

function renderFramePicker() {
  const list = document.querySelector("#frame-picker-list");
  list.replaceChildren();
  for (const frame of FRAME_STYLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset-picker-option frame-picker-option";
    button.dataset.frameStyle = frame.style;
    const preview = document.createElement("span");
    preview.className = `frame-picker-preview frame-preview-${frame.style}`;
    preview.setAttribute("aria-hidden", "true");
    let drawing = '<rect x="3" y="3" width="36" height="22" rx="4"/>';
    if (frame.style === "double") {
      drawing = '<rect x="3" y="3" width="36" height="22" rx="3"/><rect x="6" y="6" width="30" height="16" rx="2"/>';
    } else if (frame.style === "corners") {
      drawing = '<path d="M3 10V3h8 M31 3h8v7 M3 18v7h8 M31 25h8v-7"/>';
    } else if (frame.style === "dashed") {
      drawing = '<rect x="3" y="3" width="36" height="22" rx="3" stroke-dasharray="3 2"/>';
    }
    preview.innerHTML = `<svg viewBox="0 0 42 28" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${drawing}</svg>`;
    const label = document.createElement("span");
    label.textContent = translate(frame.label);
    button.append(preview, label);
    list.append(button);
  }
}

function addFrame(frameStyle) {
  const inset = Math.min(
    Math.max(0, state.safeMarginMm),
    Math.max(0, Math.min(state.widthMm, state.heightMm) / 2 - .1),
  );
  addElement("frame", {
    x: inset,
    y: inset,
    w: Math.max(.2, state.widthMm - inset * 2),
    h: Math.max(.2, state.heightMm - inset * 2),
    frameStyle,
    radius: 2,
    stroke: "#176c50",
    strokeWidth: .45,
  });
}

function showAssetPicker(dialogId, render) {
  render();
  document.querySelector(`#${dialogId}`).showModal();
}

function constrainFrameToSafeArea(item) {
  const inset = Math.min(
    Math.max(0, number(state.safeMarginMm, 0)),
    Math.max(0, Math.min(state.widthMm, state.heightMm) / 2 - .1),
  );
  const availableWidth = Math.max(.2, state.widthMm - inset * 2);
  const availableHeight = Math.max(.2, state.heightMm - inset * 2);
  item.w = Math.min(availableWidth, Math.max(.2, number(item.w, availableWidth)));
  item.h = Math.min(availableHeight, Math.max(.2, number(item.h, availableHeight)));
  item.x = Math.max(inset, Math.min(state.widthMm - inset - item.w, number(item.x, inset)));
  item.y = Math.max(inset, Math.min(state.heightMm - inset - item.h, number(item.y, inset)));
}

function updateProperty(target, renderInspector = false) {
  const item = selectedElement();
  if (!item) return;
  const key = target.dataset.prop;
  if (!key) return;
  let value;
  if (target.type === "checkbox") value = target.checked;
  else if (target.type === "number") value = number(target.value, item[key]);
  else value = target.value;
  item[key] = value;
  if (item.type === "frame" && ["x", "y", "w", "h"].includes(key)) {
    constrainFrameToSafeArea(item);
  }
  if (item.type === "text" && item.fitVertical && (key === "text" || key === "bold")) {
    fitTextFontToHeight(item);
  }
  if (item.type === "text" && key === "fontSize") {
    delete item.fitVertical;
  }
  if (key === "data" && item.type === "qr") {
    item.qrSource = null;
    item.qrLoading = false;
  }
  if (["text", "data", "src"].includes(key)) refreshDynamicRows();
  renderCanvas({ refreshInspector: renderInspector, refreshQr: key !== "data" || renderInspector });
  scheduleSave();
}

function syncDimensionInputs() {
  document.querySelector("#label-width").value = state.widthMm;
  document.querySelector("#label-height").value = state.heightMm;
  document.querySelector("#label-gap").value = state.gapMm;
  document.querySelector("#safe-inset").value = state.safeMarginMm;
  document.querySelector("#safe-inset").max =
    Math.max(0, Math.min(state.widthMm, state.heightMm) / 2 - .1).toFixed(1);
}

function applyDimensions() {
  const width = number(document.querySelector("#label-width").value, 0);
  const height = number(document.querySelector("#label-height").value, 0);
  const gap = number(document.querySelector("#label-gap").value, -1);
  const safeMargin = number(document.querySelector("#safe-inset").value, -1);
  if (
    width <= 0 || height <= 0 || gap < 0 || safeMargin < 0
    || width > 300 || height > 300 || gap > 30
    || safeMargin * 2 >= Math.min(width, height)
  ) {
    showToast(translate("Invalid dimensions"), true);
    syncDimensionInputs();
    return;
  }
  state.widthMm = width;
  state.heightMm = height;
  state.gapMm = gap;
  state.safeMarginMm = safeMargin;
  renderCanvas();
  scheduleSave();
}

function resizeLabel(event) {
  if (!resizeState) return;
  const deltaX = (event.clientX - resizeState.startX) / (DOTS_PER_MM * zoom);
  const deltaY = (event.clientY - resizeState.startY) / (DOTS_PER_MM * zoom);
  const width = resizeState.kind === "height"
    ? resizeState.width
    : resizeState.width + deltaX;
  const height = resizeState.kind === "width"
    ? resizeState.height
    : resizeState.height + deltaY;

  state.widthMm = Math.round(Math.min(300, Math.max(1, width)) * 10) / 10;
  state.heightMm = Math.round(Math.min(300, Math.max(1, height)) * 10) / 10;
  state.safeMarginMm = Math.min(
    state.safeMarginMm,
    Math.max(0, Math.min(state.widthMm, state.heightMm) / 2 - .1),
  );
  syncDimensionInputs();
  renderCanvas();
}

document.querySelectorAll("[data-resize]").forEach((handle) => {
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resizeState = {
      kind: handle.dataset.resize,
      startX: event.clientX,
      startY: event.clientY,
      width: state.widthMm,
      height: state.heightMm,
    };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", resizeLabel);
  handle.addEventListener("pointerup", () => {
    if (!resizeState) return;
    resizeState = null;
    scheduleSave();
  });
  handle.addEventListener("pointercancel", () => { resizeState = null; });
});

function chooseZoom(newZoom) {
  zoom = Math.min(2.5, Math.max(.25, newZoom));
  document.querySelector("#zoom-value").textContent = `${Math.round(zoom * 100)}%`;
  updateCanvasSize();
}

function fitCanvas() {
  const width = state.widthMm * DOTS_PER_MM;
  const height = state.heightMm * DOTS_PER_MM;
  const availableWidth = Math.max(100, canvasWorkspace.clientWidth - 100);
  const availableHeight = Math.max(100, canvasWorkspace.clientHeight - 120);
  chooseZoom(Math.min(1.7, availableWidth / width, availableHeight / height));
}

function addImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast(translate("Choose image"), true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = async () => {
      if (typeof reader.result !== "string") {
        showToast(translate("Cannot read image"), true);
        return;
      }
      const maxW = Math.min(24, state.widthMm - 4);
      const maxH = Math.min(18, state.heightMm - 4);
      const scale = Math.min(maxW / image.naturalWidth, maxH / image.naturalHeight, 1);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const targetScale = Math.min(
        (width * DOTS_PER_MM) / image.naturalWidth,
        (height * DOTS_PER_MM) / image.naturalHeight,
        1,
      );
      let source = reader.result;
      if (targetScale < 1) {
        const resizedCanvas = document.createElement("canvas");
        resizedCanvas.width = Math.max(1, Math.floor(image.naturalWidth * targetScale));
        resizedCanvas.height = Math.max(1, Math.floor(image.naturalHeight * targetScale));
        const context = resizedCanvas.getContext("2d");
        if (!context) {
          showToast(translate("Cannot read image"), true);
          return;
        }
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, resizedCanvas.width, resizedCanvas.height);
        try {
          const outputType = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
          source = resizedCanvas.toDataURL(outputType, outputType === "image/jpeg" ? .9 : undefined);
        } catch (error) {
          console.error("Image downsampling failed:", error);
          showToast(translate("Cannot read image"), true);
          return;
        }
      }
      const imageId = makeId();
      try {
        await storeOriginalImage(imageId, file);
      } catch (error) {
        console.error("Could not preserve original image for editing:", error);
        showToast(translate("Cannot preserve original image"), true);
        return;
      }
      addElement("image", {
        id: imageId,
        originalAssetId: imageId,
        name: file.name,
        x: Math.max(0, (state.widthMm - width) / 2),
        y: Math.max(0, (state.heightMm - height) / 2),
        w: width,
        h: height,
        src: source,
      });
      if (targetScale < 1) showToast(translate("Image optimized"));
    };
    image.onerror = () => showToast(translate("Cannot read image"), true);
    image.src = reader.result;
  };
  reader.onerror = () => showToast(translate("Cannot open image"), true);
  reader.readAsDataURL(file);
}

function openOriginalImageDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  }
  if (!originalImageDatabasePromise) {
    originalImageDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(ORIGINAL_IMAGE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(ORIGINAL_IMAGE_STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open image storage."));
      request.onblocked = () => reject(new Error("Image storage upgrade is blocked."));
    });
  }
  return originalImageDatabasePromise;
}

async function storeOriginalImage(assetId, imageBlob) {
  const database = await openOriginalImageDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(ORIGINAL_IMAGE_STORE_NAME, "readwrite");
    transaction.objectStore(ORIGINAL_IMAGE_STORE_NAME).put(imageBlob, assetId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not store original image."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Original image storage was aborted."));
  });
}

async function loadOriginalImage(assetId) {
  const database = await openOriginalImageDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(ORIGINAL_IMAGE_STORE_NAME, "readonly");
    const request = transaction.objectStore(ORIGINAL_IMAGE_STORE_NAME).get(assetId);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read original image."));
  });
}

async function deleteOriginalImage(assetId) {
  if (!assetId) return;
  const database = await openOriginalImageDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(ORIGINAL_IMAGE_STORE_NAME, "readwrite");
    transaction.objectStore(ORIGINAL_IMAGE_STORE_NAME).delete(assetId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete original image."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Original image deletion was aborted."));
  });
}

const imageEditDialog = document.querySelector("#image-edit-dialog");
const imageEditCanvas = document.querySelector("#image-edit-canvas");
const imageEditMask = document.querySelector("#image-edit-mask");
const imageEditStatus = document.querySelector("#image-edit-status");
const applyImageEditButton = document.querySelector("#apply-image-edit");
const imageEditCropButton = document.querySelector("#image-edit-crop");
const imageEditEraserButton = document.querySelector("#image-edit-eraser");
const imageEditEraserSize = document.querySelector("#image-edit-eraser-size");
const imageEditEraserSizeValue = document.querySelector("#image-edit-eraser-size-value");
const imageEditResetCropButton = document.querySelector("#image-edit-reset-crop");
let imageEditWorker = null;
let backgroundRemovalWorker = null;
let imageEditItemId = null;
let imageEditOriginalImage = null;
let imageEditPoints = [];
let imageEditMaskData = null;
let imageEditRequestId = 0;
let backgroundRemovalRequestId = 0;
let imageEditMaskMode = "binary";
let imageEditTool = "select";
let imageEditCrop = null;
let imageEditPointer = null;
let imageEditEraserCursor = null;
let imageEditCropCursor = null;
let imageEditReady = false;
let imageEditModelReady = false;
let imageEditBusy = false;
let backgroundRemovalBusy = false;
let imageEditPointLabel = 1;

function setImageEditStatus(message, isError = false) {
  imageEditStatus.textContent = message;
  imageEditStatus.classList.toggle("error", isError);
}

function hasImageEditCrop() {
  return imageEditCrop && imageEditCrop.width >= 2 && imageEditCrop.height >= 2;
}

function updateImageEditApplyButton() {
  applyImageEditButton.disabled = imageEditBusy || backgroundRemovalBusy
    || (!imageEditMaskData && !hasImageEditCrop());
}

function setImageEditTool(tool) {
  imageEditTool = tool;
  imageEditCanvas.classList.toggle("tool-crop", tool === "crop");
  imageEditCanvas.classList.toggle("tool-eraser", tool === "eraser");
  imageEditCropButton.classList.toggle("active", tool === "crop");
  imageEditEraserButton.classList.toggle("active", tool === "eraser");
  document.querySelector("#image-edit-foreground").classList.toggle("active", tool === "select" && imageEditPointLabel === 1);
  document.querySelector("#image-edit-background").classList.toggle("active", tool === "select" && imageEditPointLabel === 0);
  drawImageEditMask();
}

function drawImageEditMask() {
  const context = imageEditMask.getContext("2d");
  if (!context) return;
  imageEditMask.width = imageEditCanvas.width;
  imageEditMask.height = imageEditCanvas.height;
  context.clearRect(0, 0, imageEditMask.width, imageEditMask.height);
  if (imageEditMaskData) {
    const { width, height, data } = imageEditMaskData;
    const overlay = context.createImageData(width, height);
    for (let index = 0; index < data.length; index += 1) {
      if (data[index]) {
        const pixel = index * 4;
        overlay.data[pixel] = 28;
        overlay.data[pixel + 1] = 148;
        overlay.data[pixel + 2] = 92;
        overlay.data[pixel + 3] = 105;
      }
    }
    context.putImageData(overlay, 0, 0);
  }
  if (hasImageEditCrop()) {
    const { x, y, width, height } = imageEditCrop;
    context.fillStyle = "#10181380";
    context.fillRect(0, 0, imageEditMask.width, y);
    context.fillRect(0, y + height, imageEditMask.width, imageEditMask.height - y - height);
    context.fillRect(0, y, x, height);
    context.fillRect(x + width, y, imageEditMask.width - x - width, height);
    context.strokeStyle = "#fff";
    context.lineWidth = Math.max(2, imageEditMask.width / 400);
    context.setLineDash([8, 5]);
    context.strokeRect(x, y, width, height);
    context.setLineDash([]);
  }
  if (imageEditTool === "crop" && imageEditCropCursor) {
    context.save();
    context.lineWidth = Math.max(1, imageEditCanvas.width / 500);
    context.setLineDash([5, 4]);
    context.strokeStyle = "#17231fcc";
    context.beginPath();
    context.moveTo(imageEditCropCursor.x, 0);
    context.lineTo(imageEditCropCursor.x, imageEditMask.height);
    context.moveTo(0, imageEditCropCursor.y);
    context.lineTo(imageEditMask.width, imageEditCropCursor.y);
    context.stroke();
    context.setLineDash([]);
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(1, imageEditCanvas.width / 800);
    context.beginPath();
    context.moveTo(imageEditCropCursor.x, 0);
    context.lineTo(imageEditCropCursor.x, imageEditMask.height);
    context.moveTo(0, imageEditCropCursor.y);
    context.lineTo(imageEditMask.width, imageEditCropCursor.y);
    context.stroke();
    context.restore();
  }
  if (imageEditTool === "eraser" && imageEditEraserCursor) {
    context.beginPath();
    context.arc(imageEditEraserCursor.x, imageEditEraserCursor.y, Number(imageEditEraserSize.value) / 2, 0, Math.PI * 2);
    context.strokeStyle = "#1b2520";
    context.lineWidth = Math.max(1, imageEditCanvas.width / 500);
    context.stroke();
  }
  imageEditPoints.forEach(({ x, y, label }) => {
    context.beginPath();
    context.arc(x * imageEditCanvas.width, y * imageEditCanvas.height, Math.max(4, imageEditCanvas.width / 100), 0, Math.PI * 2);
    context.fillStyle = label === 1 ? "#20a363" : "#d94d4d";
    context.strokeStyle = "#fff";
    context.lineWidth = Math.max(2, imageEditCanvas.width / 400);
    context.fill();
    context.stroke();
  });
}

function closeImageEditor() {
  if (imageEditWorker) imageEditWorker.terminate();
  if (backgroundRemovalWorker) backgroundRemovalWorker.terminate();
  imageEditWorker = null;
  backgroundRemovalWorker = null;
  imageEditReady = false;
  imageEditModelReady = false;
  imageEditBusy = false;
  backgroundRemovalBusy = false;
  imageEditItemId = null;
  imageEditOriginalImage = null;
  imageEditPoints = [];
  imageEditMaskData = null;
  imageEditMaskMode = "binary";
  imageEditTool = "select";
  imageEditCrop = null;
  imageEditPointer = null;
  imageEditEraserCursor = null;
  imageEditCropCursor = null;
  imageEditCropButton.classList.remove("active");
  imageEditEraserButton.classList.remove("active");
  imageEditEraserButton.disabled = true;
  imageEditResetCropButton.hidden = true;
  imageEditCanvas.classList.remove("tool-crop", "tool-eraser");
  applyImageEditButton.disabled = true;
  document.querySelector("#remove-image-background").disabled = false;
  imageEditDialog.close();
}

async function openImageEditor(item) {
  if (!item?.src || item.src.includes("{{")) {
    showToast(translate("Cannot edit dynamic image"), true);
    return;
  }
  closeImageEditor();
  imageEditItemId = item.id;
  imageEditPoints = [];
  imageEditMaskData = null;
  imageEditMaskMode = "binary";
  imageEditCrop = null;
  imageEditPointer = null;
  imageEditEraserCursor = null;
  imageEditCropCursor = null;
  imageEditPointLabel = 1;
  document.querySelector("#image-edit-foreground").classList.add("active");
  document.querySelector("#image-edit-background").classList.remove("active");
  applyImageEditButton.disabled = true;
  imageEditCanvas.width = 1;
  imageEditCanvas.height = 1;
  drawImageEditMask();
  setImageEditStatus(translate("Preparing image"));
  imageEditDialog.showModal();

  let imageSource = item.src;
  let imageSourceUrl = null;
  if (item.originalAssetId) {
    try {
      const originalImage = await loadOriginalImage(item.originalAssetId);
      if (originalImage) {
        imageSourceUrl = URL.createObjectURL(originalImage);
        imageSource = imageSourceUrl;
      } else {
        showToast(translate("Original image unavailable"), true);
      }
    } catch (error) {
      console.error("Could not load original image for editing:", error);
      setImageEditStatus(translate("Cannot read original image"), true);
      return;
    }
  }
  if (!imageEditDialog.open || imageEditItemId !== item.id) {
    if (imageSourceUrl) URL.revokeObjectURL(imageSourceUrl);
    return;
  }
  const image = new Image();
  imageEditOriginalImage = image;
  if (/^https?:/i.test(imageSource)) image.crossOrigin = "anonymous";
  image.onload = () => {
    if (imageSourceUrl) URL.revokeObjectURL(imageSourceUrl);
    if (!imageEditDialog.open || imageEditItemId !== item.id) return;
    const maxDimension = 1024;
    const scale = Math.min(maxDimension / image.naturalWidth, maxDimension / image.naturalHeight, 1);
    imageEditCanvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    imageEditCanvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = imageEditCanvas.getContext("2d");
    if (!context) {
      setImageEditStatus(translate("Cannot read image"), true);
      return;
    }
    context.drawImage(image, 0, 0, imageEditCanvas.width, imageEditCanvas.height);
    drawImageEditMask();
    try {
      imageEditWorker = new Worker("/static/js/image-edit-worker.js", { type: "module" });
    } catch (error) {
      console.error("Could not start image editing worker:", error);
      setImageEditStatus(translate("Image editing unavailable"), true);
      return;
    }
    imageEditWorker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "ready") {
        imageEditModelReady = true;
        if (!backgroundRemovalBusy) setImageEditStatus(translate("Preparing image model"));
        imageEditWorker.postMessage({
          type: "load-image",
          image: imageEditCanvas.toDataURL("image/png"),
        });
      } else if (message.type === "image-ready") {
        imageEditReady = true;
        if (!backgroundRemovalBusy) setImageEditStatus(translate("Image model ready"));
      } else if (message.type === "progress") {
        const percent = Number.isFinite(message.progress) ? ` ${Math.round(message.progress)}%` : "";
        if (!backgroundRemovalBusy) setImageEditStatus(`${translate("Loading image model")}${percent}`);
      } else if (message.type === "mask") {
        if (message.id !== imageEditRequestId) return;
        imageEditBusy = false;
        imageEditMaskData = { width: message.width, height: message.height, data: new Uint8Array(message.mask) };
        imageEditMaskMode = "binary";
        imageEditEraserButton.disabled = false;
        updateImageEditApplyButton();
        drawImageEditMask();
        if (!backgroundRemovalBusy) setImageEditStatus(translate("Image selection ready"));
      } else if (message.type === "error") {
        imageEditBusy = false;
        updateImageEditApplyButton();
        if (!backgroundRemovalBusy) setImageEditStatus(translate("Image model error", { error: message.error }), true);
      }
    });
    imageEditWorker.addEventListener("error", (event) => {
      console.error("Image editing worker failed:", event.message);
      imageEditBusy = false;
      updateImageEditApplyButton();
      if (!backgroundRemovalBusy) setImageEditStatus(translate("Image editing unavailable"), true);
    });
    try {
      imageEditWorker.postMessage({ type: "init", useWebGPU: Boolean(navigator.gpu) });
    } catch (error) {
      console.error("Could not initialize image editing worker:", error);
      setImageEditStatus(translate("Image editing unavailable"), true);
      return;
    }
  };
  image.onerror = () => {
    if (imageSourceUrl) URL.revokeObjectURL(imageSourceUrl);
    setImageEditStatus(translate("Cannot edit image source"), true);
  };
  image.src = imageSource;
}

function requestImageEditMask() {
  if (!imageEditReady || !imageEditPoints.length || imageEditBusy || backgroundRemovalBusy) return;
  imageEditBusy = true;
  updateImageEditApplyButton();
  setImageEditStatus(translate("Selecting image object"));
  imageEditRequestId += 1;
  imageEditWorker.postMessage({
    type: "segment",
    id: imageEditRequestId,
    image: imageEditCanvas.toDataURL("image/png"),
    points: imageEditPoints,
  });
}

document.querySelector("#remove-image-background").addEventListener("click", () => {
  if (backgroundRemovalBusy || imageEditBusy || imageEditCanvas.width <= 1) return;
  if (!backgroundRemovalWorker) {
    try {
      backgroundRemovalWorker = new Worker("/static/js/background-removal-worker.js", { type: "module" });
    } catch (error) {
      console.error("Could not start background removal worker:", error);
      setImageEditStatus(translate("Image editing unavailable"), true);
      return;
    }
    backgroundRemovalWorker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.id !== backgroundRemovalRequestId) return;
      if (message.type === "progress") {
        const percent = Number.isFinite(message.progress) ? ` ${Math.round(message.progress)}%` : "";
        setImageEditStatus(`${translate("Loading background model")}${percent}`);
      } else if (message.type === "mask") {
        backgroundRemovalBusy = false;
        document.querySelector("#remove-image-background").disabled = false;
        imageEditPoints = [];
        imageEditMaskData = { width: message.width, height: message.height, data: new Uint8Array(message.mask) };
        imageEditMaskMode = "matte";
        imageEditEraserButton.disabled = false;
        updateImageEditApplyButton();
        drawImageEditMask();
        setImageEditStatus(translate("Background removal ready"));
      } else if (message.type === "error") {
        backgroundRemovalBusy = false;
        document.querySelector("#remove-image-background").disabled = false;
        updateImageEditApplyButton();
        setImageEditStatus(translate("Image model error", { error: message.error }), true);
      }
    });
    backgroundRemovalWorker.addEventListener("error", (event) => {
      console.error("Background removal worker failed:", event.message);
      backgroundRemovalBusy = false;
      document.querySelector("#remove-image-background").disabled = false;
      updateImageEditApplyButton();
      setImageEditStatus(translate("Image editing unavailable"), true);
    });
  }
  backgroundRemovalBusy = true;
  imageEditPoints = [];
  imageEditMaskData = null;
  applyImageEditButton.disabled = true;
  imageEditEraserButton.disabled = true;
  setImageEditTool("select");
  document.querySelector("#remove-image-background").disabled = true;
  drawImageEditMask();
  setImageEditStatus(translate("Removing background"));
  backgroundRemovalRequestId += 1;
  backgroundRemovalWorker.postMessage({
    type: "remove-background",
    id: backgroundRemovalRequestId,
    image: imageEditCanvas.toDataURL("image/png"),
    useWebGPU: Boolean(navigator.gpu),
  });
});

imageEditCanvas.addEventListener("pointerdown", (event) => {
  if (imageEditBusy || backgroundRemovalBusy || imageEditCanvas.width <= 1) return;
  const bounds = imageEditCanvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(imageEditCanvas.width, (event.clientX - bounds.left) * imageEditCanvas.width / bounds.width));
  const y = Math.max(0, Math.min(imageEditCanvas.height, (event.clientY - bounds.top) * imageEditCanvas.height / bounds.height));
  if (imageEditTool === "crop") {
    imageEditCropCursor = { x, y };
    imageEditPointer = { id: event.pointerId, startX: x, startY: y, currentX: x, currentY: y };
    imageEditCrop = { x, y, width: 0, height: 0 };
    imageEditResetCropButton.hidden = false;
    updateImageEditApplyButton();
    drawImageEditMask();
    return;
  }
  if (imageEditTool === "eraser") {
    if (!imageEditMaskData) return;
    imageEditPointer = { id: event.pointerId, startX: x, startY: y, currentX: x, currentY: y };
    eraseImageEditPixels(x, y);
    return;
  }
  if (!imageEditReady) return;
  const normalizedX = x / imageEditCanvas.width;
  const normalizedY = y / imageEditCanvas.height;
  const label = event.button === 2 ? 0 : imageEditPointLabel;
  imageEditPoints.push({ x: normalizedX, y: normalizedY, label });
  imageEditMaskData = null;
  imageEditEraserButton.disabled = true;
  imageEditMaskMode = "binary";
  updateImageEditApplyButton();
  drawImageEditMask();
  requestImageEditMask();
});
document.addEventListener("pointermove", (event) => {
  if (!imageEditDialog.open || (!imageEditPointer && imageEditTool !== "eraser" && imageEditTool !== "crop")) return;
  const bounds = imageEditCanvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const x = Math.max(0, Math.min(imageEditCanvas.width, (event.clientX - bounds.left) * imageEditCanvas.width / bounds.width));
  const y = Math.max(0, Math.min(imageEditCanvas.height, (event.clientY - bounds.top) * imageEditCanvas.height / bounds.height));
  imageEditEraserCursor = imageEditTool === "eraser" ? { x, y } : null;
  imageEditCropCursor = imageEditTool === "crop" ? { x, y } : null;
  if (!imageEditPointer || imageEditPointer.id !== event.pointerId) {
    if (imageEditTool === "eraser" || imageEditTool === "crop") drawImageEditMask();
    return;
  }
  imageEditPointer.currentX = x;
  imageEditPointer.currentY = y;
  if (imageEditTool === "crop") {
    const left = Math.min(imageEditPointer.startX, x);
    const top = Math.min(imageEditPointer.startY, y);
    imageEditCrop = {
      x: left,
      y: top,
      width: Math.abs(x - imageEditPointer.startX),
      height: Math.abs(y - imageEditPointer.startY),
    };
    updateImageEditApplyButton();
    drawImageEditMask();
  } else if (imageEditTool === "eraser" && (event.buttons & 1)) {
    eraseImageEditPixels(x, y, imageEditPointer.startX, imageEditPointer.startY);
    imageEditPointer.startX = x;
    imageEditPointer.startY = y;
  }
});
document.addEventListener("pointerup", (event) => {
  if (!imageEditPointer || imageEditPointer.id !== event.pointerId) return;
  if (imageEditTool === "crop" && hasImageEditCrop()) {
    imageEditCrop.x = Math.floor(imageEditCrop.x);
    imageEditCrop.y = Math.floor(imageEditCrop.y);
    imageEditCrop.width = Math.ceil(imageEditCrop.width);
    imageEditCrop.height = Math.ceil(imageEditCrop.height);
    setImageEditStatus(translate("Crop selection ready"));
  }
  imageEditPointer = null;
  updateImageEditApplyButton();
  drawImageEditMask();
});
document.addEventListener("pointercancel", () => { imageEditPointer = null; });
imageEditCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
imageEditCanvas.addEventListener("pointerleave", () => {
  if (imageEditTool !== "crop" || imageEditPointer) return;
  imageEditCropCursor = null;
  drawImageEditMask();
});

function eraseImageEditPixels(x, y, previousX = x, previousY = y) {
  if (!imageEditMaskData) return;
  const { width, height, data } = imageEditMaskData;
  const scaleX = width / imageEditCanvas.width;
  const scaleY = height / imageEditCanvas.height;
  const radius = Number(imageEditEraserSize.value) / 2;
  const distance = Math.hypot(x - previousX, y - previousY);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));
  for (let step = 0; step <= steps; step += 1) {
    const fraction = step / steps;
    const centerX = (previousX + (x - previousX) * fraction) * scaleX;
    const centerY = (previousY + (y - previousY) * fraction) * scaleY;
    const pixelRadiusX = radius * scaleX;
    const pixelRadiusY = radius * scaleY;
    const left = Math.max(0, Math.floor(centerX - pixelRadiusX));
    const right = Math.min(width - 1, Math.ceil(centerX + pixelRadiusX));
    const top = Math.max(0, Math.floor(centerY - pixelRadiusY));
    const bottom = Math.min(height - 1, Math.ceil(centerY + pixelRadiusY));
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const dx = (column + .5 - centerX) / pixelRadiusX;
        const dy = (row + .5 - centerY) / pixelRadiusY;
        if (dx * dx + dy * dy <= 1) data[row * width + column] = 0;
      }
    }
  }
  drawImageEditMask();
  setImageEditStatus(translate("Eraser applied"));
}

document.querySelector("#image-edit-foreground").addEventListener("click", () => {
  imageEditPointLabel = 1;
  setImageEditTool("select");
});
document.querySelector("#image-edit-background").addEventListener("click", () => {
  imageEditPointLabel = 0;
  setImageEditTool("select");
});
document.querySelector("#clear-image-edit-points").addEventListener("click", () => {
  if (backgroundRemovalBusy) return;
  imageEditPoints = [];
  imageEditMaskData = null;
  imageEditEraserButton.disabled = true;
  imageEditMaskMode = "binary";
  updateImageEditApplyButton();
  drawImageEditMask();
  setImageEditStatus(imageEditReady
    ? translate("Image model ready")
    : imageEditModelReady
      ? translate("Preparing image model")
      : translate("Loading image model"));
});
imageEditCropButton.addEventListener("click", () => {
  if (imageEditCanvas.width <= 1 || imageEditBusy || backgroundRemovalBusy) return;
  setImageEditTool(imageEditTool === "crop" ? "select" : "crop");
  if (imageEditTool === "crop") setImageEditStatus(translate("Crop hint"));
});
imageEditEraserButton.addEventListener("click", () => {
  if (!imageEditMaskData || imageEditBusy || backgroundRemovalBusy) return;
  setImageEditTool(imageEditTool === "eraser" ? "select" : "eraser");
  if (imageEditTool === "eraser") setImageEditStatus(translate("Eraser hint"));
});
imageEditEraserSize.addEventListener("input", () => {
  imageEditEraserSizeValue.value = `${imageEditEraserSize.value} px`;
  imageEditEraserSizeValue.textContent = `${imageEditEraserSize.value} px`;
  drawImageEditMask();
});
imageEditResetCropButton.addEventListener("click", () => {
  imageEditCrop = null;
  imageEditResetCropButton.hidden = true;
  if (imageEditTool === "crop") setImageEditTool("select");
  updateImageEditApplyButton();
  drawImageEditMask();
});
document.querySelector("#apply-image-edit").addEventListener("click", () => {
  const item = state.elements.find((element) => element.id === imageEditItemId && element.type === "image");
  if (!item || (!imageEditMaskData && !hasImageEditCrop()) || imageEditBusy || backgroundRemovalBusy) return;
  const sourceImage = imageEditOriginalImage ?? imageEditCanvas;
  const sourceWidth = sourceImage instanceof HTMLCanvasElement ? sourceImage.width : sourceImage.naturalWidth;
  const sourceHeight = sourceImage instanceof HTMLCanvasElement ? sourceImage.height : sourceImage.naturalHeight;
  const crop = hasImageEditCrop()
    ? imageEditCrop
    : { x: 0, y: 0, width: imageEditCanvas.width, height: imageEditCanvas.height };
  const sourceCropX = crop.x * sourceWidth / imageEditCanvas.width;
  const sourceCropY = crop.y * sourceHeight / imageEditCanvas.height;
  const sourceCropWidth = crop.width * sourceWidth / imageEditCanvas.width;
  const sourceCropHeight = crop.height * sourceHeight / imageEditCanvas.height;
  const targetScale = Math.min(
    (item.w * DOTS_PER_MM) / sourceWidth,
    (item.h * DOTS_PER_MM) / sourceHeight,
    1,
  );
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = Math.max(1, Math.round(sourceCropWidth * targetScale));
  outputCanvas.height = Math.max(1, Math.round(sourceCropHeight * targetScale));
  const outputContext = outputCanvas.getContext("2d");
  if (!outputContext) {
    showToast(translate("Cannot read image"), true);
    return;
  }
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(
    sourceImage,
    sourceCropX,
    sourceCropY,
    sourceCropWidth,
    sourceCropHeight,
    0,
    0,
    outputCanvas.width,
    outputCanvas.height,
  );

  if (imageEditMaskData) {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = imageEditMaskData.width;
    maskCanvas.height = imageEditMaskData.height;
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) {
      showToast(translate("Cannot read image"), true);
      return;
    }
    const maskPixels = new Uint8ClampedArray(imageEditMaskData.data.length * 4);
    imageEditMaskData.data.forEach((value, index) => {
      const alpha = imageEditMaskMode === "matte" ? value : value ? 255 : 0;
      maskPixels[index * 4] = 255;
      maskPixels[index * 4 + 1] = 255;
      maskPixels[index * 4 + 2] = 255;
      maskPixels[index * 4 + 3] = alpha;
    });
    maskContext.putImageData(new ImageData(maskPixels, maskCanvas.width, maskCanvas.height), 0, 0);
    outputContext.globalCompositeOperation = "destination-in";
    outputContext.drawImage(
      maskCanvas,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      outputCanvas.width,
      outputCanvas.height,
    );
    outputContext.globalCompositeOperation = "source-over";
  }
  try {
    item.src = outputCanvas.toDataURL("image/png");
    if (hasImageEditCrop()) {
      const cropScaleX = crop.x / imageEditCanvas.width;
      const cropScaleY = crop.y / imageEditCanvas.height;
      item.x += item.w * cropScaleX;
      item.y += item.h * cropScaleY;
      item.w *= crop.width / imageEditCanvas.width;
      item.h *= crop.height / imageEditCanvas.height;
    }
  } catch (error) {
    console.error("Could not apply image selection:", error);
    showToast(translate("Cannot read image"), true);
    return;
  }
  closeImageEditor();
  renderCanvas();
  scheduleSave();
});
document.querySelector("#cancel-image-edit").addEventListener("click", closeImageEditor);
document.querySelector("#close-image-editor").addEventListener("click", closeImageEditor);
imageEditDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeImageEditor();
});

function elementPoint(event) {
  const point = canvas.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = canvas.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}

function normalizedRotation(degrees) {
  return ((degrees % 360) + 360) % 360;
}

canvas.addEventListener("pointerdown", (event) => {
  const group = event.target.closest("[data-id]");
  const rotateHandle = event.target.closest("[data-element-rotate]");
  const resizeHandle = event.target.closest("[data-element-resize]");
  if (rotateHandle && group) {
    const item = state.elements.find((element) => element.id === group.dataset.id);
    if (!item) return;
    const point = elementPoint(event);
    const centerX = item.x + item.w / 2;
    const centerY = item.y + item.h / 2;
    selectedId = item.id;
    elementRotateState = {
      id: item.id,
      centerX,
      centerY,
      startAngle: Math.atan2(point.y - centerY, point.x - centerX) * 180 / Math.PI,
      rotation: number(item.rotation, 0),
    };
    canvas.setPointerCapture(event.pointerId);
    renderCanvas();
    return;
  }
  if (resizeHandle && group) {
    const item = state.elements.find((element) => element.id === group.dataset.id);
    if (!item) return;
    const point = elementPoint(event);
    selectedId = item.id;
    elementResizeState = {
      id: item.id,
      kind: resizeHandle.dataset.elementResize,
      startX: point.x,
      startY: point.y,
      x: item.x,
      y: item.y,
      width: item.w,
      height: item.h,
      rotation: number(item.rotation, 0),
    };
    canvas.setPointerCapture(event.pointerId);
    renderCanvas();
    return;
  }
  if (!group) {
    selectedId = null;
    renderCanvas();
    return;
  }
  const item = state.elements.find((element) => element.id === group.dataset.id);
  if (!item) return;
  selectedId = item.id;
  const point = elementPoint(event);
  dragState = { id: item.id, offsetX: point.x - item.x, offsetY: point.y - item.y };
  canvas.setPointerCapture(event.pointerId);
  renderCanvas();
});

canvas.addEventListener("pointermove", (event) => {
  if (elementRotateState) {
    const item = state.elements.find((element) => element.id === elementRotateState.id);
    if (!item) return;
    const point = elementPoint(event);
    const currentAngle = Math.atan2(
      point.y - elementRotateState.centerY,
      point.x - elementRotateState.centerX,
    ) * 180 / Math.PI;
    let delta = currentAngle - elementRotateState.startAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    let rotation = elementRotateState.rotation + delta;
    if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
    item.rotation = normalizedRotation(Math.round(rotation * 10) / 10);
    renderCanvas({ refreshInspector: false });
    return;
  }
  if (elementResizeState) {
    const item = state.elements.find((element) => element.id === elementResizeState.id);
    if (!item) return;
    const point = elementPoint(event);
    const worldDeltaX = point.x - elementResizeState.startX;
    const worldDeltaY = point.y - elementResizeState.startY;
    const angle = elementResizeState.rotation * Math.PI / 180;
    const deltaX = worldDeltaX * Math.cos(angle) + worldDeltaY * Math.sin(angle);
    const deltaY = -worldDeltaX * Math.sin(angle) + worldDeltaY * Math.cos(angle);
    const kind = elementResizeState.kind;
    const minSize = .5;
    const hasHorizontalHandle = kind.includes("e") || kind.includes("w");
    const hasVerticalHandle = kind.includes("n") || kind.includes("s");
    const horizontalSize = elementResizeState.width + (kind.includes("w") ? -deltaX : deltaX);
    const verticalSize = elementResizeState.height + (kind.includes("n") ? -deltaY : deltaY);
    let width = elementResizeState.width;
    let height = elementResizeState.height;

    const preserveAspect = event.shiftKey || item.type === "qr" || item.type === "image";
    if (preserveAspect) {
      const ratio = item.type === "qr"
        ? 1
        : elementResizeState.width / elementResizeState.height;
      const widthDrives = hasHorizontalHandle && (
        !hasVerticalHandle
        || Math.abs((horizontalSize - elementResizeState.width) / elementResizeState.width)
          >= Math.abs((verticalSize - elementResizeState.height) / elementResizeState.height)
      );
      if (widthDrives) {
        width = Math.max(minSize, Math.round(horizontalSize * 10) / 10);
        height = width / ratio;
      } else {
        height = Math.max(minSize, Math.round(verticalSize * 10) / 10);
        width = height * ratio;
      }
    } else {
      if (kind.includes("e")) width = Math.max(minSize, Math.round(horizontalSize * 10) / 10);
      if (kind.includes("w")) {
        width = Math.max(minSize, Math.round(horizontalSize * 10) / 10);
      }
      if (kind.includes("s")) height = Math.max(minSize, Math.round(verticalSize * 10) / 10);
      if (kind.includes("n")) {
        height = Math.max(minSize, Math.round(verticalSize * 10) / 10);
      }
    }
    let offsetX = kind.includes("w") ? elementResizeState.width - width : 0;
    let offsetY = kind.includes("n") ? elementResizeState.height - height : 0;
    if (event.ctrlKey) {
      offsetX = (elementResizeState.width - width) / 2;
      offsetY = (elementResizeState.height - height) / 2;
    } else {
      if (preserveAspect && !hasHorizontalHandle) offsetX = (elementResizeState.width - width) / 2;
      if (preserveAspect && !hasVerticalHandle) offsetY = (elementResizeState.height - height) / 2;
    }
    const centerOffsetX = (elementResizeState.width - width) / 2;
    const centerOffsetY = (elementResizeState.height - height) / 2;
    item.x = elementResizeState.x
      + offsetX * Math.cos(angle) - offsetY * Math.sin(angle)
      + centerOffsetX * (1 - Math.cos(angle)) + centerOffsetY * Math.sin(angle);
    item.y = elementResizeState.y
      + offsetX * Math.sin(angle) + offsetY * Math.cos(angle)
      - centerOffsetX * Math.sin(angle) + centerOffsetY * (1 - Math.cos(angle));
    item.w = width;
    item.h = height;
    if (event.ctrlKey && item.type === "text" && hasVerticalHandle) {
      fitTextFontToHeight(item);
    }
    renderCanvas({ refreshInspector: false });
    return;
  }
  if (!dragState) return;
  const item = state.elements.find((element) => element.id === dragState.id);
  if (!item) return;
  const point = elementPoint(event);
  item.x = Math.max(0, Math.min(state.widthMm - item.w, point.x - dragState.offsetX));
  item.y = Math.max(0, Math.min(state.heightMm - item.h, point.y - dragState.offsetY));
  renderCanvas();
});

canvas.addEventListener("pointerup", () => {
  if (elementRotateState) {
    elementRotateState = null;
    renderCanvas();
    scheduleSave();
    return;
  }
  if (elementResizeState) {
    elementResizeState = null;
    renderCanvas();
    scheduleSave();
    return;
  }
  if (!dragState) return;
  dragState = null;
  renderCanvas();
  scheduleSave();
});
canvas.addEventListener("pointercancel", () => {
  dragState = null;
  elementResizeState = null;
  elementRotateState = null;
  renderCanvas();
});

propertiesPanel.addEventListener("input", (event) => updateProperty(event.target));
propertiesPanel.addEventListener("change", (event) => updateProperty(event.target, true));
propertiesPanel.addEventListener("click", (event) => {
  const editImageId = event.target.closest("[data-edit-image]")?.dataset.editImage;
  if (editImageId) {
    const item = state.elements.find((element) => element.id === editImageId && element.type === "image");
    if (item) openImageEditor(item);
    return;
  }
  const align = event.target.closest("[data-align]")?.dataset.align;
  const item = selectedElement();
  if (align && item) {
    if (align === "center-x") item.x = Math.max(0, (state.widthMm - item.w) / 2);
    if (align === "center-y") item.y = Math.max(0, (state.heightMm - item.h) / 2);
    renderCanvas();
    scheduleSave();
    return;
  }
  const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
  if (deleteId) deleteElement(deleteId);
});

function deleteElement(id) {
  const deletedElement = state.elements.find((item) => item.id === id);
  if (deletedElement?.originalAssetId) {
    deleteOriginalImage(deletedElement.originalAssetId)
      .catch((error) => console.error("Could not remove deleted image source:", error));
  }
  state.elements = state.elements.filter((item) => item.id !== id);
  if (selectedId === id) selectedId = null;
  refreshDynamicRows();
  renderCanvas();
  scheduleSave();
}

layerList.addEventListener("click", (event) => {
  const orderButton = event.target.closest("[data-order]");
  if (orderButton) {
    const index = Number(orderButton.dataset.order);
    const next = index + Number(orderButton.dataset.direction);
    if (next >= 0 && next < state.elements.length) {
      [state.elements[index], state.elements[next]] = [state.elements[next], state.elements[index]];
      renderCanvas();
      scheduleSave();
    }
    return;
  }
  const layer = event.target.closest("[data-layer]");
  if (layer) {
    selectedId = layer.dataset.layer;
    renderCanvas();
  }
});

document.querySelectorAll("[data-add]").forEach((button) => {
  button.addEventListener("click", () => addElement(button.dataset.add));
});
document.querySelector("#add-image").addEventListener("click", () => document.querySelector("#image-file").click());
document.querySelector("#image-file").addEventListener("change", (event) => {
  addImageFile(event.target.files[0]);
  event.target.value = "";
});
document.querySelector("#add-sticker").addEventListener("click", () => {
  showAssetPicker("sticker-picker-dialog", renderStickerPicker);
});
document.querySelector("#add-fa-icon").addEventListener("click", () => {
  showAssetPicker("fa-picker-dialog", renderFontAwesomePicker);
});
document.querySelector("#add-shape").addEventListener("click", () => {
  showAssetPicker("shape-picker-dialog", renderShapePicker);
});
document.querySelector("#add-frame").addEventListener("click", () => {
  showAssetPicker("frame-picker-dialog", renderFramePicker);
});
document.querySelector("#sticker-picker-list").addEventListener("click", (event) => {
  const option = event.target.closest("[data-sticker]");
  if (!option) return;
  document.querySelector("#sticker-picker-dialog").close();
  addElement("image", {
    name: translate(STICKERS.find(({ file }) => file === option.dataset.sticker)?.label ?? "Image"),
    x: 3,
    y: 3,
    w: 11,
    h: 11,
    src: `/static/stickers/${option.dataset.sticker}`,
  });
});
document.querySelector("#fa-picker-list").addEventListener("click", (event) => {
  const option = event.target.closest("[data-icon-name]");
  if (!option) return;
  document.querySelector("#fa-picker-dialog").close();
  addElement("fontAwesome", { iconName: option.dataset.iconName });
});
document.querySelector("#shape-picker-list").addEventListener("click", (event) => {
  const option = event.target.closest("[data-shape-type]");
  if (!option || !SHAPE_TYPES.has(option.dataset.shapeType)) return;
  document.querySelector("#shape-picker-dialog").close();
  addElement(option.dataset.shapeType);
});
document.querySelector("#frame-picker-list").addEventListener("click", (event) => {
  const option = event.target.closest("[data-frame-style]");
  const frame = FRAME_STYLES.find(({ style }) => style === option?.dataset.frameStyle);
  if (!frame) return;
  document.querySelector("#frame-picker-dialog").close();
  addFrame(frame.style);
});
document.querySelectorAll("[data-close-picker]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(`#${button.dataset.closePicker}`).close();
  });
});
["label-width", "label-height", "label-gap", "safe-inset"].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener("change", applyDimensions);
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    currentTab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelector("#properties-panel").hidden = currentTab !== "properties";
    document.querySelector("#layers-panel").hidden = currentTab !== "layers";
    document.querySelector("#data-panel").hidden = currentTab !== "data";
  });
});

document.querySelector("#dynamic-csv").addEventListener("input", (event) => {
  state.dynamicCsv = event.target.value;
  previewRowIndex = 0;
  document.querySelector("#batch-progress").textContent = "";
  refreshDynamicRows();
  renderCanvas();
  scheduleSave();
});
document.querySelector("#dynamic-preview").addEventListener("change", (event) => {
  previewRowIndex = Number(event.target.value);
  renderCanvas();
});
document.querySelector("#preview-all-labels").addEventListener("click", showBatchPreview);
document.querySelector("#close-batch-preview").addEventListener("click", () => {
  document.querySelector("#batch-preview-dialog").close();
});
document.querySelector("#batch-preview-dialog").addEventListener("close", () => {
  batchPreviewGeneration += 1;
  if (batchPreviewScrollHandler) {
    document.querySelector("#batch-preview-list")
      .removeEventListener("scroll", batchPreviewScrollHandler);
    batchPreviewScrollHandler = null;
  }
});

document.querySelector("#zoom-in").addEventListener("click", () => chooseZoom(zoom + .15));
document.querySelector("#zoom-out").addEventListener("click", () => chooseZoom(zoom - .15));
document.querySelector("#fit-canvas").addEventListener("click", fitCanvas);
window.addEventListener("resize", fitCanvas);

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveDesign() {
  downloadBlob(
    new Blob([JSON.stringify({ format: "label-studio", version: 1, ...state }, null, 2)], { type: "application/json" }),
    "label-design.olm",
  );
  saveStatusKey = "Downloaded design";
  document.querySelector("#save-state").textContent = translate(saveStatusKey);
  showToast(translate("Downloaded design"));
}

function openDesignFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!validDesign(parsed)) throw new Error(translate("Invalid design file"));
      state = {
        widthMm: Number(parsed.widthMm),
        heightMm: Number(parsed.heightMm),
        gapMm: Number(parsed.gapMm ?? 0),
        safeMarginMm: Number(parsed.safeMarginMm ?? 2),
        dynamicCsv: typeof parsed.dynamicCsv === "string" ? parsed.dynamicCsv : "",
        elements: parsed.elements.map((item) => ({ ...item, qrLoading: false })),
      };
      selectedId = null;
      syncDimensionInputs();
      refreshDynamicRows({ syncInput: true });
      renderCanvas();
      scheduleSave();
      showToast(translate("Opened design"));
    } catch (error) {
      showToast(error.message || translate("Cannot read design file"), true);
    }
  };
  reader.readAsText(file);
}

function confirmReplaceDesign() {
  return !(state.elements.length || state.dynamicCsv?.trim())
    || window.confirm(translate("New label confirmation"));
}

function blankDesign() {
  return {
    widthMm: printerConfig?.widthMm ?? 50,
    heightMm: printerConfig?.heightMm ?? 30,
    gapMm: printerConfig?.gapMm ?? 0,
    safeMarginMm: 2,
    dynamicCsv: "",
    elements: [],
  };
}

function applyNewDesign(design) {
  if (!confirmReplaceDesign()) return false;
  state = {
    ...design,
    widthMm: Number(design.widthMm),
    heightMm: Number(design.heightMm),
    gapMm: Number(design.gapMm ?? 0),
    safeMarginMm: Number(design.safeMarginMm ?? 2),
    dynamicCsv: typeof design.dynamicCsv === "string" ? design.dynamicCsv : "",
    elements: design.elements.map((item) => ({ ...item, qrLoading: false })),
  };
  selectedId = null;
  previewRowIndex = 0;
  document.querySelector("#batch-progress").textContent = "";
  syncDimensionInputs();
  refreshDynamicRows({ syncInput: true });
  renderCanvas();
  scheduleSave();
  return true;
}

async function loadTemplateCatalog() {
  if (templateCatalog.length) return templateCatalog;
  const response = await fetch("/static/labels/templates/index.json");
  if (!response.ok) throw new Error(translate("Cannot load templates"));
  const templates = await response.json();
  if (!Array.isArray(templates) || templates.some((template) => (
    !template
    || typeof template.id !== "string"
    || typeof template.file !== "string"
    || template.file !== template.file.split(/[\\/]/).at(-1)
    || typeof template.titleKey !== "string"
    || typeof template.descriptionKey !== "string"
    || typeof template.icon !== "string"
  ))) {
    throw new Error(translate("Cannot load templates"));
  }
  templateCatalog = templates;
  return templateCatalog;
}

function getFingerprintUserId() {
  if (!fingerprintUserIdPromise) {
    fingerprintUserIdPromise = new Promise((resolve, reject) => {
      const complete = (userId) => {
        if (
          typeof userId !== "string"
          || userId.length > 64_000
          || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(userId)
          || userId.slice(userId.indexOf(",") + 1).length % 4 !== 0
        ) {
          reject(new Error(translate("User ID unavailable")));
          return;
        }
        resolve(userId);
      };
      const current = document.querySelector("#__finger-id")?.value;
      if (current) {
        complete(current);
        return;
      }
      const timeout = setTimeout(() => {
        document.removeEventListener("finger-id-ready", onReady);
        document.removeEventListener("finger-id-error", onError);
        reject(new Error(translate("User ID unavailable")));
      }, 5000);
      const onReady = (event) => {
        clearTimeout(timeout);
        document.removeEventListener("finger-id-error", onError);
        complete(event.detail);
      };
      const onError = () => {
        clearTimeout(timeout);
        document.removeEventListener("finger-id-ready", onReady);
        reject(new Error(translate("User ID unavailable")));
      };
      document.addEventListener("finger-id-ready", onReady, { once: true });
      document.addEventListener("finger-id-error", onError, { once: true });
    });
  }
  return fingerprintUserIdPromise;
}

async function loadUserTemplates() {
  userTemplatesLoadError = false;
  const userId = await getFingerprintUserId();
  const response = await fetch("/api/user-templates", {
    headers: { "X-Finger-ID": userId },
  });
  if (!response.ok) throw new Error(translate("Cannot load saved templates"));
  const result = await response.json();
  if (!Array.isArray(result.templates)) {
    throw new Error(translate("Cannot load saved templates"));
  }
  userTemplates = result.templates;
}

function addTemplateSection(list, key) {
  const heading = document.createElement("h3");
  heading.className = "template-section-title";
  heading.textContent = translate(key);
  list.append(heading);
}

function makeTemplateCard({ icon, title, description, selectData, deleteId }) {
  const row = document.createElement("div");
  row.className = deleteId ? "template-card-row" : "";
  const button = document.createElement("button");
  button.className = "template-card";
  button.type = "button";
  Object.assign(button.dataset, selectData);
  const iconWrap = document.createElement("span");
  iconWrap.className = "template-card-icon";
  const iconElement = document.createElement("i");
  iconElement.className = `fa-solid ${icon}`;
  iconElement.setAttribute("aria-hidden", "true");
  iconWrap.append(iconElement);
  const copy = document.createElement("span");
  copy.className = "template-card-copy";
  const titleElement = document.createElement("strong");
  titleElement.textContent = title;
  copy.append(titleElement);
  if (description) {
    const descriptionElement = document.createElement("span");
    descriptionElement.textContent = description;
    copy.append(descriptionElement);
  }
  button.append(iconWrap, copy);
  row.append(button);
  if (deleteId) {
    const deleteButton = document.createElement("button");
    deleteButton.className = "template-card-delete";
    deleteButton.type = "button";
    deleteButton.dataset.deleteUserTemplate = String(deleteId);
    deleteButton.setAttribute("aria-label", translate("Delete template", { name: title }));
    deleteButton.title = translate("Delete template", { name: title });
    deleteButton.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
    row.append(deleteButton);
  }
  return row;
}

function renderTemplateCards() {
  const list = document.querySelector("#template-list");
  list.replaceChildren();
  addTemplateSection(list, "Built-in templates");
  for (const template of templateCatalog) {
    list.append(makeTemplateCard({
      icon: template.icon,
      title: translate(template.titleKey),
      description: translate(template.descriptionKey),
      selectData: { template: template.id },
    }));
  }
  addTemplateSection(list, "My templates");
  if (userTemplatesLoadError) {
    const message = document.createElement("p");
    message.className = "template-loading";
    message.textContent = translate("Cannot load saved templates");
    list.append(message);
  } else if (!userTemplates.length) {
    const message = document.createElement("p");
    message.className = "template-loading";
    message.textContent = translate("No saved templates");
    list.append(message);
  } else {
    for (const template of userTemplates) {
      list.append(makeTemplateCard({
        icon: "fa-floppy-disk",
        title: template.name,
        description: "",
        selectData: { userTemplate: String(template.id) },
        deleteId: template.id,
      }));
    }
  }
}

async function freshDesign() {
  const dialog = document.querySelector("#new-design-dialog");
  const list = document.querySelector("#template-list");
  dialog.showModal();
  document.querySelector("#save-template-form").hidden = true;
  list.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "template-loading";
  loading.textContent = translate("Loading templates");
  list.append(loading);
  try {
    await loadTemplateCatalog();
    try {
      await loadUserTemplates();
    } catch (error) {
      userTemplatesLoadError = true;
      console.error("Saved templates load error:", error);
      showToast(error.message || translate("Cannot load saved templates"), true);
    }
    renderTemplateCards();
  } catch (error) {
    console.error("Template catalog error:", error);
    list.replaceChildren();
    const failure = document.createElement("p");
    failure.className = "template-loading";
    failure.textContent = translate("Cannot load templates");
    list.append(failure);
    showToast(translate("Cannot load templates"), true);
  }
}

async function chooseTemplate(id) {
  const template = templateCatalog.find((item) => item.id === id);
  if (!template) return;
  try {
    const response = await fetch(`/static/labels/templates/${encodeURIComponent(template.file)}`);
    if (!response.ok) throw new Error(translate("Cannot load template"));
    const design = await response.json();
    if (!validDesign(design)) throw new Error(translate("Invalid template"));
    if (!applyNewDesign(design)) return;
    document.querySelector("#new-design-dialog").close();
    showToast(translate("Template applied", { name: translate(template.titleKey) }));
  } catch (error) {
    console.error(`Template load error (${template.id}):`, error);
    showToast(error.message || translate("Cannot load template"), true);
  }
}

async function chooseUserTemplate(id) {
  try {
    const userId = await getFingerprintUserId();
    const response = await fetch(`/api/user-templates/${encodeURIComponent(id)}`, {
      headers: { "X-Finger-ID": userId },
    });
    if (!response.ok) throw new Error(translate("Cannot load template"));
    const result = await response.json();
    if (!validDesign(result.design)) throw new Error(translate("Invalid template"));
    if (!applyNewDesign(result.design)) return;
    document.querySelector("#new-design-dialog").close();
    showToast(translate("Template applied", { name: result.name }));
  } catch (error) {
    console.error(`Saved template load error (${id}):`, error);
    showToast(error.message || translate("Cannot load template"), true);
  }
}

async function saveCurrentTemplate() {
  const nameInput = document.querySelector("#template-name");
  const name = nameInput.value.trim();
  if (!name || name.length > 80) {
    showToast(translate("Template name required"), true);
    nameInput.focus();
    return;
  }
  const saveButton = document.querySelector("#confirm-save-template");
  saveButton.disabled = true;
  try {
    const userId = await getFingerprintUserId();
    const response = await fetch("/api/user-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Finger-ID": userId },
      body: JSON.stringify({ name, design: structuredClone(state) }),
    });
    if (response.status === 409) throw new Error(translate("Template name duplicate"));
    if (!response.ok) throw new Error(translate("Cannot save template"));
    const saved = await response.json();
    if (!Number.isSafeInteger(saved.id) || saved.name !== name) {
      throw new Error(translate("Cannot save template"));
    }
    userTemplatesLoadError = false;
    userTemplates.unshift({ id: saved.id, name: saved.name });
    renderTemplateCards();
    document.querySelector("#save-template-form").reset();
    document.querySelector("#save-template-form").hidden = true;
    showToast(translate("Template saved", { name }));
  } catch (error) {
    console.error("Save template error:", error);
    showToast(error.message || translate("Cannot save template"), true);
  } finally {
    saveButton.disabled = false;
  }
}

async function deleteUserTemplate(id) {
  const template = userTemplates.find((item) => String(item.id) === String(id));
  if (!template || !window.confirm(translate("Confirm delete template", { name: template.name }))) return;
  try {
    const userId = await getFingerprintUserId();
    const response = await fetch(`/api/user-templates/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Finger-ID": userId },
    });
    if (!response.ok) throw new Error(translate("Cannot delete template"));
    userTemplates = userTemplates.filter((item) => String(item.id) !== String(id));
    renderTemplateCards();
    showToast(translate("Template deleted", { name: template.name }));
  } catch (error) {
    console.error(`Saved template delete error (${id}):`, error);
    showToast(error.message || translate("Cannot delete template"), true);
  }
}

async function renderPngBlob(record = activeDynamicRecord(), design = state) {
  const qrElements = renderedElements(record, design).filter((item) => item.type === "qr");
  await Promise.all(qrElements.map((item) => waitForQr(item)));
  const renderDesign = await embedImageSources(record, design);
  const markup = svgMarkup(record, renderDesign);
  const svgBlob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const output = document.createElement("canvas");
    output.width = Math.round(design.widthMm * DOTS_PER_MM);
    output.height = Math.round(design.heightMm * DOTS_PER_MM);
    const context = output.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(image, 0, 0, output.width, output.height);
    return await new Promise((resolve, reject) => {
      output.toBlob((blob) => blob ? resolve(blob) : reject(new Error(translate("PNG export failed"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitForQr(item) {
  if (qrCache.has(item.data) || item.qrSource || !item.data) return Promise.resolve();
  if (/{{\s*[^{}]+?\s*}}/.test(item.data)) return Promise.resolve();
  return requestQrImage(item.data);
}

function imageBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error(translate("Cannot read image")));
    reader.onerror = () => reject(new Error(translate("Cannot read image")));
    reader.readAsDataURL(blob);
  });
}

function imageSourceDataUrl(source) {
  if (source.startsWith("data:")) return Promise.resolve(source);
  if (imageSourceCache.has(source)) return imageSourceCache.get(source);
  const request = fetch(source).then((response) => {
    if (!response.ok) throw new Error(translate("Cannot read image"));
    return response.blob();
  }).then((blob) => {
    if (!blob.type.startsWith("image/")) throw new Error(translate("Cannot read image"));
    return imageBlobToDataUrl(blob);
  }).catch((error) => {
    imageSourceCache.delete(source);
    throw error;
  });
  imageSourceCache.set(source, request);
  return request;
}

function inlineStickerSource(item) {
  if (
    item.type !== "image"
    || typeof item.src !== "string"
    || !item.src.startsWith("/static/stickers/")
    || stickerEmbeddingRequests.has(item)
  ) return;

  const source = item.src;
  const request = imageSourceDataUrl(source).then((dataUrl) => {
    if (item.src !== source || !state.elements.includes(item)) return;
    item.src = dataUrl;
    renderCanvas({ refreshQr: false });
    scheduleSave();
  }).catch((error) => {
    console.error(`Sticker image load failed (${source}):`, error);
    showToast(error.message || translate("Cannot read image"), true);
  }).finally(() => stickerEmbeddingRequests.delete(item));
  stickerEmbeddingRequests.set(item, request);
}

async function embedImageSources(record, design) {
  const renderDesign = structuredClone(design);
  await Promise.all(renderDesign.elements.map(async (item) => {
    if (item.type !== "image" || !item.src) return;
    const source = resolveDynamicValue(item.src, record);
    if (!source || /{{\s*[^{}]+?\s*}}/.test(source)) return;
    item.src = await imageSourceDataUrl(source);
  }));
  return renderDesign;
}

function createBatchPreviewCard(index, record, design) {
  const card = document.createElement("article");
  card.className = "batch-preview-card";
  card.dataset.index = String(index);

  const heading = document.createElement("div");
  heading.className = "batch-preview-card-heading";
  const labelNumber = document.createElement("strong");
  labelNumber.textContent = translate("Label number", { number: index + 1 });
  heading.append(labelNumber);
  const summary = record[dynamicHeaders[0]];
  if (summary) {
    const summaryElement = document.createElement("span");
    summaryElement.textContent = summary;
    heading.append(summaryElement);
  }

  const art = document.createElement("div");
  art.className = "batch-preview-art";
  art.style.aspectRatio = `${design.widthMm} / ${design.heightMm}`;
  card.append(heading, art);
  return card;
}

async function renderBatchPreviewCard(card, record, design, generation) {
  try {
    const qrElements = renderedElements(record, design).filter((item) => item.type === "qr");
    await Promise.all(qrElements.map((item) => waitForQr(item)));
    if (generation !== batchPreviewGeneration || !card.isConnected) return;
    const renderDesign = await embedImageSources(record, design);
    if (generation !== batchPreviewGeneration || !card.isConnected) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = svgMarkup(record, renderDesign);
    card.querySelector(".batch-preview-art").replaceChildren(wrapper.firstElementChild);
  } catch (error) {
    console.error(`Label preview failed at row ${Number(card.dataset.index) + 1}:`, error);
    if (generation !== batchPreviewGeneration || !card.isConnected) return;
    const message = document.createElement("p");
    message.className = "batch-preview-error";
    message.textContent = translate("Cannot preview label", {
      number: Number(card.dataset.index) + 1,
    });
    card.querySelector(".batch-preview-art").replaceChildren(message);
  }
}

function renderVisibleBatchPreviews(records, design, generation) {
  const list = document.querySelector("#batch-preview-list");
  const bounds = list.getBoundingClientRect();
  const cards = list.children;
  const firstVisibleEdge = bounds.top - 160;
  const lastVisibleEdge = bounds.bottom + 160;
  let start = 0;
  let end = cards.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (cards[middle].getBoundingClientRect().bottom < firstVisibleEdge) start = middle + 1;
    else end = middle;
  }
  for (let index = start; index < cards.length; index += 1) {
    const card = cards[index];
    const cardBounds = card.getBoundingClientRect();
    if (cardBounds.top > lastVisibleEdge) break;
    if (card.dataset.rendering) continue;
    card.dataset.rendering = "true";
    renderBatchPreviewCard(card, records[Number(card.dataset.index)], design, generation);
  }
}

function calculatePaperLayout(paperName, design, margin = 5, gap = 3) {
  const paperSize = STANDARD_PAPER_SIZES[paperName];
  if (!paperSize) throw new Error(`Unsupported paper size: ${paperName}`);
  const labelWidth = number(design.widthMm, 0);
  const labelHeight = number(design.heightMm, 0);
  if (!(labelWidth > 0) || !(labelHeight > 0)) return null;
  const labelOrientations = [
    { width: labelWidth, height: labelHeight, rotated: false },
  ];
  if (labelWidth !== labelHeight) {
    labelOrientations.push({ width: labelHeight, height: labelWidth, rotated: true });
  }

  let bestLayout = null;
  for (const landscape of [false, true]) {
    const [paperWidth, paperHeight] = landscape
      ? [paperSize[1], paperSize[0]]
      : paperSize;
    const usableWidth = paperWidth - margin * 2;
    const usableHeight = paperHeight - margin * 2;
    for (const first of labelOrientations) {
      for (const second of labelOrientations) {
        const firstColumns = Math.floor((usableWidth + gap) / (first.width + gap));
        const secondColumns = Math.floor((usableWidth + gap) / (second.width + gap));
        if (!firstColumns || !secondColumns) continue;
        const maxFirstRows = Math.floor((usableHeight + gap) / (first.height + gap));
        for (let firstRows = 0; firstRows <= maxFirstRows; firstRows += 1) {
          const firstHeight = firstRows
            ? firstRows * (first.height + gap) - gap
            : 0;
          const remainingHeight = usableHeight - firstHeight - (firstRows ? gap : 0);
          const secondRows = Math.max(
            0,
            Math.floor((remainingHeight + gap) / (second.height + gap)),
          );
          const count = firstRows * firstColumns + secondRows * secondColumns;
          if (!count) continue;
          const rotatedCount = (first.rotated ? firstRows * firstColumns : 0)
            + (second.rotated ? secondRows * secondColumns : 0);
          if (
            bestLayout
            && (count < bestLayout.labelsPerPage
              || (count === bestLayout.labelsPerPage && rotatedCount >= bestLayout.rotatedCount))
          ) continue;
          bestLayout = {
            paperName,
            paperWidth,
            paperHeight,
            landscape,
            margin,
            gap,
            labelsPerPage: count,
            rotatedCount,
            rows: [
              ...Array.from({ length: firstRows }, () => ({
                ...first,
                columns: firstColumns,
              })),
              ...Array.from({ length: secondRows }, () => ({
                ...second,
                columns: secondColumns,
              })),
            ],
          };
        }
      }
    }
  }
  if (!bestLayout) return null;

  const rowsHeight = bestLayout.rows.reduce((height, row) => height + row.height, 0);
  const totalHeight = rowsHeight + gap * Math.max(0, bestLayout.rows.length - 1);
  let y = margin + (bestLayout.paperHeight - margin * 2 - totalHeight) / 2;
  bestLayout.placements = [];
  for (const row of bestLayout.rows) {
    const rowWidth = row.columns * row.width + gap * (row.columns - 1);
    const startX = margin + (bestLayout.paperWidth - margin * 2 - rowWidth) / 2;
    for (let column = 0; column < row.columns; column += 1) {
      bestLayout.placements.push({
        x: startX + column * (row.width + gap),
        y,
        width: row.width,
        height: row.height,
        rotated: row.rotated,
      });
    }
    y += row.height + gap;
  }
  return bestLayout;
}

function updatePaperLayoutSummary() {
  const paperName = document.querySelector("#paper-size").value;
  const layout = calculatePaperLayout(paperName, state);
  const summary = document.querySelector("#paper-layout-summary");
  const button = document.querySelector("#preview-paper-print");
  document.querySelector("#confirm-paper-print").disabled = true;
  if (!layout) {
    summary.textContent = translate("Paper size too small");
    button.disabled = true;
    return;
  }
  const pages = Math.ceil(dynamicRows.length / layout.labelsPerPage);
  const orientation = translate(layout.landscape ? "Landscape" : "Portrait");
  summary.textContent = translate("Paper layout summary", {
    perPage: layout.labelsPerPage,
    pages,
    orientation,
  });
  button.disabled = !dynamicRows.length || Boolean(dynamicCsvError) || batchPrinting;
}

function paperLabelMarkup(markup, design, placement) {
  const openTagEnd = markup.indexOf(">", markup.indexOf("<svg"));
  const closeTagStart = markup.lastIndexOf("</svg>");
  if (openTagEnd < 0 || closeTagStart < openTagEnd) {
    throw new Error("Could not prepare label artwork for paper printing.");
  }
  const inner = markup.slice(openTagEnd + 1, closeTagStart);
  const labelSvg = `<svg width="${design.widthMm}" height="${design.heightMm}" viewBox="0 0 ${design.widthMm} ${design.heightMm}">${inner}</svg>`;
  if (!placement.rotated) {
    return `<svg x="${placement.x}" y="${placement.y}" width="${placement.width}" height="${placement.height}" viewBox="0 0 ${design.widthMm} ${design.heightMm}">${inner}</svg>`;
  }
  return `<g transform="translate(${placement.x + placement.width} ${placement.y}) rotate(90)">${labelSvg}</g>`;
}

async function renderPaperSheets(records, design, layout, onProgress, isCancelled = () => false) {
  const pages = [];
  const pageCount = Math.ceil(records.length / layout.labelsPerPage);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    if (isCancelled()) return null;
    const pageRecords = records.slice(
      pageIndex * layout.labelsPerPage,
      (pageIndex + 1) * layout.labelsPerPage,
    );
    const pageLabels = [];
    for (let slot = 0; slot < pageRecords.length; slot += 1) {
      if (isCancelled()) return null;
      const currentLabel = pageIndex * layout.labelsPerPage + slot + 1;
      onProgress(currentLabel, records.length);
      const record = pageRecords[slot];
      const qrElements = renderedElements(record, design)
        .filter((item) => item.type === "qr");
      await Promise.all(qrElements.map((item) => waitForQr(item)));
      const renderDesign = await embedImageSources(record, design);
      const markup = svgMarkup(record, renderDesign);
      pageLabels.push(paperLabelMarkup(markup, design, layout.placements[slot]));
      if (slot % 12 === 11) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
    pages.push(
      `<svg xmlns="${SVG_NS}" width="${layout.paperWidth}" height="${layout.paperHeight}" viewBox="0 0 ${layout.paperWidth} ${layout.paperHeight}"><rect width="${layout.paperWidth}" height="${layout.paperHeight}" fill="#fff"/>${pageLabels.join("")}</svg>`,
    );
  }
  return pages;
}

function paperPrintDocument(pages, layout) {
  const pageCss = pages.map((_, index) => (
    `.sheet:nth-of-type(${index + 1}){break-after:${index === pages.length - 1 ? "auto" : "page"};page-break-after:${index === pages.length - 1 ? "auto" : "always"}}`
  )).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${location.origin}/"><title>${escapeHtml(translate("Print labels on paper"))}</title><style>@page{size:${layout.paperWidth}mm ${layout.paperHeight}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;width:${layout.paperWidth}mm}body{font-family:Arial,sans-serif}.sheet{width:${layout.paperWidth}mm;height:${layout.paperHeight}mm;overflow:hidden;margin:0}.sheet svg{display:block;width:${layout.paperWidth}mm;height:${layout.paperHeight}mm}${pageCss}@media screen{body{background:#e8ece9}.sheet{margin:12px auto;background:#fff;box-shadow:0 2px 12px #0002}}</style></head><body>${pages.map((markup) => `<section class="sheet">${markup}</section>`).join("")}<script>window.onload=()=>{window.focus();window.onafterprint=()=>window.close();window.print()}<\/script></body></html>`;
}

async function showBatchPreview() {
  if (!dynamicRows.length || dynamicCsvError || batchPrinting) return;
  const dialog = document.querySelector("#batch-preview-dialog");
  const list = document.querySelector("#batch-preview-list");
  const generation = ++batchPreviewGeneration;
  const records = dynamicRows.map((record) => ({ ...record }));
  const design = structuredClone(state);

  if (batchPreviewScrollHandler) {
    list.removeEventListener("scroll", batchPreviewScrollHandler);
  }
  list.replaceChildren();
  document.querySelector("#batch-preview-count").textContent =
    translate("Preview labels count", { rows: records.length });
  dialog.showModal();

  batchPreviewScrollHandler = () => renderVisibleBatchPreviews(records, design, generation);
  list.addEventListener("scroll", batchPreviewScrollHandler, { passive: true });

  for (let start = 0; start < records.length; start += 40) {
    if (generation !== batchPreviewGeneration || !dialog.open) return;
    const fragment = document.createDocumentFragment();
    const cards = records.slice(start, start + 40).map((record, offset) => (
      createBatchPreviewCard(start + offset, record, design)
    ));
    fragment.append(...cards);
    list.append(fragment);
    renderVisibleBatchPreviews(records, design, generation);
    if (start + 40 < records.length) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
}

async function sendPrintRequest(record, design) {
  const blob = await renderPngBlob(record, design);
  const image = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error(translate("Cannot read rendered label")));
    reader.onerror = () => reject(new Error(translate("Cannot read rendered label")));
    reader.readAsDataURL(blob);
  });
  const response = await fetch("/api/print", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image,
      widthMm: design.widthMm,
      heightMm: design.heightMm,
      gapMm: design.gapMm,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    console.error("Print API error:", result.error);
    throw new Error(translate("Print failed"));
  }
  return result;
}

function confirmSafeAreaPrint() {
  if (!overflowingElementIds.length) return true;
  return window.confirm(translate("Confirm safe area", {
    count: overflowingElementIds.length,
    margin: state.safeMarginMm,
  }));
}

document.querySelector("#save-design").addEventListener("click", saveDesign);
document.querySelector("#save-draft").addEventListener("click", saveDraft);
document.querySelector("#new-design").addEventListener("click", freshDesign);
document.querySelector("#template-list").addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-user-template]");
  if (deleteButton) {
    deleteUserTemplate(deleteButton.dataset.deleteUserTemplate);
    return;
  }
  const userTemplateButton = event.target.closest("[data-user-template]");
  if (userTemplateButton) {
    chooseUserTemplate(userTemplateButton.dataset.userTemplate);
    return;
  }
  const button = event.target.closest("[data-template]");
  if (button) chooseTemplate(button.dataset.template);
});
document.querySelector("#show-save-template").addEventListener("click", () => {
  const form = document.querySelector("#save-template-form");
  form.hidden = !form.hidden;
  if (!form.hidden) document.querySelector("#template-name").focus();
});
document.querySelector("#save-template-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveCurrentTemplate();
});
document.querySelector("#new-blank-design").addEventListener("click", () => {
  if (!applyNewDesign(blankDesign())) return;
  document.querySelector("#new-design-dialog").close();
  showToast(translate("New blank label"));
});
document.querySelector("#close-new-design").addEventListener("click", () => {
  document.querySelector("#new-design-dialog").close();
});
document.querySelector("#cancel-new-design").addEventListener("click", () => {
  document.querySelector("#new-design-dialog").close();
});
document.querySelector("#open-design").addEventListener("click", () => document.querySelector("#open-file").click());
document.querySelector("#open-file").addEventListener("change", (event) => {
  openDesignFile(event.target.files[0]);
  event.target.value = "";
});
document.querySelector("#export-png").addEventListener("click", async () => {
  try {
    const blob = await renderPngBlob();
    downloadBlob(blob, "label.png");
    showToast(translate("Exported PNG"));
  } catch (error) {
    showToast(error.message, true);
  }
});
document.querySelector("#export-pdf").addEventListener("click", async () => {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast(translate("Popup blocked"), true);
    return;
  }
  try {
    const record = activeDynamicRecord();
    const design = structuredClone(state);
    const qrElements = renderedElements(record, design).filter((item) => item.type === "qr");
    await Promise.all(qrElements.map((item) => waitForQr(item)));
    const renderDesign = await embedImageSources(record, design);
    const markup = svgMarkup(record, renderDesign);
    printWindow.document.write(`<!doctype html><html><head><title>Label</title><style>@page{size:${design.widthMm}mm ${design.heightMm}mm;margin:0}html,body{margin:0;width:${design.widthMm}mm;height:${design.heightMm}mm}svg{display:block;width:${design.widthMm}mm;height:${design.heightMm}mm}</style></head><body>${markup}<script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script></body></html>`);
    printWindow.document.close();
  } catch (error) {
    printWindow.close();
    console.error("PDF export failed:", error);
    showToast(error.message || translate("Cannot read image"), true);
  }
});
document.querySelector("#print-label").addEventListener("click", async () => {
  if (batchPrinting || dynamicCsvError || (dynamicColumns().size && !activeDynamicRecord())) return;
  if (!confirmSafeAreaPrint()) return;
  const button = document.querySelector("#print-label");
  batchPrinting = true;
  button.disabled = true;
  refreshDynamicRows();
  button.querySelector("span[data-i18n]").textContent = translate("Preparing print");
  try {
    button.querySelector("span[data-i18n]").textContent = translate("Sending print job");
    const result = await sendPrintRequest(activeDynamicRecord(), structuredClone(state));
    showToast(translate("Print sent check", { port: result.port }));
  } catch (error) {
    console.error("Print failed:", error);
    showToast(translate("Cannot send print"), true);
  } finally {
    batchPrinting = false;
    button.disabled = false;
    button.innerHTML = `<i class="fa-solid fa-print" aria-hidden="true"></i> <span data-i18n="Print label">${translate("Print label")}</span>`;
    refreshDynamicRows();
    void refreshPrinterStatus();
  }
});
document.querySelector("#print-batch").addEventListener("click", async () => {
  if (dynamicCsvError || !dynamicRows.length || batchPrinting) return;
  if (!confirmSafeAreaPrint()) return;
  const records = dynamicRows.map((record) => ({ ...record }));
  if (!window.confirm(translate("Confirm batch print", { rows: records.length }))) return;

  const design = structuredClone(state);
  const progress = document.querySelector("#batch-progress");
  let currentRow = 0;
  let printerPort = "";
  batchPrinting = true;
  document.querySelector("#print-label").disabled = true;
  refreshDynamicRows();
  try {
    for (let index = 0; index < records.length; index += 1) {
      currentRow = index + 1;
      progress.textContent = translate("Batch progress", { current: currentRow, total: records.length });
      previewRowIndex = Math.min(index, dynamicRows.length - 1);
      document.querySelector("#dynamic-preview").value = String(previewRowIndex);
      renderCanvas({ refreshInspector: false });
      const result = await sendPrintRequest(records[index], design);
      printerPort = result.port;
    }
    progress.textContent = translate("Batch complete", { rows: records.length });
    showToast(translate("Batch print sent", { rows: records.length, port: printerPort }));
  } catch (error) {
    console.error(`Batch print failed at row ${currentRow}:`, error);
    progress.textContent = translate("Batch failed", { row: currentRow });
    showToast(translate("Batch print failed", { row: currentRow }), true);
  } finally {
    batchPrinting = false;
    document.querySelector("#print-label").disabled = false;
    refreshDynamicRows();
    void refreshPrinterStatus();
  }
});

const paperPrintDialog = document.querySelector("#paper-print-dialog");
const paperPrintOptions = document.querySelector("#paper-print-options");
const paperPreviewScreen = document.querySelector("#paper-preview-screen");
const paperPreviewPages = document.querySelector("#paper-preview-pages");
const paperPreviewStatus = document.querySelector("#paper-preview-status");
let paperPreviewGeneration = 0;
let paperPreviewSheets = null;
let paperPreviewLayout = null;

function showPaperPrintOptions() {
  paperPreviewGeneration += 1;
  paperPreviewSheets = null;
  paperPreviewLayout = null;
  paperPreviewPages.replaceChildren();
  paperPreviewScreen.hidden = true;
  paperPrintOptions.hidden = false;
  paperPrintDialog.classList.remove("previewing");
  document.querySelector("#confirm-paper-print").disabled = true;
  document.querySelector("#preview-paper-print").disabled =
    !dynamicRows.length || Boolean(dynamicCsvError) || batchPrinting
    || !calculatePaperLayout(document.querySelector("#paper-size").value, state);
}

document.querySelector("#print-batch-paper").addEventListener("click", () => {
  if (dynamicCsvError || !dynamicRows.length || batchPrinting) return;
  updatePaperLayoutSummary();
  showPaperPrintOptions();
  paperPrintDialog.showModal();
});
document.querySelector("#paper-size").addEventListener("change", updatePaperLayoutSummary);
document.querySelector("#close-paper-print").addEventListener("click", () => paperPrintDialog.close());
document.querySelector("#cancel-paper-print").addEventListener("click", () => paperPrintDialog.close());
paperPrintDialog.addEventListener("close", () => {
  paperPreviewGeneration += 1;
});
document.querySelector("#back-to-paper-options").addEventListener("click", showPaperPrintOptions);
document.querySelector("#back-to-paper-options-footer").addEventListener("click", showPaperPrintOptions);
document.querySelector("#paper-size").addEventListener("change", () => {
  paperPreviewGeneration += 1;
  paperPreviewSheets = null;
  paperPreviewLayout = null;
  paperPreviewPages.replaceChildren();
});
document.querySelector("#preview-paper-print").addEventListener("click", async () => {
  if (dynamicCsvError || !dynamicRows.length || batchPrinting) return;
  const paperName = document.querySelector("#paper-size").value;
  const records = dynamicRows.map((record) => ({ ...record }));
  const design = structuredClone(state);
  const layout = calculatePaperLayout(paperName, design);
  if (!layout) {
    updatePaperLayoutSummary();
    return;
  }
  const generation = ++paperPreviewGeneration;
  const previewButton = document.querySelector("#preview-paper-print");
  paperPrintOptions.hidden = true;
  paperPreviewScreen.hidden = false;
  paperPrintDialog.classList.add("previewing");
  paperPreviewPages.replaceChildren();
  paperPreviewStatus.textContent = translate("Preparing paper preview");
  previewButton.disabled = true;
  try {
    const pages = await renderPaperSheets(
      records,
      design,
      layout,
      (current, total) => {
        paperPreviewStatus.textContent = translate("Paper print progress", {
          current,
          total,
        });
      },
      () => generation !== paperPreviewGeneration,
    );
    if (!pages || generation !== paperPreviewGeneration) return;
    paperPreviewSheets = pages;
    paperPreviewLayout = layout;
    const fragment = document.createDocumentFragment();
    pages.forEach((markup, index) => {
      const sheet = document.createElement("section");
      sheet.className = "paper-preview-sheet";
      const heading = document.createElement("div");
      heading.className = "paper-preview-sheet-heading";
      heading.textContent = translate("Print page number", {
        current: index + 1,
        total: pages.length,
        paper: paperName,
      });
      const art = document.createElement("div");
      art.className = "paper-preview-art";
      art.innerHTML = markup;
      sheet.append(heading, art);
      fragment.append(sheet);
    });
    paperPreviewPages.append(fragment);
    document.querySelector("#confirm-paper-print").disabled = false;
    paperPreviewStatus.textContent = translate("Paper layout summary", {
      perPage: layout.labelsPerPage,
      pages: pages.length,
      orientation: translate(layout.landscape ? "Landscape" : "Portrait"),
    });
  } catch (error) {
    if (generation !== paperPreviewGeneration) return;
    console.error("Paper print preview failed:", error);
    paperPreviewStatus.textContent = translate("Paper preview failed");
    document.querySelector("#confirm-paper-print").disabled = true;
    showToast(translate("Paper preview failed"), true);
  } finally {
    if (generation === paperPreviewGeneration) {
      previewButton.disabled = !dynamicRows.length || Boolean(dynamicCsvError) || batchPrinting;
    }
  }
});

document.querySelector("#confirm-paper-print").addEventListener("click", async () => {
  if (dynamicCsvError || !dynamicRows.length || batchPrinting) return;
  const paperName = document.querySelector("#paper-size").value;
  const records = dynamicRows.map((record) => ({ ...record }));
  const design = structuredClone(state);
  const layout = paperPreviewLayout ?? calculatePaperLayout(paperName, design);
  if (!layout) {
    updatePaperLayoutSummary();
    return;
  }
  const pageCount = Math.ceil(records.length / layout.labelsPerPage);
  if (!window.confirm(translate("Confirm paper print", {
    labels: records.length,
    pages: pageCount,
    paper: paperName,
  }))) return;
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast(translate("Popup blocked"), true);
    return;
  }

  paperPrintDialog.close();
  batchPrinting = true;
  refreshDynamicRows();
  const progress = document.querySelector("#batch-progress");
  let currentLabel = 0;
  try {
    const pages = paperPreviewSheets ?? await renderPaperSheets(
      records,
      design,
      layout,
      (current, total) => {
        currentLabel = current;
        progress.textContent = translate("Paper print progress", { current, total });
      },
    );
    if (!pages) throw new Error("Could not generate paper print pages.");
    printWindow.document.write(paperPrintDocument(pages, layout));
    printWindow.document.close();
    progress.textContent = translate("Paper print ready", { rows: records.length });
  } catch (error) {
    printWindow.close();
    console.error(`Paper batch print failed at label ${currentLabel}:`, error);
    progress.textContent = translate("Batch failed", { row: currentLabel });
    showToast(translate("Paper print failed"), true);
  } finally {
    batchPrinting = false;
    refreshDynamicRows();
    void refreshPrinterStatus();
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveDesign();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    document.querySelector("#open-file").click();
  } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    deleteElement(selectedId);
  } else if (selectedId && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    const item = selectedElement();
    if (!item) return;
    event.preventDefault();
    const delta = event.shiftKey ? 1 : .2;
    if (event.key === "ArrowUp") item.y = Math.max(0, item.y - delta);
    if (event.key === "ArrowDown") item.y = Math.min(state.heightMm - item.h, item.y + delta);
    if (event.key === "ArrowLeft") item.x = Math.max(0, item.x - delta);
    if (event.key === "ArrowRight") item.x = Math.min(state.widthMm - item.w, item.x + delta);
    renderCanvas();
    scheduleSave();
  }
});

async function initialize() {
  applyLanguage(currentLanguage, false);
  saveStatusKey = "New design";
  updatePrinterStatus("Checking printer");
  const restoredDesign = restoreDesign();
  if (restoredDesign) saveStatusKey = "Draft loaded";
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    if (!response.ok) throw new Error(config.error ?? translate("Cannot read printer config"));
    printerConfig = config;
    printerPortText = `${config.port} · Bluetooth`;
    printerPortKey = null;
    updatePrinterStatus("Checking printer");
    document.querySelector("#printer-port").textContent = printerPortText;
    void refreshPrinterStatus();
    window.setInterval(refreshPrinterStatus, 30_000);
    if (!restoredDesign) {
      state.widthMm = config.widthMm;
      state.heightMm = config.heightMm;
      state.gapMm = config.gapMm;
    }
  } catch (error) {
    console.error("Printer configuration error:", error);
    printerPortKey = "Missing printer config";
    printerPortText = "";
    updatePrinterStatus("Missing printer config");
    document.querySelector("#printer-port").textContent = printerPortText;
    showToast(translate("Cannot read printer config"), true);
  }
  syncDimensionInputs();
  refreshDynamicRows({ syncInput: true });
  renderCanvas();
  requestAnimationFrame(fitCanvas);
}

initialize();

document.querySelector("#language-select").addEventListener("change", (event) => {
  applyLanguage(event.target.value);
  document.querySelector("#save-state").textContent = translate(saveStatusKey);
  updatePrinterStatus(printerStatusKey);
  document.querySelector("#printer-port").textContent = printerPortKey
    ? translate(printerPortKey)
    : printerPortText;
  refreshDynamicRows();
  if (templateCatalog.length) renderTemplateCards();
  renderCanvas();
});
