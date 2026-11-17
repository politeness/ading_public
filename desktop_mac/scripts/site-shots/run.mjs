/**
 * Generates the feature screenshots for the landing page (releases/site/shots/*.jpg).
 *
 * Real UI + demo data: opens src/index.html directly in Chromium,
 * substitutes demo-bridge.js for the main process, then overlays numbered callouts on the screenshots.
 *
 * Usage (run pnpm build first):
 *   npx -y playwright@1.56 install chromium   # only needed once
 *   node scripts/site-shots/run.mjs [output dir]
 * playwright must be importable (e.g. npm i -g playwright, then set NODE_PATH).
 */
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const outDir = process.argv[2] ?? path.join(root, "releases", "site", "shots");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = http.createServer(async (request, response) => {
  const file = path.join(root, decodeURIComponent(new URL(request.url, "http://x").pathname));
  if (!file.startsWith(root)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const origin = `http://localhost:${server.address().port}`;

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE?.trim();
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);
await mkdir(outDir, { recursive: true });

for (const language of ["zh", "en"]) {
const en = language === "en";
const l = (zh, english) => en ? english : zh;
const localeDir = path.join(outDir, language);
await mkdir(localeDir, { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  locale: en ? "en-US" : "zh-CN"
});
const page = await context.newPage();
page.on("pageerror", (error) => console.error("Page error:", error.message));
await page.addInitScript({ path: path.join(here, "demo-bridge.js") });
await page.goto(`${origin}/src/index.html?lang=${language}`);
await page.waitForTimeout(1200);

/** Overlay callouts: each item { selector, label, place, pad?, lift? }, numbered in order; lift raises an upper label further to avoid overlapping adjacent labels */
async function annotate(items) {
  await page.evaluate((items) => {
    document.querySelector("#shot-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "shot-overlay";
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:99999;font:600 13px -apple-system,'PingFang SC',sans-serif";
    items.forEach((item, index) => {
      const target = document.querySelector(item.selector);
      if (!target) throw new Error(`Not found: ${item.selector}`);
      const r = target.getBoundingClientRect();
      const pad = item.pad ?? 4;
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;border:2px solid #ff6a3d;border-radius:10px;box-shadow:0 0 0 4px rgb(255 106 61 / 18%)`;
      const tag = document.createElement("div");
      tag.style.cssText = "position:absolute;display:flex;align-items:center;gap:6px;white-space:nowrap;padding:4px 10px 4px 4px;color:#fff;background:#ff6a3d;border-radius:999px;box-shadow:0 4px 12px rgb(0 0 0 / 18%)";
      tag.innerHTML = `<span style="display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#fff;color:#ff6a3d;font-size:12px">${index + 1}</span>${item.label}`;
      const place = item.place ?? "bottom";
      const at = {
        bottom: `left:${r.left}px;top:${r.bottom + pad + 8}px`,
        top: `left:${r.left}px;top:${r.top - pad - 36 - (item.lift ?? 0)}px`,
        bottomRight: `right:${innerWidth - r.right}px;top:${r.bottom + pad + 8}px`,
        topRight: `right:${innerWidth - r.right}px;top:${r.top - pad - 36 - (item.lift ?? 0)}px`,
        left: `right:${innerWidth - r.left + pad + 8}px;top:${r.top + r.height / 2 - 14}px`,
        right: `left:${r.right + pad + 8}px;top:${r.top + r.height / 2 - 14}px`,
        inside: `left:${r.left + 10}px;top:${r.top + 10}px`,
        center: `left:${r.left + r.width / 2 - 140}px;top:${r.top + r.height * 0.62}px`
      }[place];
      tag.style.cssText += `;${at}`;
      overlay.append(box, tag);
    });
    document.body.append(overlay);
  }, items);
}

async function shot(name) {
  // Hovering over a button shows a native tooltip; move the mouse away before the screenshot
  await page.mouse.move(1, 799);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(localeDir, `${name}.jpg`), type: "jpeg", quality: 82 });
  await page.evaluate(() => document.querySelector("#shot-overlay")?.remove());
  console.log(`SHOT=${path.join(localeDir, `${name}.jpg`)}`);
}

const openTask = (id) => page.evaluate((id) => {
  const button = document.querySelector(`.task-list-item[data-task-id="${id}"] .task-list-button`);
  if (!button) throw new Error(`Not found in task list: ${id}`);
  button.click();
}, id);

// ⓪ Chat with Agents like you chat on DingTalk
await page.click("#tab-contacts");
await page.waitForTimeout(300);
await page.evaluate(() => window.adingDemo.busy("t_direct", "a_cc", 5));
await page.evaluate(() => {
  const row = document.querySelector('.contact-list-item[data-user-id="a_cc"] .contact-button');
  row?.click();
});
await page.waitForTimeout(500);
await annotate([
  { selector: "#agents-entry", label: l("探索小a：让 Agent 亮绿灯，加为好友", "Explore Agents: get them ready and add them"), place: "left" },
  { selector: '.contact-list-item[data-user-id="a_cc"] .ikkyu-thinking', label: l("一休在思考：它正在干活", "Ikkyu is thinking: the Agent is working"), place: "bottom", pad: 6 },
  { selector: "#task-switcher-button", label: l("切换任务", "Switch task"), place: "left" },
  { selector: "#task-new-button", label: l("新建任务", "New task"), place: "bottomRight" },
  { selector: "#task-agent-menu-button", label: l("参与 Agent", "Participating Agents"), place: "left" },
  { selector: "#stop-button", label: l("暂停", "Pause"), place: "left" }
]);
await shot("chat");
await page.click("#tab-tasks");
await page.waitForTimeout(300);

// ① Create a group + Leader
await openTask("t_site");
await page.waitForTimeout(300);
await page.evaluate(() => {
  window.adingDemo.busy("t_site", "a_q", 10);
}, []);
await page.evaluate((text) => window.adingDemo.progress("t_site", "a_q", text, 11), l("正在编写第 5 项「远程指挥」的文案", "Writing feature 5: Remote control"));
await page.click("#task-agent-menu-button");
await page.waitForTimeout(300);
await page.evaluate(() => { document.querySelector("#messages").scrollTop = 0; });
await annotate([
  { selector: "#new-group", label: l("新建任务：选择要拉进群的 Agent", "New task: choose the Agents to add"), place: "bottom" },
  { selector: ".task-agent-leader.active", label: l("点皇冠指定 Leader", "Select the crown to appoint the Leader"), place: "left", pad: 6 },
  { selector: "#messages article:nth-of-type(2) .bubble", label: l("Leader 拆解、分工", "The Leader breaks down and delegates work"), place: "right" },
  { selector: "#report-task", label: l("随时让 Leader 汇报", "Ask the Leader to report anytime"), place: "left" }
]);
await shot("team");
await page.click("#task-agent-menu-button");

// ② @ hand-off
await page.evaluate(() => { const m = document.querySelector("#messages"); m.scrollTop = m.scrollHeight; });
await page.fill("#composer textarea", l("@小c 小q 写完后，你来统一 review", "@Cody Review everything after Quinn finishes"));
await page.waitForTimeout(200);
await annotate([
  { selector: "#composer .composer-box", label: l("输入 @名字 派给指定成员，其它 Agent 暂不消耗 token", "Type @name to assign one member; other Agents use no tokens yet"), place: "top" },
  { selector: "#messages article:nth-last-of-type(2) .bubble", label: l("@ 其它 Agent，自动读取上下文，不用重复交代", "@mention another Agent; it reads the shared context automatically"), place: "left" }
]);
await shot("relay");
await page.fill("#composer textarea", "");

// ③ Activity
await page.click("#toggle-process");
for (const [i, text] of [
  l("读取 site/index.html 的初稿", "Reading the first draft of site/index.html"),
  l("对照群里的方案，列出第 5–10 项的提纲", "Outlining features 5–10 from the agreed plan"),
  l("写入「远程指挥」一节", "Writing the Remote control section"),
  l("正在编写第 6 项「共享 Agent」的文案", "Writing feature 6: Share Agents")
].entries()) {
  await page.evaluate(([text, rev]) => window.adingDemo.progress("t_site", "a_q", text, rev), [text, 20 + i]);
}
await page.waitForTimeout(400);
await annotate([
  { selector: "#toggle-process", label: l("打开信息流", "Open Activity"), place: "left" },
  { selector: "#process-panel", label: l("每个 Agent 正在做什么，一目了然", "See what every Agent is doing"), place: "center", pad: 2 },
  { selector: "#composer .composer-box", label: l("随时插话纠偏，或暂停任务", "Send guidance or pause the task at any time"), place: "top" }
]);
await shot("process");
await page.click("#toggle-process");

// ④ Permissions
await page.click("#agents-entry");
await page.waitForTimeout(500);
await annotate([
  { selector: "#permission-mode", label: l("选择谁来审批 Agent 的敏感操作", "Choose who reviews sensitive Agent actions"), place: "bottom" },
  { selector: "#agent-rows", label: l("本机已接入的 Agent，绿灯即可派活", "Local Agents are ready when their status is green"), place: "bottom", pad: 2 }
]);
await shot("permission");

await context.close();
}
await browser.close();
server.close();
