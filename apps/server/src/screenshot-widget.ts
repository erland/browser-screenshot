export const SCREENSHOT_WIDGET_URI = 'ui://browser-screenshot/screenshot-viewer-v1.html';

export const SCREENSHOT_WIDGET_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
    .viewer { display: grid; gap: 10px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
    .actions { display: flex; gap: 8px; }
    button {
      appearance: none; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 10px; padding: 8px 12px; background: Canvas; color: CanvasText;
      font: inherit; cursor: pointer;
    }
    button:hover { background: color-mix(in srgb, CanvasText 7%, Canvas); }
    button:disabled { opacity: .5; cursor: default; }
    .meta { font-size: 12px; opacity: .72; min-height: 1.2em; }
    .frame {
      display: grid; place-items: center; width: 100%; min-height: 160px;
      border-radius: 12px; overflow: auto;
      background: color-mix(in srgb, CanvasText 5%, Canvas);
    }
    img {
      display: block; max-width: 100%; max-height: 72vh; width: auto; height: auto;
      object-fit: contain; cursor: zoom-in;
    }
    .empty { padding: 32px 16px; opacity: .65; text-align: center; }
  </style>
</head>
<body>
  <main class="viewer">
    <div class="toolbar">
      <div id="meta" class="meta">Preparing screenshot…</div>
      <div class="actions">
        <button id="fullscreen" type="button">View large</button>
        <button id="download" type="button" disabled>Download PNG</button>
      </div>
    </div>
    <div class="frame">
      <div id="empty" class="empty">Waiting for screenshot…</div>
      <img id="image" alt="Captured web page screenshot" hidden />
    </div>
  </main>
  <script>
    const imageEl = document.getElementById("image");
    const emptyEl = document.getElementById("empty");
    const metaEl = document.getElementById("meta");
    const fullscreenButton = document.getElementById("fullscreen");
    const downloadButton = document.getElementById("download");

    let latestInput;
    let latestImage;

    function fileNameFromInput() {
      try {
        const host = new URL(latestInput?.url).hostname.replace(/[^a-z0-9.-]+/gi, "-");
        return host ? "screenshot-" + host + ".png" : "screenshot.png";
      } catch {
        return "screenshot.png";
      }
    }

    function notifyHeight() {
      window.openai?.notifyIntrinsicHeight?.(document.documentElement.scrollHeight);
    }

    function findImage(result) {
      const content = Array.isArray(result?.content) ? result.content : [];
      return content.find((item) => item?.type === "image" && typeof item?.data === "string");
    }

    function render(result) {
      const image = findImage(result);
      const meta = result?.structuredContent || {};
      const parts = [];
      if (meta.width && meta.height) parts.push(meta.width + " × " + meta.height);
      if (meta.deviceScaleFactor) parts.push("DPR " + meta.deviceScaleFactor);
      if (typeof meta.fullPage === "boolean") parts.push(meta.fullPage ? "full page" : "viewport");
      if (meta.durationMs) parts.push(meta.durationMs + " ms");
      metaEl.textContent = parts.join(" · ") || "Screenshot";

      if (!image) {
        latestImage = undefined;
        imageEl.hidden = true;
        emptyEl.hidden = false;
        emptyEl.textContent = "The screenshot image was not included in the tool result.";
        downloadButton.disabled = true;
        notifyHeight();
        return;
      }

      latestImage = image;
      const mimeType = image.mimeType || "image/png";
      imageEl.src = "data:" + mimeType + ";base64," + image.data;
      imageEl.hidden = false;
      emptyEl.hidden = true;
      downloadButton.disabled = false;
      notifyHeight();
    }

    async function viewLarge() {
      if (window.openai?.requestDisplayMode) {
        await window.openai.requestDisplayMode({ mode: "fullscreen" });
      }
    }

    function downloadImage() {
      if (!latestImage) return;
      const mimeType = latestImage.mimeType || "image/png";
      const link = document.createElement("a");
      link.href = "data:" + mimeType + ";base64," + latestImage.data;
      link.download = fileNameFromInput();
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    fullscreenButton.addEventListener("click", viewLarge);
    imageEl.addEventListener("click", viewLarge);
    downloadButton.addEventListener("click", downloadImage);

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;

      if (message.method === "ui/notifications/tool-input") {
        latestInput = message.params;
      }
      if (message.method === "ui/notifications/tool-result") {
        render(message.params);
      }
    }, { passive: true });

    notifyHeight();
  </script>
</body>
</html>`;
