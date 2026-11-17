import { BrowserWindow, screen } from "electron";
import path from "node:path";

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]!));

/** Keep the complete operation reviewable without pushing approval controls off-screen. */
export function showPermissionWindow(parent: BrowserWindow, options: {
  title: string; message: string; detail: string; footer: string; buttons: string[]; signal: AbortSignal;
}): Promise<number> {
  if (options.signal.aborted || parent.isDestroyed()) return Promise.resolve(0);
  const area = screen.getDisplayMatching(parent.getBounds()).workArea;
  const width = Math.min(680, area.width - 32), height = Math.min(640, area.height - 48);
  const bounds = parent.getBounds();
  const win = new BrowserWindow({
    parent, modal: true, show: false, title: options.title, width, height,
    x: Math.max(area.x, Math.min(area.x + area.width - width, Math.round(bounds.x + (bounds.width - width) / 2))),
    y: Math.max(area.y, Math.min(area.y + area.height - height, Math.round(bounds.y + (bounds.height - height) / 2))),
    minimizable: false, maximizable: false, fullscreenable: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, "window-preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(options.title)}</title><style>
    *{box-sizing:border-box}html,body{height:100%;margin:0}body{font:14px/1.5 system-ui,sans-serif;color:#242a35;background:#fafcff;display:flex;flex-direction:column;padding:22px;gap:16px}
    h1{font-size:18px;line-height:1.4;margin:0;flex:none;overflow-wrap:anywhere;max-height:20%;overflow:auto}
    pre{margin:0;flex:1;min-height:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;border:1px solid #dde2ea;border-radius:10px;background:white;font:13px/1.6 ui-monospace,monospace}
    footer{flex:none}p{margin:0 0 14px;color:#667085;font-size:12px;overflow-wrap:anywhere;max-height:64px;overflow:auto}nav{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}button{font:inherit;padding:8px 14px;border:1px solid #ccd3df;border-radius:8px;background:white;color:inherit;cursor:pointer}button:focus-visible{outline:2px solid #1677ff;outline-offset:2px}
    </style></head><body><h1>${escapeHtml(options.message)}</h1><pre tabindex="0">${escapeHtml(options.detail)}</pre><footer><p>${escapeHtml(options.footer)}</p><nav>${options.buttons.map((label, index) => `<button type="button" data-response="${index}"${index === 0 ? " autofocus" : ""}>${escapeHtml(label)}</button>`).join("")}</nav></footer></body></html>`;
  return new Promise(resolve => {
    let settled = false;
    const finish = (response: number): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      resolve(response);
      if (!win.isDestroyed()) win.destroy();
    };
    const abort = (): void => finish(0);
    options.signal.addEventListener("abort", abort, { once: true });
    win.on("closed", abort);
    win.webContents.ipc.on("permission:respond", (_event, response: unknown) => {
      if (response === 0 || response === 1 || response === 2) finish(response);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("render-process-gone", abort);
    win.once("ready-to-show", () => { if (!settled) win.show(); });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(abort);
    if (options.signal.aborted) abort();
  });
}
