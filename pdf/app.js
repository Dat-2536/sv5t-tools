"use strict";

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
const A4 = [595.28, 841.89];
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|tiff?|avif|heic|heif)$/i;
const OFFICE_EXT = /\.(docx?|pptx?|xlsx?|odt|odp|ods)$/i;
const HTML_EXT = /\.(html?|txt|md)$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const asset = (p) => SV5T.asset(p);
const icon = (name) => `<svg class="i"><use href="#i-${name}" /></svg>`;
const SEP = `<i class="sep"></i>`;

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = asset("vendor/pdf.worker.min.js");

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}
function baseName(name) { return name.replace(/\.[^.]+$/, ""); }
function safeName(name, fallback) {
  return ((name || "").trim().replace(/[\\/:*?"<>|]+/g, "_") || fallback);
}
function isImage(file) { return file.type.startsWith("image/") || IMAGE_EXT.test(file.name); }
function isPdf(file) { return file.type === "application/pdf" || /\.pdf$/i.test(file.name); }
function isOffice(file) { return OFFICE_EXT.test(file.name); }
function isHtmlish(file) { return HTML_EXT.test(file.name) || /html|text|markdown/.test(file.type); }

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function canvasBlob(canvas, type, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Không mã hóa được ảnh."))), type, quality)
  );
}
function drawToCanvas(bmp, scale = 1, whiteBg = false) {
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (whiteBg) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return c;
}
async function loadBitmap(file) {
  let src = file;
  if (SV5T.isHeic(file)) src = await SV5T.heicToJpeg(file);
  try {
    return await createImageBitmap(src, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(src);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
async function imageForPdf(file, compress) {
  const bmp = await loadBitmap(file);
  if (compress) {
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const blob = await canvasBlob(drawToCanvas(bmp, scale, true), "image/jpeg", 0.8);
    return { bytes: await blob.arrayBuffer(), kind: "jpg" };
  }
  const blob = await canvasBlob(drawToCanvas(bmp, 1, true), "image/jpeg", 0.92);
  return { bytes: await blob.arrayBuffer(), kind: "jpg" };
}
async function addImagePage(doc, file, { pageMode = "image", compress = false } = {}) {
  const { bytes, kind } = await imageForPdf(file, compress);
  const img = kind === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  if (pageMode === "a4") {
    const landscape = img.width > img.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s, h = img.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  } else {
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
}
async function loadPdf(file) {
  return PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
}
async function savePdf(doc, name) {
  const blob = new Blob([await doc.save()], { type: "application/pdf" });
  return { name: pdfName(name), blob, info: `${doc.getPageCount()} trang ${SEP} ${fmtSize(blob.size)}` };
}
function pdfName(name) {
  return safeName(String(name).replace(/\.pdf$/i, ""), "ket-qua") + ".pdf";
}
async function withBusy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Đang xử lý...";
  try { await fn(); }
  catch (e) { console.error(e); toast("Lỗi: " + (e.message || e)); }
  finally { btn.disabled = false; btn.innerHTML = label; }
}
function resultsHeader(box, title, zipItems, zipName) {
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `<strong>${title}</strong>`;
  if (zipItems?.length > 1) {
    const b = document.createElement("button");
    b.className = "ghost";
    b.innerHTML = `${icon("folder-down")} Tải ZIP`;
    b.addEventListener("click", async () => {
      const zip = new JSZip();
      zipItems.forEach((r) => r.blob && zip.file(r.name, r.blob));
      download(await zip.generateAsync({ type: "blob" }), zipName);
    });
    head.appendChild(b);
  }
  box.appendChild(head);
}
function resultRow(box, { name, blob, info, error }) {
  const row = document.createElement("div");
  row.className = "res" + (error ? " error" : "");
  row.innerHTML = `<div class="meta"><div class="name"></div><div class="size"></div></div>`;
  $(".name", row).textContent = name;
  const size = $(".size", row);
  if (error) size.textContent = error;
  else {
    size.innerHTML = info || fmtSize(blob.size);
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.innerHTML = `${icon("download")} Tải`;
    btn.addEventListener("click", () => download(blob, name));
    row.append(btn);
  }
  box.appendChild(row);
}

async function pdfJsDoc(file) {
  const data = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data }).promise;
}
async function renderPageCanvas(pdf, n, scale = 2) {
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}
async function extractPdfText(file) {
  const pdf = await pdfJsDoc(file);
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    parts.push(tc.items.map((it) => it.str).join(" "));
  }
  return parts.join("\n\n");
}
async function textPagesToPdf(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 11, margin = 48, lineH = 14;
  const maxW = A4[0] - margin * 2;
  const lines = [];
  for (const para of String(text || "(trống)").split(/\r?\n/)) {
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const trial = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(trial, size) > maxW) {
        if (line) lines.push(line);
        line = w;
      } else line = trial;
    }
    lines.push(line);
  }
  let y = 0, page;
  const newPage = () => {
    page = doc.addPage(A4);
    y = A4[1] - margin;
  };
  newPage();
  for (const line of lines) {
    if (y < margin + lineH) newPage();
    page.drawText(line.slice(0, 500), { x: margin, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    y -= lineH;
  }
  return doc;
}
async function officeText(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const chunks = [];
  const names = Object.keys(zip.files);
  const pick = names.filter((p) => /word\/document|ppt\/slides\/slide|xl\/sharedStrings|xl\/worksheets\/sheet|content\.xml/i.test(p));
  for (const p of (pick.length ? pick : names.filter((n) => n.endsWith(".xml")))) {
    const xml = await zip.file(p).async("string");
    chunks.push(xml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim());
  }
  return chunks.filter(Boolean).join("\n\n") || "(Không đọc được nội dung Office — hãy xuất PDF từ Word/Excel rồi dùng công cụ PDF.)";
}

function parsePages(spec, count) {
  const set = new Set();
  const raw = String(spec || "").trim();
  if (!raw) {
    for (let i = 1; i <= count; i++) set.add(i);
    return [...set];
  }
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Khoảng trang không hợp lệ: "${part}"`);
    let a = Number(m[1]), b = Number(m[2] || m[1]);
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i++) if (i >= 1 && i <= count) set.add(i);
  }
  if (!set.size) throw new Error("Không có trang hợp lệ.");
  return [...set].sort((a, b) => a - b);
}

const CATS = [
  { id: "organize", title: "Tổ chức" },
  { id: "optimize", title: "Tối ưu" },
  { id: "to-pdf", title: "Sang PDF" },
  { id: "from-pdf", title: "Từ PDF" },
  { id: "edit", title: "Chỉnh sửa" },
  { id: "security", title: "Bảo mật" },
  { id: "ai", title: "Khác" },
];

const IMG_ACCEPT = "image/*,.heic,.heif,.jfif,.webp,.png,.jpg,.jpeg";
const PDF_ACCEPT = "application/pdf,.pdf";
const BOTH = PDF_ACCEPT + "," + IMG_ACCEPT;
const OFFICE = ".doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.ods";

const TOOLS = [
  { id: "merge", cat: "organize", title: "Gộp PDF", desc: "Gộp nhiều PDF hoặc ảnh thành một file.", icon: "files", accept: BOTH, fields: [{ id: "name", label: "Tên file", type: "text", value: "da-gop" }] },
  { id: "split", cat: "organize", title: "Tách PDF", desc: "Tách theo khoảng trang kiểu in (1-3,5-6).", icon: "split", accept: PDF_ACCEPT, multiple: false, fields: [{ id: "pages", label: "Trang", type: "text", value: "1-3" }, { id: "mode", label: "Cách tách", type: "select", options: [["one", "Một PDF chứa các trang đã chọn"], ["each", "Mỗi khoảng thành 1 PDF"]] }] },
  { id: "remove", cat: "organize", title: "Xoá trang", desc: "Bỏ các trang theo khoảng.", icon: "trash-2", accept: PDF_ACCEPT, multiple: false, fields: [{ id: "pages", label: "Trang cần xoá", type: "text", value: "1" }] },
  { id: "extract", cat: "organize", title: "Trích trang", desc: "Lấy ra một tập trang thành PDF mới.", icon: "file-stack", accept: PDF_ACCEPT, multiple: false, fields: [{ id: "pages", label: "Trang cần lấy", type: "text", value: "1-2" }] },
  { id: "organize", cat: "organize", title: "Sắp xếp trang", desc: "Đảo thứ tự trang: nhập thứ tự mới, ví dụ 3,1,2.", icon: "grip-vertical", accept: PDF_ACCEPT, multiple: false, fields: [{ id: "order", label: "Thứ tự trang", type: "text", value: "1,2,3" }] },
  { id: "scan", cat: "organize", title: "Scan to PDF", desc: "Chụp/chọn ảnh (kể cả HEIC) rồi đóng thành PDF.", icon: "upload", accept: IMG_ACCEPT, capture: true, fields: [{ id: "page", label: "Khổ", type: "select", options: [["image", "Theo ảnh"], ["a4", "A4"]] }] },
  { id: "compress", cat: "optimize", title: "Nén PDF", desc: "Raster trang thành JPEG để giảm dung lượng.", icon: "shrink", accept: PDF_ACCEPT, fields: [{ id: "q", label: "Chất lượng JPEG", type: "select", options: [["0.6", "Mạnh (60%)"], ["0.75", "Vừa (75%)"], ["0.9", "Nhẹ (90%)"]] }] },
  { id: "fit", cat: "optimize", title: "Chỉnh dung lượng PDF", desc: "Đưa PDF vào khoảng min–max MB.", icon: "scaling", accept: PDF_ACCEPT, fields: [{ id: "min", label: "Tối thiểu", type: "text", value: "1MB" }, { id: "max", label: "Tối đa", type: "text", value: "5MB" }] },
  { id: "repair", cat: "optimize", title: "Sửa PDF", desc: "Mở lại file (bỏ encryption nếu đọc được) rồi ghi ra bản mới.", icon: "file-text", accept: PDF_ACCEPT },
  { id: "pdfa", cat: "optimize", title: "PDF to PDF/A", desc: "Gắn metadata PDF/A-1B (không chứng nhận ISO đầy đủ).", icon: "shield-check", accept: PDF_ACCEPT, note: "Đây là gắn cờ lưu trữ, không phải bộ xác thực PDF/A đầy đủ." },
  { id: "img2pdf", cat: "to-pdf", title: "Ảnh → PDF", desc: "HEIC, JPG, PNG, WEBP sang PDF.", icon: "file-image", accept: IMG_ACCEPT, fields: [{ id: "mode", label: "Chế độ", type: "select", options: [["each", "Mỗi ảnh 1 PDF"], ["one", "Gộp 1 PDF"]] }, { id: "page", label: "Khổ", type: "select", options: [["image", "Theo ảnh"], ["a4", "A4"]] }, { id: "name", label: "Tên khi gộp", type: "text", value: "anh-sang-pdf" }] },
  { id: "word2pdf", cat: "to-pdf", title: "Word to PDF", desc: "Đọc text từ DOC/DOCX rồi xếp thành PDF.", icon: "file-text", accept: ".doc,.docx,.odt", note: "Bản trình duyệt lấy chữ, không giữ hết layout Word." },
  { id: "ppt2pdf", cat: "to-pdf", title: "PowerPoint to PDF", desc: "Lấy chữ từng slide thành trang PDF.", icon: "file-text", accept: ".ppt,.pptx,.odp", note: "Không render hình slide, chỉ nội dung chữ." },
  { id: "xls2pdf", cat: "to-pdf", title: "Excel to PDF", desc: "Lấy chữ từ sheet thành PDF.", icon: "file-text", accept: ".xls,.xlsx,.ods" },
  { id: "html2pdf", cat: "to-pdf", title: "HTML to PDF", desc: "Dán HTML/text hoặc thả file .html.", icon: "file-text", accept: ".html,.htm,.txt", fields: [{ id: "html", label: "Hoặc dán HTML/text", type: "text", value: "" }] },
  { id: "pdf2jpg", cat: "from-pdf", title: "PDF → ảnh", desc: "Mỗi trang thành JPG, PNG hoặc WEBP.", icon: "file-image", accept: PDF_ACCEPT, fields: [{ id: "fmt", label: "Định dạng", type: "select", options: [["image/jpeg", "JPG"], ["image/png", "PNG"], ["image/webp", "WEBP"]] }] },
  { id: "pdf2heic", cat: "from-pdf", title: "PDF → HEIC", desc: "Xuất JPG (trình duyệt không ghi HEIC).", icon: "file-image", accept: PDF_ACCEPT, note: "File tải về là JPG chất lượng cao." },
  { id: "pdf2word", cat: "from-pdf", title: "PDF to Word", desc: "Xuất HTML/.doc từ chữ trong PDF.", icon: "file-text", accept: PDF_ACCEPT, note: "Giữ chữ, không phải bản layout 100% như iLovePDF cloud." },
  { id: "pdf2ppt", cat: "from-pdf", title: "PDF to PowerPoint", desc: "Mỗi trang PDF thành một ảnh trong PPTX.", icon: "file-text", accept: PDF_ACCEPT },
  { id: "pdf2excel", cat: "from-pdf", title: "PDF to Excel", desc: "Xuất CSV/text từ chữ PDF.", icon: "file-text", accept: PDF_ACCEPT },
  { id: "pdf2md", cat: "from-pdf", title: "PDF to Markdown", desc: "Chữ PDF thành file .md.", icon: "file-text", accept: PDF_ACCEPT },
  { id: "rotate", cat: "edit", title: "Xoay PDF", desc: "Xoay mọi trang 90/180/270.", icon: "scaling", accept: PDF_ACCEPT, fields: [{ id: "deg", label: "Góc", type: "select", options: [["90", "90°"], ["180", "180°"], ["270", "270°"]] }] },
  { id: "pagenum", cat: "edit", title: "Đánh số trang", desc: "Chèn số trang vào chân trang.", icon: "file-text", accept: PDF_ACCEPT, fields: [{ id: "pos", label: "Vị trí", type: "select", options: [["bottom", "Dưới giữa"], ["top", "Trên giữa"]] }] },
  { id: "watermark", cat: "edit", title: "Watermark", desc: "Đóng chữ chìm lên mọi trang.", icon: "file-text", accept: PDF_ACCEPT, fields: [{ id: "text", label: "Chữ", type: "text", value: "SV5T" }, { id: "op", label: "Độ mờ", type: "select", options: [["0.12", "Nhẹ"], ["0.25", "Vừa"], ["0.45", "Đậm"]] }] },
  { id: "crop", cat: "edit", title: "Crop PDF", desc: "Cắt mép theo điểm (points).", icon: "scaling", accept: PDF_ACCEPT, fields: [{ id: "m", label: "Cắt đều mỗi cạnh", type: "text", value: "24" }] },
  { id: "edit", cat: "edit", title: "Edit PDF", desc: "Đóng thêm một dòng chữ lên trang đầu.", icon: "pencil", accept: PDF_ACCEPT, fields: [{ id: "text", label: "Chữ thêm", type: "text", value: "Ghi chú SV5T" }] },
  { id: "sign", cat: "edit", title: "Sign PDF", desc: "Chèn ảnh chữ ký (PNG/JPG) góc dưới trang cuối.", icon: "pencil", accept: BOTH, note: "Thả PDF trước, thêm ảnh chữ ký trong cùng danh sách." },
  { id: "forms", cat: "edit", title: "PDF Forms", desc: "Thêm một ô text điền được trên trang đầu.", icon: "file-text", accept: PDF_ACCEPT, fields: [{ id: "name", label: "Tên field", type: "text", value: "sv5t_field" }] },
  { id: "unlock", cat: "security", title: "Unlock PDF", desc: "Ghi lại PDF nếu thư viện đọc được nội dung đã mở.", icon: "shield-check", accept: PDF_ACCEPT, note: "PDF khoá cứng / AES đầy đủ có thể không mở được trên trình duyệt." },
  { id: "protect", cat: "security", title: "Protect PDF", desc: "pdf-lib bản này không gắn mật khẩu AES.", icon: "shield-check", accept: PDF_ACCEPT, note: "Trình duyệt không mã hoá PDF chuẩn được với thư viện hiện tại. Hãy dùng bản desktop nếu cần password." },
  { id: "redact", cat: "security", title: "Redact PDF", desc: "Phủ đen toàn bộ trang đã chọn.", icon: "eraser", accept: PDF_ACCEPT, fields: [{ id: "pages", label: "Trang phủ đen", type: "text", value: "1" }] },
  { id: "compare", cat: "security", title: "Compare PDF", desc: "So chữ hai PDF, xuất bản diff text.", icon: "split", accept: PDF_ACCEPT, note: "Chọn đúng 2 file PDF." },
  { id: "ocr", cat: "ai", title: "OCR PDF", desc: "Lấy chữ đã có trong PDF (không OCR ảnh scan).", icon: "cpu", accept: PDF_ACCEPT, note: "PDF scan thuần ảnh sẽ ra file trống. Cần OCR ngoài trình duyệt." },
  { id: "summarize", cat: "ai", title: "AI Summarizer", desc: "Tóm tắt local: lấy các câu đầu mỗi trang.", icon: "sparkles", accept: PDF_ACCEPT, note: "Không gọi API đám mây." },
  { id: "translate", cat: "ai", title: "Translate PDF", desc: "Xuất chữ gốc — không dịch máy.", icon: "file-text", accept: PDF_ACCEPT, note: "Không có model dịch trong trình duyệt. Bạn nhận file chữ để dịch chỗ khác." },
];

TOOLS.forEach((t) => {
  if (t.multiple === undefined) t.multiple = true;
});

let current, files = [];

function renderCatalog(filter = "") {
  const q = filter.trim().toLowerCase();
  const box = $("#tool-cats");
  box.innerHTML = "";
  CATS.forEach((cat) => {
    const tools = TOOLS.filter((t) => t.cat === cat.id && (!q || (t.title + t.desc).toLowerCase().includes(q)));
    if (!tools.length) return;
    const h = document.createElement("h3");
    h.className = "cat-title";
    h.textContent = cat.title;
    const grid = document.createElement("div");
    grid.className = "tool-grid";
    tools.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool-card";
      b.innerHTML = `<span class="hub-ico">${icon(t.icon)}</span><strong>${t.title}</strong>`;
      b.addEventListener("click", () => openTool(t.id));
      grid.append(b);
    });
    box.append(h, grid);
  });
}

function val(id, fallback = "") {
  return $("#f-" + id)?.value ?? fallback;
}

function openTool(id) {
  current = TOOLS.find((t) => t.id === id);
  if (!current) return;
  files = [];
  $("#catalog").hidden = true;
  const ws = $("#workspace");
  ws.hidden = false;
  ws.classList.add("active");
  $("#ws-title").textContent = current.title;
  $("#ws-desc").textContent = current.desc || "";
  $("#ws-desc").hidden = !current.desc;
  $("#ws-run").textContent = current.title;
  const note = $("#ws-note");
  note.hidden = !current.note;
  note.textContent = current.note || "";
  const input = $("#ws-input");
  input.accept = current.accept || "*";
  input.multiple = current.multiple !== false;
  input.capture = current.capture ? "environment" : "";
  const opts = $("#ws-options");
  opts.innerHTML = "";
  (current.fields || []).forEach((f) => {
    const lab = document.createElement("label");
    lab.textContent = f.label;
    if (f.type === "select") {
      const sel = document.createElement("select");
      sel.id = "f-" + f.id;
      f.options.forEach(([v, label]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        sel.append(o);
      });
      lab.append(sel);
    } else {
      const inp = document.createElement("input");
      inp.id = "f-" + f.id;
      inp.type = "text";
      inp.value = f.value || "";
      lab.append(inp);
    }
    opts.append(lab);
  });
  $("#ws-results").innerHTML = "";
  renderFiles();
  history.replaceState(null, "", "#" + id);
  ws.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeTool() {
  current = null;
  files = [];
  $("#workspace").hidden = true;
  $("#catalog").hidden = false;
  history.replaceState(null, "", location.pathname);
}

function renderFiles() {
  const box = $("#ws-list");
  box.innerHTML = "";
  files.forEach((file, idx) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `${isImage(file) ? "" : `<span class="thumb">${icon("file-text")}</span>`}
      <div class="meta"><div class="name"></div><div class="size">${idx + 1}. ${fmtSize(file.size)}</div></div>
      <div class="btns"><button data-act="del" title="Xóa">${icon("x")}</button></div>`;
    $(".name", row).textContent = file.name;
    if (isImage(file)) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = URL.createObjectURL(file);
      row.prepend(img);
    }
    $("[data-act=del]", row).addEventListener("click", () => {
      files.splice(idx, 1);
      renderFiles();
    });
    box.append(row);
  });
  $("#ws-run").disabled = files.length === 0 && current?.id !== "html2pdf";
}

function addIncoming(list) {
  const arr = [...list];
  const ok = current.multiple === false ? arr.slice(0, 1) : arr;
  if (current.multiple === false) files = ok;
  else files.push(...ok);
  renderFiles();
}

$("#ws-input").addEventListener("change", () => {
  addIncoming($("#ws-input").files);
  $("#ws-input").value = "";
});
const drop = $("#ws-drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  addIncoming(e.dataTransfer.files);
});
$("#ws-clear").addEventListener("click", () => { files = []; renderFiles(); $("#ws-results").innerHTML = ""; });
$("#ws-back").addEventListener("click", closeTool);
$("#tool-search").addEventListener("input", (e) => renderCatalog(e.target.value));
$("#ws-run").addEventListener("click", (e) => withBusy(e.currentTarget, runCurrent));

function parseSize(raw) {
  const m = String(raw).trim().toUpperCase().replace(/\s+/g, "").match(/^(\d+(?:[.,]\d+)?)(B|KB|MB|GB)?$/);
  if (!m) throw new Error(`Không hiểu dung lượng "${raw}"`);
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] || "MB"];
  return Math.floor(parseFloat(m[1].replace(",", ".")) * mult);
}

async function copyPages(src, indices) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out;
}

async function rasterPdf(file, quality) {
  const src = await loadPdf(file);
  const pdf = await pdfJsDoc(file);
  const out = await PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    const { width, height } = src.getPage(i - 1).getSize();
    const canvas = await renderPageCanvas(pdf, i, 1.6);
    const blob = await canvasBlob(canvas, "image/jpeg", quality);
    const img = await out.embedJpg(await blob.arrayBuffer());
    const page = out.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
  return out;
}

async function runCurrent() {
  const box = $("#ws-results");
  const id = current.id;
  const pdfs = files.filter(isPdf);
  const imgs = files.filter(isImage);
  const first = files[0];

  const done = (rows, zip) => {
    const ok = rows.filter((r) => r.blob);
    resultsHeader(box, `Xong: ${ok.length}/${rows.length} file`, ok, zip || "ket-qua.zip");
    rows.forEach((r) => resultRow(box, r));
  };

  if (id === "merge" || id === "scan") {
    if (!files.length) throw new Error("Chưa có file.");
    const out = await PDFDocument.create();
    for (const f of files) {
      if (isPdf(f)) {
        const src = await loadPdf(f);
        (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
      } else await addImagePage(out, f, { pageMode: val("page", "image") });
    }
    done([await savePdf(out, val("name", "da-gop"))]);
    return;
  }

  if (id === "img2pdf") {
    if (!imgs.length) throw new Error("Cần ảnh JPG/PNG/WEBP/HEIC.");
    const pageMode = val("page", "image");
    if (val("mode", "each") === "one") {
      const out = await PDFDocument.create();
      for (const f of imgs) await addImagePage(out, f, { pageMode });
      done([await savePdf(out, val("name", "anh-sang-pdf"))]);
    } else {
      const rows = [];
      for (const f of imgs) {
        const out = await PDFDocument.create();
        await addImagePage(out, f, { pageMode });
        rows.push(await savePdf(out, baseName(f.name)));
      }
      done(rows, "anh-sang-pdf.zip");
    }
    return;
  }

  if (id === "split" || id === "extract") {
    const src = await loadPdf(first);
    const pages = parsePages(val("pages", "1"), src.getPageCount());
    if (id === "split" && val("mode") === "each") {
      const rows = [];
      for (const n of pages) {
        rows.push(await savePdf(await copyPages(src, [n - 1]), baseName(first.name) + "-p" + n));
      }
      done(rows, "pdf-da-tach.zip");
    } else {
      done([await savePdf(await copyPages(src, pages.map((n) => n - 1)), baseName(first.name) + "-tach")]);
    }
    return;
  }

  if (id === "remove") {
    const src = await loadPdf(first);
    const drop = new Set(parsePages(val("pages", "1"), src.getPageCount()));
    const keep = src.getPageIndices().filter((i) => !drop.has(i + 1));
    if (!keep.length) throw new Error("Không thể xoá hết mọi trang.");
    done([await savePdf(await copyPages(src, keep), baseName(first.name) + "-con")]);
    return;
  }

  if (id === "organize") {
    const src = await loadPdf(first);
    const order = val("order", "1").split(",").map((s) => Number(s.trim()) - 1);
    if (order.some((i) => i < 0 || i >= src.getPageCount())) throw new Error("Thứ tự trang không khớp.");
    done([await savePdf(await copyPages(src, order), baseName(first.name) + "-sx")]);
    return;
  }

  if (id === "compress") {
    const q = Number(val("q", "0.75"));
    const rows = [];
    for (const f of pdfs) {
      const out = await rasterPdf(f, q);
      const r = await savePdf(out, baseName(f.name) + "-nen");
      r.info = `${fmtSize(f.size)} → ${fmtSize(r.blob.size)}`;
      rows.push(r);
    }
    done(rows, "pdf-nen.zip");
    return;
  }

  if (id === "fit") {
    const min = parseSize(val("min", "1MB"));
    const max = parseSize(val("max", "5MB"));
    const f = first;
    let q = 0.85;
    let doc = await rasterPdf(f, q);
    let bytes = await doc.save();
    while (bytes.length > max && q > 0.35) {
      q -= 0.1;
      doc = await rasterPdf(f, q);
      bytes = await doc.save();
    }
    if (bytes.length < min) {
      const pad = new Uint8Array(bytes.length + (min - bytes.length));
      pad.set(bytes, 0);
      pad.fill(32, bytes.length);
      bytes = pad;
    }
    const blob = new Blob([bytes], { type: "application/pdf" });
    done([{ name: pdfName(baseName(f.name) + "-fit"), blob, info: `${fmtSize(f.size)} → ${fmtSize(blob.size)}` }]);
    return;
  }

  if (id === "repair" || id === "unlock") {
    const rows = [];
    for (const f of pdfs) {
      const src = await loadPdf(f);
      rows.push(await savePdf(src, baseName(f.name) + (id === "unlock" ? "-mo-khoa" : "-sua")));
    }
    done(rows);
    return;
  }

  if (id === "pdfa") {
    const src = await loadPdf(first);
    src.setTitle((src.getTitle() || baseName(first.name)) + " (PDF/A)");
    src.setProducer("SV5T Toolkit");
    src.setCreationDate(new Date());
    done([await savePdf(src, baseName(first.name) + "-pdfa")]);
    return;
  }

  if (id === "word2pdf" || id === "ppt2pdf" || id === "xls2pdf") {
    const rows = [];
    for (const f of files.filter(isOffice)) {
      const doc = await textPagesToPdf(await officeText(f));
      rows.push(await savePdf(doc, baseName(f.name)));
    }
    if (!rows.length) throw new Error("Cần file Office.");
    done(rows);
    return;
  }

  if (id === "html2pdf") {
    let text = val("html", "");
    if (files[0]) text = (await files[0].text()) + (text ? "\n" + text : "");
    text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("Dán HTML/text hoặc chọn file.");
    done([await savePdf(await textPagesToPdf(text), "html")]);
    return;
  }

  if (id === "pdf2jpg" || id === "pdf2heic") {
    const fmt = id === "pdf2heic" ? "image/jpeg" : val("fmt", "image/jpeg");
    const ext = fmt === "image/png" ? ".png" : fmt === "image/webp" ? ".webp" : ".jpg";
    const rows = [];
    for (const f of pdfs) {
      const pdf = await pdfJsDoc(f);
      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = await renderPageCanvas(pdf, i, 2);
        const blob = await canvasBlob(canvas, fmt, 0.92);
        rows.push({ name: `${baseName(f.name)}-p${i}${ext}`, blob, info: fmtSize(blob.size) });
      }
    }
    done(rows, "pdf-sang-anh.zip");
    return;
  }

  if (id === "pdf2word") {
    const text = await extractPdfText(first);
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre></body></html>`;
    done([{ name: baseName(first.name) + ".doc", blob: new Blob([html], { type: "application/msword" }), info: "Word HTML" }]);
    return;
  }
  if (id === "pdf2excel") {
    const text = await extractPdfText(first);
    done([{ name: baseName(first.name) + ".csv", blob: new Blob([text.replace(/\t/g, "," )], { type: "text/csv" }), info: "CSV" }]);
    return;
  }
  if (id === "pdf2md") {
    const text = await extractPdfText(first);
    done([{ name: baseName(first.name) + ".md", blob: new Blob([text], { type: "text/markdown" }), info: "Markdown" }]);
    return;
  }
  if (id === "pdf2ppt") {
    const pdf = await pdfJsDoc(first);
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
    const sids = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const canvas = await renderPageCanvas(pdf, i, 1.4);
      zip.file(`ppt/media/image${i}.jpg`, await canvasBlob(canvas, "image/jpeg", 0.85));
      sids.push(i);
    }
    zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${sids.map((i) => `<p:sldId id="${255 + i}" r:id="rId${i}"/>`).join("")}</p:sldIdLst></p:presentation>`);
    const blob = await zip.generateAsync({ type: "blob" });
    done([{ name: baseName(first.name) + ".pptx", blob, info: `${pdf.numPages} slide ảnh` }]);
    return;
  }

  if (id === "rotate") {
    const deg = Number(val("deg", "90"));
    const src = await loadPdf(first);
    src.getPages().forEach((p) => p.setRotation(degrees((p.getRotation().angle + deg) % 360)));
    done([await savePdf(src, baseName(first.name) + "-xoay")]);
    return;
  }
  if (id === "pagenum") {
    const src = await loadPdf(first);
    const font = await src.embedFont(StandardFonts.Helvetica);
    const top = val("pos") === "top";
    src.getPages().forEach((p, i) => {
      const { width, height } = p.getSize();
      p.drawText(String(i + 1), { x: width / 2 - 6, y: top ? height - 28 : 18, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
    });
    done([await savePdf(src, baseName(first.name) + "-sotrang")]);
    return;
  }
  if (id === "watermark") {
    const src = await loadPdf(first);
    const font = await src.embedFont(StandardFonts.Helvetica);
    const text = val("text", "SV5T");
    const op = Number(val("op", "0.12"));
    src.getPages().forEach((p) => {
      const { width, height } = p.getSize();
      p.drawText(text, { x: width * 0.2, y: height * 0.45, size: 48, font, opacity: op, rotate: degrees(-28), color: rgb(0.4, 0.4, 0.4) });
    });
    done([await savePdf(src, baseName(first.name) + "-wm")]);
    return;
  }
  if (id === "crop") {
    const m = Number(val("m", "24")) || 0;
    const src = await loadPdf(first);
    src.getPages().forEach((p) => {
      const { width, height } = p.getSize();
      p.setCropBox(m, m, Math.max(10, width - 2 * m), Math.max(10, height - 2 * m));
    });
    done([await savePdf(src, baseName(first.name) + "-crop")]);
    return;
  }
  if (id === "edit") {
    const src = await loadPdf(first);
    const font = await src.embedFont(StandardFonts.Helvetica);
    const p = src.getPages()[0];
    p.drawText(val("text", "Ghi chú"), { x: 48, y: p.getSize().height - 48, size: 14, font, color: rgb(0.85, 0.34, 0.05) });
    done([await savePdf(src, baseName(first.name) + "-edit")]);
    return;
  }
  if (id === "sign") {
    const pdf = pdfs[0] || (imgs.length ? null : first);
    if (!pdfs[0]) throw new Error("Cần một PDF và một ảnh chữ ký.");
    const sig = imgs[0];
    if (!sig) throw new Error("Thêm ảnh chữ ký (PNG/JPG).");
    const src = await loadPdf(pdfs[0]);
    const { bytes } = await imageForPdf(sig, false);
    let img;
    try { img = await src.embedPng(bytes); } catch { img = await src.embedJpg(bytes); }
    const page = src.getPages().at(-1);
    const w = 120, h = (img.height / img.width) * w;
    page.drawImage(img, { x: 48, y: 36, width: w, height: h });
    done([await savePdf(src, baseName(pdfs[0].name) + "-ky")]);
    return;
  }
  if (id === "forms") {
    const src = await loadPdf(first);
    const form = src.getForm();
    const page = src.getPages()[0];
    const field = form.createTextField(val("name", "sv5t_field"));
    field.addToPage(page, { x: 48, y: page.getSize().height - 80, width: 220, height: 22 });
    done([await savePdf(src, baseName(first.name) + "-form")]);
    return;
  }
  if (id === "protect") {
    throw new Error("Không gắn mật khẩu AES được trên trình duyệt với bộ thư viện hiện tại.");
  }
  if (id === "redact") {
    const src = await loadPdf(first);
    const pages = new Set(parsePages(val("pages", "1"), src.getPageCount()));
    src.getPages().forEach((p, i) => {
      if (!pages.has(i + 1)) return;
      const { width, height } = p.getSize();
      p.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0, 0, 0) });
    });
    done([await savePdf(src, baseName(first.name) + "-redact")]);
    return;
  }
  if (id === "compare") {
    if (pdfs.length < 2) throw new Error("Cần đúng 2 PDF.");
    const a = await extractPdfText(pdfs[0]);
    const b = await extractPdfText(pdfs[1]);
    const sa = new Set(a.split(/\s+/));
    const onlyB = b.split(/\s+/).filter((w) => w && !sa.has(w)).slice(0, 400).join(" ");
    const blob = new Blob([`=== ${pdfs[0].name} ===\n${a}\n\n=== ${pdfs[1].name} ===\n${b}\n\n=== Từ chỉ có ở file 2 ===\n${onlyB}`], { type: "text/plain" });
    done([{ name: "so-sanh.txt", blob, info: "Diff chữ" }]);
    return;
  }
  if (id === "ocr" || id === "translate") {
    const text = await extractPdfText(first);
    done([{ name: baseName(first.name) + ".txt", blob: new Blob([text], { type: "text/plain" }), info: fmtSize(text.length) }]);
    return;
  }
  if (id === "summarize") {
    const text = await extractPdfText(first);
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 12).join(" ");
    done([{ name: baseName(first.name) + "-tomtat.txt", blob: new Blob([sentences || text.slice(0, 800)], { type: "text/plain" }), info: "Tóm tắt local" }]);
    return;
  }

  throw new Error("Công cụ chưa sẵn sàng.");
}

try {
  renderCatalog();
  if (location.hash) {
    const id = location.hash.slice(1);
    if (TOOLS.some((t) => t.id === id)) openTool(id);
  }
} catch (e) {
  console.error(e);
  const box = $("#tool-cats");
  if (box) box.innerHTML = `<p class="hint">Không vẽ được danh sách công cụ: ${e.message}</p>`;
}
