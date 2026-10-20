"use strict";

const { PDFDocument } = PDFLib;
const A4 = [595.28, 841.89];
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|tiff?|avif|heic|heif)$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const asset = (path) => (window.SV5T ? SV5T.asset(path) : path);
function bind(sel, ev, fn) {
  const el = $(sel);
  if (el) el.addEventListener(ev, fn);
}

const icon = (name) => `<svg class="i"><use href="#i-${name}" /></svg>`;
const SEP = `<i class="sep"></i>`;
const ARROW = icon("arrow-right");
const warn = (text) => `<span class="warn">${icon("triangle-alert")} ${text}</span>`;

// ---------- helpers ----------

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

function safeName(name, fallback) {
  const s = (name || "").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return s || fallback;
}

function isImage(file) {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

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

/** Reads the EXIF orientation of a JPEG (1 = normal). */
function jpegOrientation(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      const n = v.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little);
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return 1;
}

async function loadBitmap(file) {
  let src = file;
  if (window.SV5T?.isHeic?.(file)) src = await SV5T.heicToJpeg(file);
  try {
    return await createImageBitmap(src, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(src);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error("Trình duyệt không đọc được ảnh này.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
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

function canvasBlob(canvas, type, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Không mã hóa được ảnh."))), type, quality)
  );
}

/** Returns { bytes, kind: "jpg" | "png" } ready for pdf-lib. */
async function imageForPdf(file, compress) {
  const isJpeg = /jpe?g|jfif/i.test(file.type) || /\.(jpe?g|jfif)$/i.test(file.name);
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);

  if (!compress) {
    const buf = await file.arrayBuffer();
    if (isJpeg && jpegOrientation(buf) === 1) return { bytes: buf, kind: "jpg" };
    if (isPng) return { bytes: buf, kind: "png" };
  }

  const bmp = await loadBitmap(file);
  if (compress) {
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const blob = await canvasBlob(drawToCanvas(bmp, scale, true), "image/jpeg", 0.8);
    return { bytes: await blob.arrayBuffer(), kind: "jpg" };
  }
  if (isJpeg) {
    const blob = await canvasBlob(drawToCanvas(bmp, 1, true), "image/jpeg", 0.92);
    return { bytes: await blob.arrayBuffer(), kind: "jpg" };
  }
  const blob = await canvasBlob(drawToCanvas(bmp), "image/png");
  return { bytes: await blob.arrayBuffer(), kind: "png" };
}

async function addImagePage(doc, file, { pageMode = "image", compress = false } = {}) {
  const { bytes, kind } = await imageForPdf(file, compress);
  let img;
  try {
    img = kind === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch {
    // Some exotic PNG/JPEG variants trip pdf-lib; re-encode through canvas.
    const bmp = await loadBitmap(file);
    const blob = await canvasBlob(drawToCanvas(bmp), "image/png");
    img = await doc.embedPng(await blob.arrayBuffer());
  }

  if (pageMode === "a4") {
    const landscape = img.width > img.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s;
    const h = img.height * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  } else {
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
}

// ---------- file lists ----------

const lists = { img2pdf: [], merge: [], split: [], compress: [], fit: [], watermark: [], sharpen: [], inpaint: [] };
const accepts = {
  img2pdf: isImage,
  merge: (f) => isPdf(f) || isImage(f),
  split: isPdf,
  compress: isImage,
  fit: (f) => isImage(f) || isPdf(f),
  watermark: isImage,
  sharpen: isImage,
  inpaint: isImage,
};
const runButtons = {
  img2pdf: "#i2p-run",
  merge: "#merge-run",
  split: "#split-run",
  compress: "#c-run",
  fit: "#fit-run",
  watermark: "#wm-run",
  sharpen: "#sh-run",
  inpaint: "#in-run",
};
const listHooks = {};
let uid = 0;

function addFiles(key, files) {
  const ok = [...files].filter(accepts[key]);
  const skipped = files.length - ok.length;
  for (const file of ok) {
    lists[key].push({
      id: ++uid,
      file,
      thumb: isImage(file) ? URL.createObjectURL(file) : null,
    });
  }
  if (skipped) toast(`Bỏ qua ${skipped} file không đúng định dạng.`);
  renderList(key);
  listHooks[key]?.added?.();
}

function removeItem(key, id) {
  const i = lists[key].findIndex((x) => x.id === id);
  if (i < 0) return;
  const [it] = lists[key].splice(i, 1);
  listHooks[key]?.removed?.(it);
  if (it.thumb) URL.revokeObjectURL(it.thumb);
  renderList(key);
}

function moveItem(key, from, to) {
  const arr = lists[key];
  if (to < 0 || to >= arr.length) return;
  const [it] = arr.splice(from, 1);
  arr.splice(to, 0, it);
  renderList(key);
}

function renderList(key) {
  if (key === "split") {
    syncSplitWorkspace();
    return;
  }
  const box = $(`[data-list="${key}"]`);
  const arr = lists[key];
  if (!box) return;
  box.innerHTML = "";
  arr.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "item" + (key === "split" ? " item-split" : "");
    row.draggable = true;
    row.dataset.idx = idx;
    row.innerHTML = `
      <span class="grip" title="Kéo để đổi thứ tự">${icon("grip-vertical")}</span>
      ${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : `<span class="thumb">${icon("file-text")}</span>`}
      <div class="meta">
        <div class="name"></div>
        <div class="size">${idx + 1}. ${fmtSize(it.file.size)}${it.info ? ` ${SEP} ${it.info}` : ""}</div>
        ${key === "split" ? `
        <div class="split-fields">
          <label>Trang<input type="text" data-field="pages" placeholder="vd. 1-3,5-6" /></label>
          <label>Tên file<input type="text" data-field="name" /></label>
        </div>` : ""}
      </div>
      <div class="btns">
        ${key === "watermark" || key === "inpaint" ? `<button data-act="edit" title="Tô vùng cần xoá">${icon("pencil")}</button>` : ""}
        <button data-act="up" title="Lên">${icon("chevron-up")}</button>
        <button data-act="down" title="Xuống">${icon("chevron-down")}</button>
        <button data-act="del" title="Xóa">${icon("x")}</button>
      </div>`;
    $(".name", row).textContent = it.file.name;
    $(".name", row).title = it.file.name;
    if (key === "split") {
      const pagesInput = $("[data-field=pages]", row);
      const nameInput = $("[data-field=name]", row);
      pagesInput.value = it.pageSpec || "";
      nameInput.value = it.outName ?? baseName(it.file.name);
      pagesInput.addEventListener("input", () => (it.pageSpec = pagesInput.value));
      nameInput.addEventListener("input", () => (it.outName = nameInput.value));
    }
    row.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "up") moveItem(key, idx, idx - 1);
      if (act === "down") moveItem(key, idx, idx + 1);
      if (act === "del") removeItem(key, it.id);
      if (act === "edit") listHooks[key]?.edit?.(it);
    });
    row.addEventListener("dragstart", (e) => {
      if (e.target.closest("input")) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/x-idx", String(idx));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/x-idx")) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      const from = e.dataTransfer.getData("text/x-idx");
      if (from === "") return;
      e.preventDefault();
      e.stopPropagation();
      moveItem(key, Number(from), idx);
    });
    box.appendChild(row);
  });

  const runBtn = $(runButtons[key]);
  if (runBtn) runBtn.disabled = arr.length === 0;
}

// ---------- results ----------

function resultsHeader(box, title, zipItems, zipName) {
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = `<strong></strong>`;
  $("strong", head).textContent = title;
  if (zipItems && zipItems.length > 1) {
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerHTML = `${icon("folder-down")} Tải tất cả (.zip)`;
    btn.onclick = async () => {
      btn.disabled = true;
      const zip = new JSZip();
      const used = new Set();
      for (const { blob, name } of zipItems) {
        let n = name;
        for (let k = 2; used.has(n); k++) n = `${baseName(name)} (${k})${name.slice(baseName(name).length)}`;
        used.add(n);
        zip.file(n, blob);
      }
      download(await zip.generateAsync({ type: "blob" }), zipName);
      btn.disabled = false;
    };
    head.appendChild(btn);
  }
  box.appendChild(head);
}

function resultRow(box, { name, blob, info, error, previews }) {
  const row = document.createElement("div");
  row.className = "res" + (error ? " error" : "");
  row.innerHTML = `<div class="meta"><div class="name"></div><div class="size"></div></div>`;
  if (previews?.length) {
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    for (const p of previews) {
      const a = document.createElement("a");
      a.href = p.url;
      a.target = "_blank";
      a.title = p.label;
      a.innerHTML = `<img alt="">`;
      a.firstChild.src = p.url;
      thumbs.appendChild(a);
    }
    row.prepend(thumbs);
  }
  $(".name", row).textContent = name;
  const size = $(".size", row);
  if (error) {
    size.textContent = error;
  } else {
    size.innerHTML = info || fmtSize(blob.size);
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.innerHTML = `${icon("download")} Tải về`;
    btn.onclick = () => download(blob, name);
    row.appendChild(btn);
  }
  box.appendChild(row);
}

function progressBar(box) {
  if (!box) return () => {};
  box.innerHTML = `<div class="progress"><div></div></div>`;
  const bar = $(".progress > div", box);
  return (done, total) => (bar.style.width = `${(done / total) * 100}%`);
}

async function withBusy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Đang xử lý...";
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast("Lỗi: " + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

// ---------- Ảnh sang PDF ----------

async function runImg2Pdf() {
  const items = lists.img2pdf;
  const mode = $("#i2p-mode").value;
  const opts = { pageMode: $("#i2p-page").value, compress: $("#i2p-quality").value === "compress" };
  const box = $("#i2p-results");
  const setProgress = progressBar(box);

  if (mode === "one") {
    const doc = await PDFDocument.create();
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      try {
        await addImagePage(doc, items[i].file, opts);
      } catch (e) {
        errors.push({ name: items[i].file.name, error: e.message || String(e) });
      }
      setProgress(i + 1, items.length);
    }
    const name = safeName($("#i2p-name").value, "tong-hop") + ".pdf";
    resultsHeader(box, `Xong: ${doc.getPageCount()} trang`);
    if (doc.getPageCount()) {
      const blob = new Blob([await doc.save()], { type: "application/pdf" });
      resultRow(box, { name, blob, info: `${doc.getPageCount()} trang ${SEP} ${fmtSize(blob.size)}` });
    }
    errors.forEach((e) => resultRow(box, e));
    return;
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    const name = baseName(f.name) + ".pdf";
    try {
      const doc = await PDFDocument.create();
      await addImagePage(doc, f, opts);
      results.push({ name, blob: new Blob([await doc.save()], { type: "application/pdf" }) });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }
  const ok = results.filter((r) => !r.error);
  resultsHeader(box, `Xong: ${ok.length}/${results.length} file`, ok, "anh-sang-pdf.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- Gộp PDF ----------

async function runMerge() {
  const items = lists.merge;
  const box = $("#merge-results");
  const setProgress = progressBar(box);
  const out = await PDFDocument.create();
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      if (isPdf(f)) {
        const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else {
        await addImagePage(out, f);
      }
    } catch (e) {
      errors.push({ name: f.name, error: "Không đọc được: " + (e.message || e) });
    }
    setProgress(i + 1, items.length);
  }

  const name = safeName($("#merge-name").value, "da-gop") + ".pdf";
  resultsHeader(box, `Xong: ${out.getPageCount()} trang`);
  if (out.getPageCount()) {
    const blob = new Blob([await out.save()], { type: "application/pdf" });
    resultRow(box, { name, blob, info: `${out.getPageCount()} trang ${SEP} ${fmtSize(blob.size)}` });
  }
  errors.forEach((e) => resultRow(box, e));
}

// ---------- Tách PDF ----------

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = asset("vendor/pdf.worker.min.js");
}

let splitIgnore = false;
let splitLastPage = 0;
let splitThumbGen = 0;

function pdfFileName(name, fallback) {
  const raw = safeName(name, fallback).replace(/\.pdf$/i, "");
  return (raw || fallback) + ".pdf";
}

function clampPage(n, pageCount) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.min(pageCount, Math.max(1, Math.round(v)));
}

function parsePageSpec(spec, pageCount) {
  const text = String(spec || "")
    .trim()
    .replace(/trang/gi, "")
    .replace(/\s+/g, "");
  if (!text) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages = [];
  const seen = new Set();
  for (const part of text.split(/[,;]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)(?:[-–—](\d+))?$/);
    if (!m) throw new Error(`Không hiểu khoảng trang "${part}"`);
    let a = Number(m[1]);
    let b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > pageCount) {
      throw new Error(`Trang ${a === b ? a : `${a}-${b}`} nằm ngoài 1–${pageCount}`);
    }
    for (let p = a; p <= b; p++) {
      if (seen.has(p)) continue;
      seen.add(p);
      pages.push(p);
    }
  }
  if (!pages.length) throw new Error("Khoảng trang trống");
  return pages;
}

function pageRangeLabel(pages) {
  if (!pages.length) return "";
  const parts = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    const cur = pages[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = cur;
  }
  return parts.join(",");
}

function rangesFromPages(pages) {
  if (!pages.length) return [];
  const ranges = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    const cur = pages[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    ranges.push({ from: start, to: prev });
    start = prev = cur;
  }
  return ranges;
}

function pagesFromRanges(ranges, pageCount) {
  const pages = [];
  const seen = new Set();
  for (const range of ranges) {
    let a = clampPage(range.from, pageCount);
    let b = clampPage(range.to, pageCount);
    if (a > b) [a, b] = [b, a];
    for (let p = a; p <= b; p++) {
      if (seen.has(p)) continue;
      seen.add(p);
      pages.push(p);
    }
  }
  return pages;
}

function destroySplitItem(it) {
  try { it.pdf?.destroy?.(); } catch {}
  it.pdf = null;
}

function splitCurrent() {
  return lists.split[0] || null;
}

function syncSplitWorkspace() {
  const it = splitCurrent();
  $("#split-drop").hidden = !!it;
  $("#split-workspace").hidden = !it;
  $("#split-run").disabled = !it || !it.pages;
  if (!it) {
    $("#split-thumbs").innerHTML = "";
    $("#split-range-list").innerHTML = "";
    return;
  }
  $("#split-file-name").textContent = it.file.name;
  $("#split-file-info").textContent = it.error
    ? it.error
    : `${fmtSize(it.file.size)}${it.pages ? ` · ${it.pages} trang` : " · đang đọc..."}`;
  if (!splitIgnore) $("#split-name").value = it.outName || baseName(it.file.name);
}

function renderSplitRanges() {
  const it = splitCurrent();
  const box = $("#split-range-list");
  box.innerHTML = "";
  if (!it) return;
  it.ranges.forEach((range, idx) => {
    const row = document.createElement("div");
    row.className = "split-range";
    row.innerHTML = `
      <span class="from-label">Từ trang</span>
      <input type="number" min="1" data-field="from" />
      <span class="to-label">đến</span>
      <input type="number" min="1" data-field="to" />
      <button type="button" class="split-del" data-act="del" title="Xóa khoảng">${icon("x")}</button>`;
    $("[data-field=from]", row).value = range.from;
    $("[data-field=to]", row).value = range.to;
    row.addEventListener("change", (e) => {
      const field = e.target.dataset.field;
      if (!field || !it.pages) return;
      range[field] = clampPage(e.target.value, it.pages);
      if (range.from > range.to) {
        if (field === "from") range.to = range.from;
        else range.from = range.to;
      }
      $("[data-field=from]", row).value = range.from;
      $("[data-field=to]", row).value = range.to;
      refreshSplitSelection(false);
    });
    row.addEventListener("click", (e) => {
      if (!e.target.closest("[data-act=del]")) return;
      if (it.ranges.length === 1) {
        it.ranges[0] = { from: 1, to: it.pages || 1 };
      } else {
        it.ranges.splice(idx, 1);
      }
      refreshSplitSelection();
    });
    box.appendChild(row);
  });
}

function refreshSplitSelection(rerenderRanges = true) {
  const it = splitCurrent();
  if (!it) return;
  const pages = pagesFromRanges(it.ranges, it.pages || 1);
  splitIgnore = true;
  $("#split-pages").value = pageRangeLabel(pages);
  splitIgnore = false;
  paintSplitThumbs(new Set(pages));
  $("#split-run").disabled = !it.pages || !pages.length;
  if (rerenderRanges) renderSplitRanges();
}

function paintSplitThumbs(selected) {
  $$("#split-thumbs .split-thumb").forEach((card) => {
    card.classList.toggle("selected", selected.has(Number(card.dataset.page)));
  });
}

function onSplitThumbClick(n, event) {
  const it = splitCurrent();
  if (!it?.pages) return;
  const selected = new Set(pagesFromRanges(it.ranges, it.pages));
  if (event.shiftKey && splitLastPage) {
    const a = Math.min(splitLastPage, n);
    const b = Math.max(splitLastPage, n);
    for (let p = a; p <= b; p++) selected.add(p);
  } else if (selected.has(n) && !event.shiftKey) {
    selected.delete(n);
  } else {
    selected.add(n);
  }
  splitLastPage = n;
  const pages = [...selected].sort((a, b) => a - b);
  it.ranges = rangesFromPages(pages);
  if (!it.ranges.length) it.ranges = [];
  refreshSplitSelection();
}

async function renderSplitThumbs(it) {
  const box = $("#split-thumbs");
  const gen = ++splitThumbGen;
  box.innerHTML = "";
  if (!it.pages) {
    box.dataset.empty = "1";
    box.textContent = it.error || "Không đọc được PDF.";
    return;
  }
  box.dataset.empty = "0";
  box.textContent = "";
  const selected = new Set(pagesFromRanges(it.ranges, it.pages));
  for (let n = 1; n <= it.pages; n++) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "split-thumb" + (selected.has(n) ? " selected" : "");
    card.dataset.page = String(n);
    card.innerHTML = `<canvas></canvas><span>Trang ${n}</span>`;
    card.addEventListener("click", (e) => onSplitThumbClick(n, e));
    box.appendChild(card);
  }
  if (!it.pdf) return;
  for (let n = 1; n <= it.pages; n++) {
    if (gen !== splitThumbGen) return;
    const card = $(`.split-thumb[data-page="${n}"]`, box);
    if (!card) continue;
    try {
      const page = await it.pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 110 / base.width });
      const canvas = $("canvas", card);
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    } catch {
      $("span", card).textContent = `Trang ${n} (không xem được)`;
    }
  }
}

async function loadSplitPreview(it) {
  destroySplitItem(it);
  it.outName = it.outName || baseName(it.file.name);
  it.pages = 0;
  it.error = "";
  splitLastPage = 0;
  syncSplitWorkspace();
  try {
    if (!window.pdfjsLib) throw new Error("Thiếu thư viện xem PDF.");
    const data = new Uint8Array(await it.file.arrayBuffer());
    try {
      it.pdf = await pdfjsLib.getDocument({ data: data.slice() }).promise;
    } catch {
      it.pdf = await pdfjsLib.getDocument({ data: data.slice(), disableWorker: true }).promise;
    }
    it.pages = it.pdf.numPages;
    it.ranges = [{ from: 1, to: it.pages }];
    $("#split-name").value = it.outName;
    $("#split-merge").checked = it.merge !== false;
    refreshSplitSelection();
    syncSplitWorkspace();
    await renderSplitThumbs(it);
  } catch (e) {
    it.error = e.message || String(e);
    it.pages = 0;
    syncSplitWorkspace();
    renderSplitThumbs(it);
    toast("Không đọc được PDF: " + it.error);
  }
}

async function prepareSplitFile() {
  lists.split.slice(0, -1).forEach(destroySplitItem);
  lists.split = lists.split.slice(-1);
  const it = splitCurrent();
  if (it) await loadSplitPreview(it);
  else syncSplitWorkspace();
}

async function copyPagesToPdf(src, pageNumbers) {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    src,
    pageNumbers.map((n) => n - 1)
  );
  copied.forEach((p) => out.addPage(p));
  return new Blob([await out.save()], { type: "application/pdf" });
}

async function runSplit() {
  const it = splitCurrent();
  if (!it?.pages) {
    toast("Hãy tải một file PDF trước.");
    return;
  }
  it.outName = $("#split-name").value;
  it.merge = $("#split-merge").checked;
  const jobs = it.merge
    ? [{ pages: pagesFromRanges(it.ranges, it.pages), name: pdfFileName(it.outName, baseName(it.file.name)) }]
    : it.ranges.map((range) => {
        const pages = pagesFromRanges([range], it.pages);
        const fallback = `${baseName(it.file.name)}_${range.from}-${range.to}`;
        const name = it.ranges.length === 1
          ? pdfFileName(it.outName, fallback)
          : pdfFileName(`${baseName(pdfFileName(it.outName, baseName(it.file.name)))}_${range.from}-${range.to}`, fallback);
        return { pages, name };
      });
  if (jobs.some((job) => !job.pages.length)) {
    toast("Chọn ít nhất một trang.");
    return;
  }

  const box = $("#split-results");
  const setProgress = progressBar(box);
  const src = await PDFDocument.load(await it.file.arrayBuffer(), { ignoreEncryption: true });
  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    try {
      const blob = await copyPagesToPdf(src, job.pages);
      results.push({
        name: job.name,
        blob,
        info: `${job.pages.length} trang (${pageRangeLabel(job.pages)}) ${SEP} ${fmtSize(blob.size)}`,
      });
    } catch (e) {
      results.push({ name: job.name, error: e.message || String(e) });
    }
    setProgress(i + 1, jobs.length);
  }
  const ok = results.filter((r) => !r.error);
  resultsHeader(box, `Xong: ${ok.length}/${results.length} file`, ok, "pdf-da-tach.zip");
  results.forEach((r) => resultRow(box, r));
}

listHooks.split = {
  added: prepareSplitFile,
  removed: destroySplitItem,
};

// ---------- Nén ảnh ----------

async function compressOne(file, { mode, targetKB, quality, maxDim, type }) {
  const bmp = await loadBitmap(file);
  const longEdge = Math.max(bmp.width, bmp.height);
  let scale = maxDim > 0 ? Math.min(1, maxDim / longEdge) : 1;
  const whiteBg = type === "image/jpeg";

  if (mode === "quality") {
    const blob = await canvasBlob(drawToCanvas(bmp, scale, whiteBg), type, quality);
    if (scale === 1 && blob.size >= file.size) return { blob: file, scale, kept: true };
    return { blob, scale };
  }

  const target = targetKB * 1024;
  if (file.size <= target && scale === 1) return { blob: file, scale, kept: true };

  let best = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const canvas = drawToCanvas(bmp, scale, whiteBg);
    let lo = 0.3, hi = 0.95, fit = null;
    for (let step = 0; step < 7; step++) {
      const q = (lo + hi) / 2;
      const blob = await canvasBlob(canvas, type, q);
      if (blob.size <= target) { fit = blob; lo = q; } else { hi = q; }
    }
    if (!fit) {
      const blob = await canvasBlob(canvas, type, lo);
      if (blob.size <= target) fit = blob;
      else if (!best || blob.size < best.size) best = blob;
    }
    if (fit) return { blob: fit, scale };
    scale *= 0.8;
  }
  return { blob: best, scale, missed: true };
}

async function runCompress() {
  const items = lists.compress;
  const type = $("#c-format").value;
  const ext = type === "image/webp" ? ".webp" : ".jpg";
  const opts = {
    mode: $("#c-mode").value,
    targetKB: Math.max(10, Number($("#c-target").value) || 500),
    quality: Number($("#c-quality").value) / 100,
    maxDim: Math.max(0, Number($("#c-maxdim").value) || 0),
    type,
  };
  const box = $("#c-results");
  const setProgress = progressBar(box);
  const results = [];
  let before = 0, after = 0;

  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      const r = await compressOne(f, opts);
      const name = r.kept ? f.name : baseName(f.name) + ext;
      const saved = Math.round((1 - r.blob.size / f.size) * 100);
      let info = `${fmtSize(f.size)} ${ARROW} <b>${fmtSize(r.blob.size)}</b>`;
      if (r.kept) info += ` ${SEP} đã đủ nhỏ, giữ nguyên file gốc`;
      else if (saved > 0) info += ` ${SEP} <span class="save">-${saved}%</span>`;
      if (r.scale < 1) info += ` ${SEP} thu nhỏ ${Math.round(r.scale * 100)}%`;
      if (r.missed) info += ` ${SEP} ${warn(`chưa đạt ${opts.targetKB} KB`)}`;
      before += f.size;
      after += r.blob.size;
      results.push({ name, blob: r.blob, info });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }

  const ok = results.filter((r) => !r.error);
  const total = before ? `, tổng ${fmtSize(before)} còn ${fmtSize(after)}` : "";
  resultsHeader(box, `Xong: ${ok.length}/${results.length} ảnh${total}`, ok, "anh-da-nen.zip");
  results.forEach((r) => resultRow(box, r));
}

async function runSharpen() {
  const items = lists.sharpen;
  const amount = Number($("#sh-amount")?.value) || 140;
  const type = $("#sh-format")?.value || "image/jpeg";
  const ext = type === "image/webp" ? ".webp" : type === "image/png" ? ".png" : ".jpg";
  const box = $("#sh-results");
  const setProgress = progressBar(box);
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      const bmp = await loadBitmap(f);
      const canvas = unsharp(drawToCanvas(bmp, 1, type === "image/jpeg"), 1.2, amount, 2);
      const blob = await canvasBlob(canvas, type, type === "image/png" ? undefined : 0.95);
      results.push({
        name: baseName(f.name) + ext,
        blob,
        info: `${bmp.width}×${bmp.height} ${SEP} ${fmtSize(f.size)} ${ARROW} <b>${fmtSize(blob.size)}</b>`,
      });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }
  const ok = results.filter((r) => !r.error);
  resultsHeader(box, `Xong: ${ok.length}/${results.length} ảnh`, ok, "anh-da-lam-net.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- Chỉnh dung lượng theo khoảng MIN-MAX (bản web của resizer/resize.py) ----------

function parseSize(raw) {
  const m = String(raw).trim().toUpperCase().replace(/\s+/g, "").match(/^(\d+(?:[.,]\d+)?)(B|KB|MB|GB)?$/);
  if (!m) throw new Error(`Không hiểu dung lượng "${raw}" (vd. 1MB, 500KB)`);
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] || "MB"];
  const v = Math.floor(parseFloat(m[1].replace(",", ".")) * mult);
  if (v <= 0) throw new Error("Dung lượng phải > 0");
  return v;
}

function gaussianKernel(sigma) {
  const r = Math.ceil(sigma * 3);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return k.map((v) => v / sum);
}

/** Giống PIL UnsharpMask(radius=1.2, percent=140, threshold=2). */
function unsharp(canvas, sigma = 1.2, percent = 140, threshold = 2) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const src = img.data;
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h * 3);
  const blur = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        const p = (y * w + xx) * 4, kv = k[i + r];
        a += src[p] * kv; b += src[p + 1] * kv; c += src[p + 2] * kv;
      }
      const o = (y * w + x) * 3;
      tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        const p = (yy * w + x) * 3, kv = k[i + r];
        a += tmp[p] * kv; b += tmp[p + 1] * kv; c += tmp[p + 2] * kv;
      }
      const o = (y * w + x) * 3;
      blur[o] = a; blur[o + 1] = b; blur[o + 2] = c;
    }
  }
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) {
      const diff = src[i + c] - blur[j + c];
      if (Math.abs(diff) >= threshold) src[i + c] = src[i + c] + (diff * percent) / 100;
    }
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

/** Chèn segment COM (FF FE) trước EOI để file đạt targetSize; ảnh hiển thị không đổi. */
async function padJpeg(blob, targetSize) {
  if (blob.size >= targetSize) return blob;
  const data = new Uint8Array(await blob.arrayBuffer());
  let eoi = -1;
  for (let i = data.length - 2; i >= 0; i--) {
    if (data[i] === 0xff && data[i + 1] === 0xd9) { eoi = i; break; }
  }
  if (eoi < 0) return blob;
  const parts = [data.subarray(0, eoi)];
  let remaining = targetSize - data.length;
  while (remaining > 0) {
    const payload = Math.min(65533, Math.max(0, remaining - 4));
    const seg = new Uint8Array(payload + 4);
    seg[0] = 0xff; seg[1] = 0xfe;
    seg[2] = (payload + 2) >> 8; seg[3] = (payload + 2) & 0xff;
    parts.push(seg);
    remaining -= seg.length;
  }
  parts.push(data.subarray(eoi));
  return new Blob(parts, { type: "image/jpeg" });
}

const encodeJpeg = (canvas, q) => canvasBlob(canvas, "image/jpeg", q);

/** Nén JPEG chất lượng cao nhất mà vẫn <= maxBytes, không được thì thu nhỏ dần. */
async function compressToMax(canvas, maxBytes) {
  const search = async (c) => {
    let lo = 35, hi = 95;
    let best = await encodeJpeg(c, lo / 100);
    if (best.size > maxBytes) return best;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const cand = await encodeJpeg(c, mid / 100);
      if (cand.size <= maxBytes) { best = cand; lo = mid; } else { hi = mid - 1; }
    }
    return best;
  };
  let best = await search(canvas);
  if (best.size <= maxBytes) return { blob: best, scale: 1 };
  let scale = 0.92, total = 1;
  for (let i = 0; i < 12; i++) {
    total *= scale;
    const w = Math.max(64, Math.round(canvas.width * total));
    const h = Math.max(64, Math.round(canvas.height * total));
    best = await search(drawToCanvas(canvas, w / canvas.width, true));
    if (best.size <= maxBytes) return { blob: best, scale: total };
    scale = 0.9;
  }
  return { blob: best, scale: total };
}

async function fitOne(file, cfg) {
  const bmp = await loadBitmap(file);
  let canvas = drawToCanvas(bmp, 1, true);
  const notes = [];
  let wmRemoved = false;
  if (cfg.removeWm && canvas.width * canvas.height <= 2_000_000) {
    const r = await MyBk.remove(canvas);
    if (r.removed) {
      canvas = r.canvas;
      wmRemoved = true;
      notes.push(`đã xoá watermark (${r.hits} chữ)`);
    }
  }

  const size = file.size;
  const inRange = size >= cfg.min && size <= cfg.max;
  if (inRange && !wmRemoved) return { blob: file, kept: true, notes: ["đã nằm trong khoảng, giữ nguyên"] };

  let blob;
  if (size > cfg.max || inRange) {
    const r = await compressToMax(canvas, cfg.max);
    blob = r.blob;
    if (size > cfg.max) notes.push("nén");
    if (r.scale < 1) notes.push(`thu nhỏ ${Math.round(r.scale * 100)}%`);
  } else {
    // Ảnh vừa xoá watermark không làm nét để khỏi làm lộ vết chữ còn sót.
    const sharpen = cfg.sharpen && !wmRemoved;
    const work = sharpen ? unsharp(canvas) : canvas;
    if (sharpen) notes.push("làm nét");
    blob = await encodeJpeg(work, 0.98);
    for (let ratio = 1.05; blob.size < cfg.min && ratio <= cfg.maxUpscale + 1e-9; ratio += 0.03) {
      const cand = await encodeJpeg(drawToCanvas(work, ratio), 0.98);
      blob = cand;
      if (cand.size >= cfg.min) notes.push(`phóng to ${ratio.toFixed(2)}x`);
    }
    if (blob.size < cfg.min) blob = await encodeJpeg(work, 1);
  }

  if (blob.size > cfg.max) {
    const r = await compressToMax(canvas, cfg.max);
    blob = r.blob;
  }
  if (blob.size < cfg.min && cfg.pad) {
    const before = blob.size;
    blob = await padJpeg(blob, cfg.min);
    notes.push(`pad metadata +${fmtSize(blob.size - before)}`);
  }
  return { blob, notes, outOfRange: blob.size < cfg.min || blob.size > cfg.max };
}

const CHARM_URL = encodeURI(asset("assets/bùa may mắn.jpg"));
let charmBytesPromise;

function loadCharmBytes() {
  charmBytesPromise ||= fetch(CHARM_URL).then(async (res) => {
    if (!res.ok) throw new Error("Không tải được ảnh bùa may mắn.");
    return new Uint8Array(await res.arrayBuffer());
  });
  return charmBytesPromise;
}

async function loadPdfJsDoc(data) {
  if (!window.pdfjsLib) throw new Error("Thiếu thư viện xem PDF.");
  try {
    return await pdfjsLib.getDocument({ data: data.slice() }).promise;
  } catch {
    return await pdfjsLib.getDocument({ data: data.slice(), disableWorker: true }).promise;
  }
}

function concatBytes(chunks) {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

/** Dữ liệu sau %%EOF: hầu hết trình xem bỏ qua, trang/khổ giấy không đổi. */
function padPdfBytes(pdfBytes, min) {
  if (pdfBytes.length >= min) return pdfBytes;
  const header = new TextEncoder().encode("\n%%SV5T-PAD\n");
  const chunks = [pdfBytes, header];
  const need = min - pdfBytes.length - header.length;
  if (need > 0) {
    const rest = new Uint8Array(need);
    rest.fill(0x20);
    chunks.push(rest);
  }
  return concatBytes(chunks);
}

function charmDrawBox(pageSize, img) {
  const scale = Math.min(pageSize.width / img.width, pageSize.height / img.height);
  const width = img.width * scale;
  const height = img.height * scale;
  return {
    x: (pageSize.width - width) / 2,
    y: (pageSize.height - height) / 2,
    width,
    height,
    opacity: 0,
  };
}

/** In chìm phía dưới nội dung, opacity 0% — không che chữ, không thêm trang. */
async function stampCharmUnder(pdfBytes, min, max, charm) {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const indices = src.getPageIndices();
  let copies = Math.max(1, Math.ceil((min - pdfBytes.length) / Math.max(1, charm.length)));
  copies = Math.min(24, copies);
  while (copies > 1 && pdfBytes.length + copies * charm.length > max) copies--;

  const build = async (n) => {
    const out = await PDFDocument.create();
    const embedded = await out.embedPdf(pdfBytes, indices);
    const imgs = [];
    for (let i = 0; i < n; i++) imgs.push(await out.embedJpg(charm.slice()));
    src.getPages().forEach((srcPage, i) => {
      const size = srcPage.getSize();
      const page = out.addPage([size.width, size.height]);
      for (const img of imgs) page.drawImage(img, charmDrawBox(size, img));
      page.drawPage(embedded[i], { x: 0, y: 0, width: size.width, height: size.height });
    });
    return new Uint8Array(await out.save({ useObjectStreams: true }));
  };

  let n = copies;
  let bytes = await build(n);
  while (bytes.length > max && n > 1) {
    n -= 1;
    bytes = await build(n);
  }
  return { bytes, copies: n };
}

async function rebuildPdfFromJpegs(pdf, pageSizes, dpi, quality) {
  const scale = dpi / 72;
  const out = await PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await canvasBlob(canvas, "image/jpeg", quality);
    const img = await out.embedJpg(await blob.arrayBuffer());
    const { width, height } = pageSizes[i - 1];
    const pg = out.addPage([width, height]);
    pg.drawImage(img, { x: 0, y: 0, width, height });
  }
  return new Uint8Array(await out.save({ useObjectStreams: true }));
}

async function shrinkPdf(file, maxBytes) {
  const buf = await file.arrayBuffer();
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const pageSizes = src.getPages().map((p) => p.getSize());
  const notes = [];

  const copied = await PDFDocument.create();
  const pages = await copied.copyPages(src, src.getPageIndices());
  pages.forEach((p) => copied.addPage(p));
  let bytes = new Uint8Array(await copied.save({ useObjectStreams: true }));
  if (bytes.length <= maxBytes) {
    notes.push("dọn object PDF");
    return { bytes, notes };
  }

  const pdf = await loadPdfJsDoc(new Uint8Array(buf.slice(0)));
  const attempts = [
    [150, 0.82],
    [130, 0.75],
    [110, 0.68],
    [96, 0.6],
    [72, 0.5],
    [72, 0.4],
  ];
  let best = bytes;
  notes.push("nén trang PDF");
  for (const [dpi, quality] of attempts) {
    const cand = await rebuildPdfFromJpegs(pdf, pageSizes, dpi, quality);
    if (cand.length < best.length) best = cand;
    if (cand.length <= maxBytes) {
      notes.push(`${dpi} dpi, JPEG ${Math.round(quality * 100)}%`);
      try { pdf.destroy?.(); } catch {}
      return { bytes: cand, notes };
    }
  }
  try { pdf.destroy?.(); } catch {}
  notes.push("vẫn trên tối đa sau khi nén");
  return { bytes: best, notes };
}

async function fitPdf(file, cfg) {
  const notes = [];
  if (file.size >= cfg.min && file.size <= cfg.max) {
    return { blob: file, kept: true, notes: ["đã nằm trong khoảng, giữ nguyên"] };
  }

  let bytes = new Uint8Array(await file.arrayBuffer());
  if (file.size > cfg.max) {
    const r = await shrinkPdf(file, cfg.max);
    bytes = r.bytes;
    notes.push(...r.notes);
  }

  if (bytes.length < cfg.min) {
    let charm = null;
    if (cfg.pdfCharm) {
      try {
        charm = await loadCharmBytes();
      } catch (e) {
        notes.push(e.message || "không có ảnh bùa may mắn");
      }
    }
    if (charm && cfg.pdfCharm) {
      const before = bytes.length;
      const r = await stampCharmUnder(bytes, cfg.min, cfg.max, charm);
      bytes = r.bytes;
      notes.push(`in chìm ${r.copies} ảnh bùa may mắn dưới nội dung, opacity 0% (+${fmtSize(bytes.length - before)})`);
    }
    if (bytes.length < cfg.min && cfg.pdfPad) {
      const before = bytes.length;
      bytes = padPdfBytes(bytes, cfg.min);
      notes.push(`pad +${fmtSize(bytes.length - before)}`);
    }
  }

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    notes,
    outOfRange: bytes.length < cfg.min || bytes.length > cfg.max,
  };
}

async function runFit() {
  let cfg;
  try {
    cfg = {
      min: parseSize($("#fit-min").value),
      max: parseSize($("#fit-max").value),
      maxUpscale: Math.max(1, Number($("#fit-upscale").value) || 1),
      sharpen: $("#fit-sharpen")?.checked ?? true,
      pad: $("#fit-pad")?.checked ?? true,
      removeWm: $("#fit-wm")?.checked ?? false,
      pdfCharm: $("#fit-pdf-charm")?.checked ?? false,
      pdfPad: $("#fit-pdf-pad")?.checked ?? false,
    };
  } catch (e) {
    toast(e.message);
    return;
  }
  if (cfg.min > cfg.max) {
    toast("Tối thiểu phải nhỏ hơn hoặc bằng tối đa.");
    return;
  }

  const items = lists.fit;
  const box = $("#fit-results");
  const setProgress = progressBar(box);
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    try {
      const r = isPdf(f) ? await fitPdf(f, cfg) : await fitOne(f, cfg);
      const name = r.kept ? f.name : baseName(f.name) + (isPdf(f) ? ".pdf" : ".jpg");
      let info = `${fmtSize(f.size)} ${ARROW} <b>${fmtSize(r.blob.size)}</b>`;
      for (const note of r.notes) info += ` ${SEP} ${note}`;
      if (r.outOfRange) info += ` ${SEP} ${warn("chưa vào khoảng yêu cầu")}`;
      results.push({ name, blob: r.blob, info });
    } catch (e) {
      results.push({ name: f.name, error: e.message || String(e) });
    }
    setProgress(i + 1, items.length);
  }
  const ok = results.filter((r) => !r.error);
  resultsHeader(box, `Xong: ${ok.length}/${results.length} file, khoảng ${fmtSize(cfg.min)} đến ${fmtSize(cfg.max)}`, ok, "file-da-chinh.zip");
  results.forEach((r) => resultRow(box, r));
}

// ---------- Xoá watermark ----------

const wmResults = new Map();
const inResults = new Map();

function paintStore(listKey) {
  if (listKey === "inpaint") {
    return { map: inResults, box: "#in-results", zip: "anh-da-xoa-vat.zip", list: lists.inpaint };
  }
  return { map: wmResults, box: "#wm-results", zip: "anh-da-xoa-watermark.zip", list: lists.watermark };
}

function renderPaintResults(listKey) {
  const { map, box, zip, list } = paintStore(listKey);
  const el = $(box);
  if (!el) return;
  const items = list.filter((it) => map.has(it.id));
  if (!items.length) {
    el.innerHTML = "";
    return;
  }
  const rows = items.map((it) => map.get(it.id));
  const ok = rows.filter((r) => !r.error);
  resultsHeader(el, `Kết quả: ${ok.length} ảnh`, ok, zip);
  rows.forEach((r) => resultRow(el, r));
}

function renderWmResults() {
  renderPaintResults("watermark");
}

function setPaintResult(listKey, item, result) {
  const { map } = paintStore(listKey);
  const old = map.get(item.id);
  if (old?.previews) old.previews.forEach((p) => p.revoke && URL.revokeObjectURL(p.url));
  map.set(item.id, result);
  renderPaintResults(listKey);
}

function setWmResult(item, result) {
  setPaintResult("watermark", item, result);
}

async function wmOutput(item, canvas, info) {
  const blob = await encodeJpeg(canvas, 0.95);
  const url = URL.createObjectURL(blob);
  return {
    name: baseName(item.file.name) + ".jpg",
    blob,
    info: `${info} ${SEP} ${fmtSize(blob.size)}`,
    previews: [
      { url: item.thumb, label: "Ảnh gốc" },
      { url, label: "Sau khi xoá", revoke: true },
    ],
  };
}

async function runWatermarkAuto() {
  const items = lists.watermark;
  const strength = Number($("#wm-strength").value);
  const btn = $("#wm-run");
  for (let i = 0; i < items.length; i++) {
    btn.textContent = `Đang xử lý ${i + 1}/${items.length}...`;
    const it = items[i];
    try {
      const canvas = drawToCanvas(await loadBitmap(it.file), 1, true);
      if (canvas.width * canvas.height > 2_000_000) throw new Error("Ảnh quá lớn cho chế độ myBk, hãy dùng chế độ tô vùng.");
      const r = await MyBk.remove(canvas, { strength });
      if (!r.removed) {
        setWmResult(it, { name: it.file.name, error: `Không thấy watermark myBk (chỉ khớp ${r.hits} chữ), thử chế độ tô vùng.` });
      } else {
        setWmResult(it, await wmOutput(it, r.canvas, `Đã xoá ${r.hits} chữ watermark`));
      }
    } catch (e) {
      setWmResult(it, { name: it.file.name, error: e.message || String(e) });
    }
  }
}

const editor = {
  item: null,
  listKey: "watermark",
  base: null,
  original: null,
  history: [],
  tool: "paint",
  painting: false,
  last: null,
};

function edDraw(canvas) {
  const img = $("#ed-img");
  img.width = canvas.width;
  img.height = canvas.height;
  img.getContext("2d").drawImage(canvas, 0, 0);
}

function edClearMask() {
  const m = $("#ed-mask");
  m.getContext("2d").clearRect(0, 0, m.width, m.height);
}

function edStatus(text) {
  $("#ed-status").textContent = text;
}

async function openEditor(item, listKey = "watermark") {
  editor.item = item;
  editor.listKey = listKey;
  const canvas = drawToCanvas(await loadBitmap(item.file), 1, true);
  editor.original = canvas;
  editor.base = canvas;
  editor.history = [];
  $("#ed-undo").disabled = true;
  $("#ed-name").textContent = item.file.name;
  edDraw(canvas);
  const m = $("#ed-mask");
  m.width = canvas.width;
  m.height = canvas.height;
  edClearMask();
  const ed = $("#wm-editor");
  if (!ed) return;
  ed.hidden = false;
  ed.scrollIntoView({ behavior: "smooth", block: "start" });
  edStatus('Tô lên chữ/logo cần xoá rồi bấm "Xoá vùng đã tô".');
  Inpaint.load((p) => edStatus(`Đang tải model AI... ${Math.round(p * 100)}%`))
    .then(() => edStatus('Model AI sẵn sàng. Tô lên vùng cần xoá rồi bấm "Xoá vùng đã tô".'))
    .catch(() => edStatus("Không tải được model AI, sẽ dùng thuật toán OpenCV thay thế."));
}

function closeEditor() {
  editor.item = null;
  const ed = $("#wm-editor");
  if (ed) ed.hidden = true;
}

function edPoint(e) {
  const m = $("#ed-mask");
  const rect = m.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * m.width,
    y: ((e.clientY - rect.top) / rect.height) * m.height,
    scale: m.width / rect.width,
  };
}

function edStroke(from, to) {
  const ctx = $("#ed-mask").getContext("2d");
  ctx.globalCompositeOperation = editor.tool === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = "#ff1744";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Number($("#ed-brush").value) * to.scale;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x + 0.01, to.y);
  ctx.stroke();
}

function edMask() {
  const m = $("#ed-mask");
  const a = m.getContext("2d").getImageData(0, 0, m.width, m.height).data;
  const mask = new Uint8Array(m.width * m.height);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (a[i * 4 + 3] > 0) { mask[i] = 1; count++; }
  }
  return count ? mask : null;
}

async function edRun() {
  const mask = edMask();
  if (!mask) {
    toast("Chưa tô vùng nào.");
    return;
  }
  const btn = $("#ed-run");
  btn.disabled = true;
  edStatus("Đang xoá...");
  try {
    const t = performance.now();
    const r = await Inpaint.run(editor.base, mask, (p) => edStatus(`Đang tải model AI... ${Math.round(p * 100)}%`));
    editor.history.push(editor.base);
    editor.base = r.canvas;
    $("#ed-undo").disabled = false;
    edDraw(r.canvas);
    edClearMask();
    edStatus(`Xong bằng ${r.engine} (${((performance.now() - t) / 1000).toFixed(1)}s). Còn sót thì tô tiếp và chạy lại.`);
  } catch (e) {
    console.error(e);
    edStatus("Lỗi: " + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

async function edSave() {
  const it = editor.item;
  if (!it) return;
  if (!editor.history.length) {
    toast("Chưa xoá gì trên ảnh này.");
    return;
  }
  const key = editor.listKey || "watermark";
  setPaintResult(key, it, await wmOutput(it, editor.base, `Đã xoá ${editor.history.length} lượt bằng AI`));
  const { map, list } = paintStore(key);
  const next = list.find((x) => !map.has(x.id));
  if (next) openEditor(next, key);
  else {
    closeEditor();
    toast("Đã xử lý hết ảnh trong danh sách.");
  }
}

function wmModeChanged() {
  const mode = $("#wm-mode");
  if (!mode) return;
  const brush = mode.value === "brush";
  const wrap = $("#wm-strength-wrap");
  const run = $("#wm-run");
  if (wrap) wrap.hidden = brush;
  if (run) run.textContent = brush ? "Bắt đầu tô ảnh đầu tiên" : "Xoá watermark";
  if (!brush) closeEditor();
}

listHooks.watermark = {
  edit: (it) => {
    if ($("#wm-mode")) {
      $("#wm-mode").value = "brush";
      wmModeChanged();
    }
    openEditor(it, "watermark");
  },
  added: () => {
    if ($("#wm-mode")?.value === "brush" && !editor.item) {
      const next = lists.watermark.find((x) => !wmResults.has(x.id));
      if (next) openEditor(next, "watermark");
    }
  },
  removed: (it) => {
    wmResults.get(it.id)?.previews?.forEach((p) => p.revoke && URL.revokeObjectURL(p.url));
    wmResults.delete(it.id);
    if (editor.item === it) closeEditor();
    renderPaintResults("watermark");
  },
};

listHooks.inpaint = {
  edit: (it) => openEditor(it, "inpaint"),
  added: () => {
    if (!editor.item) {
      const next = lists.inpaint.find((x) => !inResults.has(x.id));
      if (next) openEditor(next, "inpaint");
    }
  },
  removed: (it) => {
    inResults.get(it.id)?.previews?.forEach((p) => p.revoke && URL.revokeObjectURL(p.url));
    inResults.delete(it.id);
    if (editor.item === it) closeEditor();
    renderPaintResults("inpaint");
  },
};

bind("#wm-mode", "change", wmModeChanged);
bind("#wm-strength", "input", (e) => {
  const val = $("#wm-strength-val");
  if (val) val.textContent = e.target.value;
});
bind("#wm-run", "click", (e) => {
  if ($("#wm-mode")?.value === "brush") {
    const next = lists.watermark.find((x) => !wmResults.has(x.id)) || lists.watermark[0];
    if (next) openEditor(next, "watermark");
  } else {
    withBusy(e.currentTarget, runWatermarkAuto);
  }
});
bind("#in-run", "click", () => {
  const next = lists.inpaint.find((x) => !inResults.has(x.id)) || lists.inpaint[0];
  if (next) openEditor(next, "inpaint");
});

const maskEl = $("#ed-mask");
if (maskEl) {
  maskEl.addEventListener("pointerdown", (e) => {
    editor.painting = true;
    maskEl.setPointerCapture(e.pointerId);
    editor.last = edPoint(e);
    edStroke(editor.last, editor.last);
  });
  maskEl.addEventListener("pointermove", (e) => {
    if (!editor.painting) return;
    const p = edPoint(e);
    edStroke(editor.last, p);
    editor.last = p;
  });
  ["pointerup", "pointercancel"].forEach((ev) => maskEl.addEventListener(ev, () => (editor.painting = false)));
}

bind("#ed-tool", "click", (e) => {
  editor.tool = editor.tool === "paint" ? "erase" : "paint";
  e.currentTarget.innerHTML = editor.tool === "paint"
    ? `${icon("paintbrush")}<span>Đang tô</span>`
    : `${icon("eraser")}<span>Đang tẩy</span>`;
});
bind("#ed-clear", "click", edClearMask);
bind("#ed-undo", "click", () => {
  if (!editor.history.length) return;
  editor.base = editor.history.pop();
  edDraw(editor.base);
  $("#ed-undo").disabled = !editor.history.length;
});
const peek = $("#ed-peek");
if (peek) {
  peek.addEventListener("pointerdown", () => editor.original && edDraw(editor.original));
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
    peek.addEventListener(ev, () => editor.base && edDraw(editor.base))
  );
}
bind("#ed-run", "click", edRun);
bind("#ed-save", "click", edSave);
bind("#ed-close", "click", closeEditor);

// ---------- wiring ----------

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab.dataset.tab));
  })
);

$$(".drop").forEach((drop) => {
  const key = drop.dataset.target;
  const input = $("input", drop);
  input.addEventListener("change", () => {
    addFiles(key, input.files);
    input.value = "";
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("over");
    addFiles(key, e.dataTransfer.files);
  });
});

// Dropping files anywhere on the active panel also works.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!e.dataTransfer.files.length) return;
  const active = $(".panel.active .drop");
  if (active) addFiles(active.dataset.target, e.dataTransfer.files);
});

$$("[data-sort]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const key = btn.dataset.sort;
    lists[key].sort((a, b) =>
      a.file.name.localeCompare(b.file.name, "vi", { numeric: true, sensitivity: "base" })
    );
    renderList(key);
  })
);

$$("[data-clear]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const key = btn.dataset.clear;
    lists[key].forEach((it) => {
      listHooks[key]?.removed?.(it);
      if (it.thumb) URL.revokeObjectURL(it.thumb);
    });
    lists[key] = [];
    renderList(key);
  })
);

bind("#i2p-mode", "change", (e) => {
  const wrap = $("#i2p-name-wrap");
  if (wrap) wrap.hidden = e.target.value !== "one";
});
bind("#c-mode", "change", (e) => {
  const t = $("#c-target-wrap");
  const q = $("#c-quality-wrap");
  if (t) t.hidden = e.target.value !== "target";
  if (q) q.hidden = e.target.value !== "quality";
});
bind("#c-quality", "input", (e) => {
  const val = $("#c-quality-val");
  if (val) val.textContent = e.target.value;
});
bind("#sh-amount", "input", (e) => {
  const val = $("#sh-amount-val");
  if (val) val.textContent = e.target.value;
});

function dressSelects() {
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  const closePick = (pick) => {
    pick.classList.remove("open");
    const menu = $(".pick-menu", pick);
    const btn = $(".pick-btn", pick);
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  };
  $$("select").forEach((sel) => {
    const pick = document.createElement("div");
    pick.className = "pick";
    sel.before(pick);
    pick.appendChild(sel);
    sel.classList.add("pick-native");
    sel.tabIndex = -1;
    sel.addEventListener("focus", () => btn.focus());

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pick-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = `<span class="pick-label"></span><svg class="i pick-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
    const menu = document.createElement("div");
    menu.className = "pick-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    pick.append(btn, menu);

    const label = $(".pick-label", btn);
    const paint = () => {
      label.textContent = sel.selectedOptions[0]?.textContent.trim() || "";
      $$(".pick-opt", menu).forEach((opt) => {
        opt.setAttribute("aria-selected", opt.dataset.value === sel.value ? "true" : "false");
      });
    };
    menu.replaceChildren(...[...sel.options].map((opt) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pick-opt";
      item.setAttribute("role", "option");
      item.dataset.value = opt.value;
      item.textContent = opt.textContent.trim();
      item.addEventListener("click", () => {
        if (sel.value !== opt.value) {
          valueDesc.set.call(sel, opt.value);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        paint();
        closePick(pick);
        btn.focus();
      });
      return item;
    }));
    Object.defineProperty(sel, "value", {
      configurable: true,
      get() { return valueDesc.get.call(this); },
      set(v) {
        valueDesc.set.call(this, v);
        paint();
      },
    });
    paint();

    btn.addEventListener("click", () => {
      const willOpen = menu.hidden;
      $$(".pick.open").forEach(closePick);
      if (!willOpen) return;
      menu.hidden = false;
      pick.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePick(pick);
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        if (menu.hidden) {
          e.preventDefault();
          btn.click();
        }
      }
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pick")) $$(".pick.open").forEach(closePick);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$(".pick.open").forEach(closePick);
  });
}
dressSelects();

bind("#i2p-run", "click", (e) => withBusy(e.currentTarget, runImg2Pdf));
bind("#merge-run", "click", (e) => withBusy(e.currentTarget, runMerge));
bind("#split-run", "click", (e) => withBusy(e.currentTarget, runSplit));
bind("#split-add-range", "click", () => {
  const it = splitCurrent();
  if (!it?.pages) return;
  const used = new Set(pagesFromRanges(it.ranges, it.pages));
  let from = 1;
  while (from <= it.pages && used.has(from)) from++;
  if (from > it.pages) from = it.pages;
  it.ranges.push({ from, to: from });
  refreshSplitSelection();
});
bind("#split-pages", "change", () => {
  if (splitIgnore) return;
  const it = splitCurrent();
  if (!it?.pages) return;
  try {
    it.ranges = rangesFromPages(parsePageSpec($("#split-pages").value, it.pages));
    refreshSplitSelection();
  } catch (e) {
    toast(e.message);
  }
});
bind("#split-name", "input", () => {
  const it = splitCurrent();
  if (it) it.outName = $("#split-name").value;
});
bind("#c-run", "click", (e) => withBusy(e.currentTarget, runCompress));
bind("#fit-run", "click", (e) => withBusy(e.currentTarget, runFit));
bind("#sh-run", "click", (e) => withBusy(e.currentTarget, runSharpen));
