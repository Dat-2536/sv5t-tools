"use strict";

window.SV5T = {
  root() {
    return document.documentElement.getAttribute("data-root") || "./";
  },
  asset(path) {
    return new URL(path, new URL(this.root(), location.href)).href;
  },
  isHeic(file) {
    return /heic|heif/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");
  },
  async heicToJpeg(file) {
    if (!window.heic2any) throw new Error("Trình duyệt chưa tải bộ giải mã HEIC.");
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    const blob = Array.isArray(out) ? out[0] : out;
    return new File([blob], (file.name || "image").replace(/\.(heic|heif)$/i, ".jpg"), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  },
};
