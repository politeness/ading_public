/**
 * Landing page template.
 *
 * The content is an overview of the whole app and doesn't change per version: a new release does not regenerate or redeploy this page.
 * The download URL and latest version are read in the browser from release.json in the same directory — a release only updates release.json,
 * so the page's download link always points to the latest version, and the page's version never mismatches the actual package.
 *
 * The Chinese and English pages are generated as separate files (/ading/ and /ading/en/), with content from FEATURES and FEATURES_EN respectively.
 * Regenerate and redeploy only when the page copy changes: node scripts/make-site.mjs
 * Feature screenshots are generated into shots/ by scripts/site-shots/run.mjs.
 */

import qrcode from "qrcode-generator";
import { requiredLocal } from "./local-env.mjs";

// Public URL prefix for promo videos; the bucket name stays out of the repo
const VIDEO_BASE = requiredLocal("ADING_SITE_VIDEO_BASE_URL").replace(/\/+$/, "");

/** Self-hosted Homebrew tap: github.com/politeness/homebrew-ading. The fully qualified form taps automatically, so one command is enough */
export const BREW_COMMAND = "brew install --cask politeness/ading/ading";

/**
 * The iPhone app's App Store ID (App Store Connect → "App Information" → Apple ID, a string of digits).
 * Once approved by App Store review and actually downloadable, set IOS_APP_AVAILABLE to true to show the download button and QR code.
 * The link has no region; Apple redirects to the visitor's regional store.
 */
export const IOS_APP_ID = "6816359614";
export const IOS_APP_AVAILABLE = true;
export const IOS_APP_URL = IOS_APP_AVAILABLE && IOS_APP_ID ? `https://apps.apple.com/app/id${IOS_APP_ID}` : "";

/** The QR code is drawn as inline SVG at page generation, with no external service. Fixed black on white: some cameras can't scan inverted codes in dark mode */
function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 2;
  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }
  const size = count + margin * 2;
  return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** Canonical site URL: canonical, hreflang, sitemap and share images all use absolute URLs */
export const SITE_ORIGIN = "https://www.coffeestudy.com.cn";
export const SITE_URLS = { zh: `${SITE_ORIGIN}/ading/`, en: `${SITE_ORIGIN}/ading/en/` };
export const ICP_NUMBER = "沪ICP备2025129352号-2";

export const AGENTS = [
  { name: "Claude Code", file: "claude-code.png" },
  { name: "Codex", file: "codex.png" },
  { name: "Qoder", file: "qoder.png" },
  { name: "Qoder CN", file: "qoder-cn.png" },
  { name: "Qwen Code", file: "qwen-code.png" },
  { name: "Kiro", file: "kiro.png" },
  { name: "GitHub Copilot", file: "copilot.png" },
  { name: "Antigravity", file: "antigravity.png" }
];

/**
 * Top ten features. ready=true entries must have a shot (or figure); steps map one-to-one to the numbers on the screenshot.
 * Unbuilt ones use plan, and the page shows the "coming soon" illustration instead of a screenshot.
 */
export const FEATURES = [
  {
    title: "像聊钉钉一样，和 Agent 们聊天",
    ready: true,
    scene: "想给手下的 Agent 们派活、问进展、聊想法，而不是对着一个个终端窗口敲命令。",
    how: "在这里向你所有的 Agent 发起任务，像在钉钉上和同事聊天一样和它们对话。在阿钉里，它们不再是一个个冰冷的工具，而是有名字、有头像、会回消息、会忙起来的活生生的碳基人。",
    shot: "shots/chat.jpg",
    steps: [
      "点「探索小a」，按提示让 Agent 亮起绿灯，加为好友，它们就是你的碳基好友们",
      "名字旁的一休在思考，说明它正在干活",
      "切换任务：在它的多个任务之间切换",
      "新建任务：给它新开一个任务",
      "参与 Agent：查看这个任务里有哪些 Agent",
      "暂停：让正在干活的 Agent 停下来"
    ]
  },
  {
    title: "拉群组队，Leader 带队交付",
    ready: true,
    scene: "任务复杂、对质量要求高，希望团队充分讨论、自主推进、统一交付。",
    how: "把多个 Agent 拉进同一个任务群，指定一位 Leader。Leader 带大家讨论问题、商定方案、分配任务、review 结果，最后统一向你汇报。",
    shot: "shots/team.jpg",
    steps: [
      "点任务列表右上角的「新建任务」，选择要拉进群的 Agent（「快速发起新任务」会默认拉上所有 Agent）",
      "在「参与 Agent」里点皇冠，指定 Leader",
      "说清目标，Leader 负责拆解、分工、review",
      "想看进展，点「汇报」让 Leader 汇总"
    ]
  },
  {
    title: "@xx 接力，上下文不丢",
    ready: true,
    scene: "想让不同 Agent 分头做、依次接力，或者某个 Agent 额度快用完了，需要换人接着干。",
    how: "在群里 @ 哪个 Agent，活就派给它。群里的讨论和进展大家都看得到，换人不用把背景再讲一遍。",
    shot: "shots/relay.jpg",
    steps: [
      "在输入框里输入 @名字，把活派给指定成员，其它 Agent 暂不消耗 token",
      "消息里 @ 其它 Agent，它会自动读取上下文，不用重复交代"
    ]
  },
  {
    title: "一次沉淀，全员共享",
    ready: true,
    scene: "不想给每个 Agent 各教一遍同样的规矩和经验，换 Agent 时也不想从头再来。",
    how: "Agent 在任务里沉淀下来的 skill 和 memory，会存进阿钉的公共库，再按各家自己的格式同步给所有 Agent。全程自动，不改动你自己的全局配置。",
    figure: "skills",
    steps: [
      "任何一个 Agent 学会的做法，先存进阿钉的公共库",
      "阿钉按各家格式，同步给每个参与任务的 Agent",
      "新加入的 Agent 也能自动获取这些 skill 和 memory"
    ]
  },
  {
    title: "远程指挥，随时随地",
    ready: true,
    scene: "人不在电脑前，也想给家里或公司电脑上的 Agent 派活、看进展。",
    video: VIDEO_BASE + "/%E8%BF%9C%E7%A8%8B%E5%8D%8F%E4%BD%9C%E5%B9%BF%E5%91%8A30%E7%A7%92.mp4",
    how: "在 iPhone 和 Mac 上登录同一个阿钉账号，即可发消息、创建会话、发送附件、查看 Agent 的进展和回复。Mac 需要保持联网并运行阿钉；AI 在 Mac 上执行，手机本身不运行 AI。"
  },
  {
    title: "过程透明，随时插话",
    ready: true,
    scene: "想知道 Agent 此刻在做什么，发现跑偏了能及时拉回来。",
    how: "打开信息流，实时查看每个 Agent 的每一步；正在工作的 Agent，名字旁会出现一休的「思考中」动画。任务进行中也能直接发消息纠偏，或者一键暂停。",
    shot: "shots/process.jpg",
    steps: [
      "点「信息流」按钮",
      "按成员查看每一步操作，执行中的一目了然",
      "在输入框里插话纠偏，或点暂停"
    ]
  },
  {
    title: "权限可控，放心放手",
    ready: true,
    scene: "Agent 需要额外权限时希望有人把关，又不想事事亲自审批。",
    how: "三档可选：人工审核（每次由你批准）；agent 自动审核（交给任务的 Leader 把关，拿不准再问你）；无人值守（全部自动允许）。",
    shot: "shots/permission.jpg",
    steps: [
      "点右上角「探索小a」，在「权限设置」里选择审批方式",
      "列表里是本机已接入的 Agent，绿灯表示随时可以派活"
    ]
  },
  {
    title: "按能力分工，好钢用在刀刃上",
    ready: true,
    scene: "想把复杂任务拆开：难题交给能力强（也更贵）的模型，简单活交给便宜的。",
    how: "在 Agent 个人详情里选择模型，再把不同 Agent 拉进群，由 Leader 拆解任务、安排分工。复杂任务和简单工作可以交给不同模型处理。",
    shot: "shots/ability-20261103.jpg",
    demo: true
  },
  {
    title: "共享 Agent",
    ready: true,
    scene: "想让家人、朋友或同事，也用上你配置好的 Agent。",
    how: "把 Agent 分享给指定的人，对方在自己的阿钉里就能给它派活。",
    warn: "共享前请确认 Agent 能访问的目录和权限，注意数据安全。",
    shot: "shots/sharing-20261103.jpg",
    demo: true
  },
  {
    title: "人机混编，一视同仁",
    ready: true,
    scene: "真人同事和 Agent 要在同一个项目里协作。",
    how: "把多位真人联系人和多个 Agent 拉进同一个群，一起讨论、分工、交付。碳基人、硅基人不再有区别。",
    shot: "shots/human-team-20261103.jpg",
    demo: true
  }
];

/** English copy mirrors FEATURES item-for-item so the two versions can never drift in coverage. */
export const FEATURES_EN = [
  {
    title: "Chat with Agents like teammates",
    ready: true,
    scene: "You want to assign work, ask for updates, and talk through ideas with your Agents instead of typing commands into separate terminal windows.",
    how: "Start tasks for any of your Agents and chat with them as naturally as you would with coworkers. In ADing, each Agent has a name and avatar, replies in the conversation, and visibly gets to work.",
    shot: "shots/chat.jpg",
    steps: [
      "Open Explore Agents, follow the prompts, and add ready Agents to your contacts",
      "The Ikkyu thinking indicator means the Agent is working",
      "Switch tasks: move between this Agent's tasks",
      "New task: start another task for this Agent",
      "Participating Agents: see who's involved",
      "Pause: stop the Agent's current work"
    ]
  },
  {
    title: "Build a team and let the Leader deliver",
    ready: true,
    scene: "The task is complex and quality matters, so you want the team to discuss, coordinate, and deliver as one.",
    how: "Bring several Agents into one task and appoint a Leader. The Leader guides the discussion, agrees on a plan, delegates work, reviews the results, and reports back to you.",
    shot: "shots/team.jpg",
    steps: [
      "Select New task and choose the Agents to add (Quick start adds every Agent by default)",
      "Select the crown in Participating Agents to appoint the Leader",
      "State the goal; the Leader breaks it down, delegates, and reviews",
      "Select Report whenever you want the Leader to summarize progress"
    ]
  },
  {
    title: "@mention handoffs without losing context",
    ready: true,
    scene: "You want Agents to work separately or hand work off in sequence, including when one Agent is running low on quota.",
    how: "@mention an Agent in the group and the work goes to it. Everyone can see the discussion and progress, so a handoff never requires repeating the background.",
    shot: "shots/relay.jpg",
    steps: [
      "Type @name to assign a specific member; the other Agents do not consume tokens yet",
      "@mention another Agent and it automatically reads the shared context"
    ]
  },
  {
    title: "Capture once, share with every Agent",
    ready: true,
    scene: "You do not want to teach every Agent the same rules and lessons again, or start over when you switch Agents.",
    how: "Skills and memories learned during a task go into ADing's shared library, then sync to every Agent in the format it understands. It happens automatically without changing your own global configuration.",
    figure: "skills",
    steps: [
      "A lesson learned by any Agent first goes into ADing's shared library",
      "ADing syncs it to every participating Agent in the right format",
      "New Agents automatically receive the shared skills and memories"
    ]
  },
  {
    title: "Work remotely, anytime",
    ready: true,
    scene: "You are away from your computer but still want to assign work and check progress on Agents running at home or at the office.",
    video: VIDEO_BASE + "/e%E8%BF%9C%E7%A8%8B%E5%8D%8F%E4%BD%9C%E5%B9%BF%E5%91%8A30%E7%A7%92.mp4",
    how: "Sign in to the same ADing account on iPhone and Mac to send messages, start conversations, share attachments, and follow Agent progress and replies. Keep your Mac online with ADing running. AI runs on your Mac; your phone is its companion."
  },
  {
    title: "See every step and step in anytime",
    ready: true,
    scene: "You want to see what an Agent is doing now and correct course before it goes too far.",
    how: "Open Activity to see every Agent action in real time. Working Agents show an Ikkyu thinking indicator beside their names. You can also send guidance while a task is running or pause it immediately.",
    shot: "shots/process.jpg",
    steps: [
      "Select Activity",
      "See what each member is doing, including work in progress",
      "Send guidance at any time, or pause the task"
    ]
  },
  {
    title: "Controlled permissions, confident delegation",
    ready: true,
    scene: "Agents need additional permissions, but you want oversight without approving every routine action yourself.",
    how: "Choose one of three modes: Manual review (you approve every request), Agent auto-review (the task Leader decides and asks you when unsure), or Unattended (requests are allowed automatically).",
    shot: "shots/permission.jpg",
    steps: [
      "Open Explore Agents and choose a review mode under Permissions",
      "The list shows local Agents; a green status means they are ready for work"
    ]
  },
  {
    title: "Assign by ability and spend wisely",
    ready: true,
    scene: "You want to split complex work so the strongest models handle the hard parts and lower-cost models handle simpler work.",
    how: "Choose a model in the Agent’s profile, then bring different Agents into a group and let the Leader break down and assign the work. Use different models for complex tasks and simpler work.",
    shot: "shots/ability-20261103.jpg",
    demo: true
  },
  {
    title: "Share Agents",
    ready: true,
    scene: "You want family, friends, or coworkers to use an Agent you have already configured.",
    how: "Share an Agent with selected people so they can assign work to it from their own ADing app.",
    warn: "Before sharing, review the directories and permissions the Agent can access and protect sensitive data.",
    shot: "shots/sharing-20261103.jpg",
    demo: true
  },
  {
    title: "Humans and Agents, one team",
    ready: true,
    scene: "Human coworkers and Agents need to collaborate in the same project.",
    how: "Bring multiple people and Agents into one task to discuss, delegate, and deliver together. Humans and Agents work on equal footing.",
    shot: "shots/human-team-20261103.jpg",
    demo: true
  }
];

const escape = (text) => String(text)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "Coming soon" illustration: a little robot in a hard hat hammering a big nail. Original, not based on any existing character */
export const comingSoonSvg = (caption = "施工中 · 工程师正在加班敲钉子", locale = "zh") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300" role="img" aria-label="${locale === "en" ? "Under construction, coming soon" : "施工中，敬请期待"}">
  <rect width="480" height="300" rx="18" fill="#fff7ed"/>
  <g fill="none" stroke="#fed7aa" stroke-width="2" stroke-dasharray="6 8"><path d="M24 250h432"/></g>
  <!-- Big nail -->
  <g transform="translate(330 92)">
    <rect x="-34" y="0" width="68" height="16" rx="5" fill="#94a3b8"/>
    <path d="M-10 16h20v104l-10 22-10-22z" fill="#cbd5e1"/>
    <path d="M-10 40h20M-10 64h20M-10 88h20" stroke="#94a3b8" stroke-width="3"/>
  </g>
  <!-- Impact lines -->
  <g stroke="#f97316" stroke-width="4" stroke-linecap="round">
    <path d="M296 70l-12-14M330 60v-18M364 70l12-14"/>
  </g>
  <!-- Robot -->
  <g transform="translate(170 118)">
    <rect x="-44" y="44" width="88" height="80" rx="18" fill="#3b82f6"/>
    <rect x="-24" y="64" width="48" height="30" rx="8" fill="#dbeafe"/>
    <circle cx="-10" cy="79" r="4" fill="#f97316"/><circle cx="4" cy="79" r="4" fill="#22c55e"/><circle cx="16" cy="79" r="3" fill="#3b82f6"/>
    <rect x="-34" y="124" width="18" height="16" rx="6" fill="#1e3a8a"/><rect x="16" y="124" width="18" height="16" rx="6" fill="#1e3a8a"/>
    <!-- Head -->
    <rect x="-40" y="-18" width="80" height="58" rx="20" fill="#60a5fa"/>
    <circle cx="-15" cy="12" r="9" fill="#fff"/><circle cx="15" cy="12" r="9" fill="#fff"/>
    <circle cx="-13" cy="14" r="4.5" fill="#1e293b"/><circle cx="17" cy="14" r="4.5" fill="#1e293b"/>
    <path d="M-10 30q10 7 20 0" stroke="#1e293b" stroke-width="3" fill="none" stroke-linecap="round"/>
    <!-- Sweat -->
    <path d="M46 -2q6 10 0 14q-6-4 0-14z" fill="#38bdf8"/>
    <!-- Hard hat -->
    <path d="M-46 -12q0-40 46-40t46 40z" fill="#facc15"/>
    <rect x="-52" y="-16" width="104" height="10" rx="5" fill="#eab308"/>
    <rect x="-6" y="-50" width="12" height="36" rx="5" fill="#eab308"/>
    <!-- Arm + hammer -->
    <path d="M40 60q34-6 58-36" stroke="#3b82f6" stroke-width="12" stroke-linecap="round" fill="none"/>
    <g transform="translate(100 22) rotate(-35)">
      <rect x="-5" y="-6" width="10" height="40" rx="4" fill="#92400e"/>
      <rect x="-22" y="-20" width="44" height="18" rx="5" fill="#475569"/>
    </g>
    <path d="M-40 60q-20 10-22 34" stroke="#3b82f6" stroke-width="12" stroke-linecap="round" fill="none"/>
  </g>
  <!-- Barrier -->
  <g transform="translate(64 196)">
    <path d="M18 0h16l14 54H4z" fill="#f97316"/>
    <path d="M13 18h26M9 34h34" stroke="#fff" stroke-width="7"/>
    <rect x="-4" y="52" width="60" height="8" rx="3" fill="#c2410c"/>
  </g>
  <text x="240" y="284" text-anchor="middle" font-family="-apple-system,'PingFang SC',sans-serif" font-size="17" font-weight="600" fill="#c2410c">${escape(caption)}</text>
</svg>
`;

/** Skill / memory sync diagram (this feature has no UI of its own; it is fully automatic) */
const skillsFigure = (locale) => {
  const en = locale === "en";
  return `<svg class="diagram" viewBox="0 0 640 360" role="img" aria-label="${en ? "ADing syncs skills and memories from its shared library to every Agent" : "阿钉公共库把 skill 和 memory 同步给各家 Agent"}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="currentColor"/>
    </marker>
  </defs>
  <g class="d-muted" fill="none" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)">
    <path d="M168 88C220 88 230 150 262 158"/>
    <path d="M378 168C420 150 430 70 468 64"/>
    <path d="M378 180H466"/>
    <path d="M378 192C420 210 430 290 468 296"/>
    <path d="M262 210C220 222 214 268 170 272"/>
  </g>
  <g class="d-card">
    <rect x="24" y="56" width="144" height="64" rx="12"/>
    <text x="96" y="84" text-anchor="middle" class="d-title">${en ? "Cody learned" : "小c 学会了"}</text>
    <text x="96" y="106" text-anchor="middle" class="d-sub">${en ? "Run tests before commit" : "「提交前先跑测试」"}</text>
  </g>
  <g class="d-card d-new">
    <rect x="24" y="240" width="144" height="64" rx="12"/>
    <text x="96" y="268" text-anchor="middle" class="d-title">${en ? "New Agent" : "新加入的 Agent"}</text>
    <text x="96" y="290" text-anchor="middle" class="d-sub">${en ? "Gets it automatically" : "自动获取"}</text>
  </g>
  <g class="d-hub">
    <rect x="262" y="128" width="116" height="104" rx="16"/>
    <text x="320" y="168" text-anchor="middle" class="d-title">${en ? "ADing" : "阿钉"}</text>
    <text x="320" y="192" text-anchor="middle" class="d-sub">${en ? "Shared library" : "公共库"}</text>
    <text x="320" y="212" text-anchor="middle" class="d-sub">skill · memory</text>
  </g>
  <g class="d-card">
    <rect x="468" y="36" width="150" height="56" rx="12"/>
    <text x="543" y="60" text-anchor="middle" class="d-title">Claude Code</text>
    <text x="543" y="80" text-anchor="middle" class="d-sub">.claude/skills</text>
    <rect x="468" y="152" width="150" height="56" rx="12"/>
    <text x="543" y="176" text-anchor="middle" class="d-title">Codex</text>
    <text x="543" y="196" text-anchor="middle" class="d-sub">AGENTS.md</text>
    <rect x="468" y="268" width="150" height="56" rx="12"/>
    <text x="543" y="292" text-anchor="middle" class="d-title">Qoder / Qoder CN</text>
    <text x="543" y="312" text-anchor="middle" class="d-sub">AGENTS.md</text>
  </g>
  <g class="d-badge">
    <circle cx="190" cy="118" r="12"/><text x="190" y="123" text-anchor="middle">1</text>
    <circle cx="420" cy="118" r="12"/><text x="420" y="123" text-anchor="middle">2</text>
    <circle cx="214" cy="258" r="12"/><text x="214" y="263" text-anchor="middle">3</text>
  </g>
</svg>`;
};

function renderFeature(feature, index, locale, base) {
  const en = locale === "en";
  const number = String(index + 1).padStart(2, "0");
  const badge = feature.ready
    ? `<span class="badge ready">${en ? "Available" : "已支持"}</span>`
    : `<span class="badge soon">${en ? "Coming soon" : "敬请期待"}</span>`;
  const steps = feature.steps?.length
    ? `<ol class="marks">${feature.steps.map((step) => `<li>${escape(step)}</li>`).join("")}</ol>`
    : "";
  const warn = feature.warn ? `<p class="warn">⚠️ ${escape(feature.warn)}</p>` : "";
  const shotPath = feature.shot ? `${base}shots/${locale}/${feature.shot.replace(/^shots\//, "")}` : "";
  const shotAlt = feature.demo
    ? (en ? `${feature.title} — ADing interface example` : `${feature.title}的阿钉界面演示`)
    : (en ? `${feature.title} example` : `${feature.title} 的使用示意`);
  const media = feature.shot
    ? `<a class="shot" data-zoom href="${shotPath}" target="_blank" rel="noopener"><img src="${shotPath}" alt="${escape(shotAlt)}" loading="lazy" width="1280" height="800" /></a>`
    : feature.figure === "skills"
      ? `<div class="shot figure">${skillsFigure(locale)}</div>`
      : feature.video
        ? `<div class="shot remote-video"><video controls playsinline preload="metadata" aria-label="${en ? "ADing remote collaboration demo" : "阿钉远程协作演示"}" src="${feature.video}"></video></div>`
        : `<div class="shot soon-art">${comingSoonSvg(feature.soon, locale)}</div>`;
  return `
    <article class="feature ${feature.ready ? "is-ready" : "is-soon"}">
      <div class="feature-text">
        <div class="feature-head"><span class="num">${number}</span>${badge}</div>
        <h3>${escape(feature.title)}</h3>
        <p class="label">${en ? "USE CASE" : "使用场景"}</p>
        <p>${escape(feature.scene)}</p>
        <p class="label">${feature.ready ? (en ? "HOW IT WORKS" : "使用说明") : (en ? "PLANNED EXPERIENCE" : "设想中的用法")}</p>
        <p>${escape(feature.how)}</p>
        ${warn}
        ${steps}
      </div>
      <div class="feature-media">${media}</div>
    </article>`;
}

function renderLocale(locale, base) {
  const en = locale === "en";
  const features = en ? FEATURES_EN : FEATURES;
  const ordered = [...features.filter((feature) => feature.ready), ...features.filter((feature) => !feature.ready)];
  const copy = en ? {
    brand: "ADing",
    slogan: "DingTalk for Agents",
    subline: "Bring your AI assistants together as a team. Humans and Agents, on equal footing.",
    download: "Download ADing",
    requirement: "macOS 14+ · Apple silicon · Free",
    brew: "Or install with Homebrew",
    copy: "Copy",
    desktopTitle: "Desktop · Mac",
    iphoneTitle: "Mobile · iPhone",
    iphoneLead: "Put the Agents on your Mac to work from your phone: send messages, start tasks and check progress.",
    iphoneRequirement: "iOS 17+ · Free · Sign in to the same account as your Mac",
    iphoneGet: "Download on the App Store",
    iphoneSoon: "Submitted · awaiting App Store review",
    iphoneScan: "Scan with your iPhone camera",
    guideTitle: "First time here? Start in three steps",
    guideSteps: ["Install ADing on an Apple silicon Mac running macOS 14 or later. Install and sign in to a supported Agent, such as Codex, Claude Code or Qoder.", "Create your ADing account in the Mac app and sign in. You can also use the Mac app standalone without an account.", "Sign in to the same account on iPhone. Keep ADing running on your Mac with an internet connection so its Agents can work and send replies."],
    help: "Need help?",
    agentsTitle: "Supported Agents",
    agentsLead: "ADing does not include Agents or collect their fees. Install and subscribe to the Agents you use, then add them as contacts for direct and group conversations.",
    agentsNote: "More Agents are on the way.",
    featuresTitle: "Core features",
    compatibilityTitle: "ADing compatibility notice",
    compatibilityBody: "ADing requires macOS 14 or later and Apple silicon (M1 or newer). Intel Macs are not supported.",
    compatibilityConfirm: "Confirm that this Mac meets the requirements before downloading.",
    cancel: "Cancel",
    continue: "Continue download"
  } : {
    brand: "阿钉",
    slogan: "给 agent 用的钉钉",
    subline: "把你的 AI 助手们组成一个团队；碳基人、硅基人，一视同仁。",
    download: "下载阿钉",
    requirement: "macOS 14+ · Apple 芯片 · 免费",
    brew: "或者用 Homebrew 安装",
    copy: "复制",
    desktopTitle: "桌面版 · Mac",
    iphoneTitle: "移动版 · iPhone",
    iphoneLead: "在手机上给电脑上的 Agent 派活：发消息、建任务、看进展。",
    iphoneRequirement: "iOS 17+ · 免费 · 和电脑版登录同一个账号",
    iphoneGet: "在 App Store 下载",
    iphoneSoon: "已提交 · 等待 App Store 审核",
    iphoneScan: "用 iPhone 相机扫码下载",
    guideTitle: "第一次使用？三步开始",
    guideSteps: ["在 Apple 芯片、macOS 14 或更新的 Mac 上安装阿钉，并安装、登录你使用的 Agent，例如 Codex、Claude Code 或 Qoder。", "在 Mac 阿钉中注册账号并登录；也可以不登录，以单机方式使用电脑版。", "在 iPhone 上登录同一个账号。保持 Mac 联网并运行阿钉，让电脑上的 Agent 执行并回复。"],
    help: "需要帮助？",
    agentsTitle: "目前支持的 Agent",
    agentsLead: "阿钉本身不含 agent，也不代收费用。自行安装和购买以下 agent 后，就能在阿钉里加好友、单聊、群聊。",
    agentsNote: "更多 Agent 陆续接入中。",
    featuresTitle: "主打功能",
    compatibilityTitle: "阿钉兼容性提醒",
    compatibilityBody: "阿钉仅支持 macOS 14 或更高版本、Apple 芯片（M1 或更新），暂不支持 Intel Mac。",
    compatibilityConfirm: "请确认当前 Mac 符合要求后继续下载。",
    cancel: "取消",
    continue: "继续下载"
  };
  return `<main class="locale locale-${locale}" lang="${en ? "en" : "zh-CN"}">
  <div class="wrap">
    <header>
      <div class="brand">
        <img src="${base}icon.png" alt="" width="72" height="72" />
        <h1>${copy.brand}</h1>
      </div>
      <p class="slogan">${copy.slogan}</p>
      <p class="subline">${copy.subline}</p>

      <div class="get" id="get-${locale}">
        <div class="desktop">
          <strong class="platform-title">${copy.desktopTitle}</strong>
          <a class="download" data-latest-download href="#get-${locale}">
            <strong>${copy.download}</strong>
            <span data-latest-version>${copy.requirement}</span>
          </a>
          <div class="brew">
            <span class="brew-label">${copy.brew}</span>
            <div class="brew-row">
              <code id="brew-command-${locale}">${BREW_COMMAND}</code>
              <button class="copy" type="button" data-copy="#brew-command-${locale}">${copy.copy}</button>
            </div>
          </div>
        </div>
        <div class="iphone" id="iphone-${locale}">
          <div class="iphone-text">
            <strong class="platform-title">${copy.iphoneTitle}</strong>
            <p>${copy.iphoneLead}</p>
            <span class="iphone-requirement">${copy.iphoneRequirement}</span>
            ${IOS_APP_URL
              ? `<a class="app-store" href="${IOS_APP_URL}" target="_blank" rel="noopener">${copy.iphoneGet}</a>`
              : `<span class="app-store soon">${copy.iphoneSoon}</span>`}
          </div>
          ${IOS_APP_URL ? `<figure class="iphone-qr">${qrSvg(IOS_APP_URL)}<figcaption>${copy.iphoneScan}</figcaption></figure>` : ""}
        </div>
      </div>
      <details class="quickstart" id="help-${locale}">
        <summary>${copy.guideTitle}</summary>
        <ol>${copy.guideSteps.map(step => `<li>${escape(step)}</li>`).join("")}</ol>
        <p>${copy.help} <a href="mailto:politeness1983@sina.com">politeness1983@sina.com</a></p>
      </details>
      <nav class="help-links" aria-label="${en ? "Support and policies" : "支持与条款"}">
        <a href="mailto:politeness1983@sina.com">${en ? "Contact support" : "联系支持"}</a>
        <a href="${base}terms.html#${locale}">${en ? "Terms of Use" : "用户协议"}</a>
        <a href="${base}privacy.html#${locale}">${en ? "Privacy Policy" : "隐私政策"}</a>
      </nav>
    </header>

    <section id="agents-${locale}">
      <h2>${copy.agentsTitle}</h2>
      <p class="section-lead">${copy.agentsLead}</p>
      <ul class="agents">
        ${AGENTS.map((agent) => `<li><img src="${base}agents/${agent.file}" alt="" width="22" height="22" />${escape(agent.name)}</li>`).join("\n        ")}
      </ul>
      <p class="note">${copy.agentsNote}</p>
    </section>

    <section id="features-${locale}">
      <h2>${copy.featuresTitle}</h2>
      <div class="features">
        ${ordered.map((feature, index) => renderFeature(feature, index, locale, base)).join("\n")}
      </div>
    </section>
  </div>

  <dialog class="compatibility-dialog" data-compatibility-dialog="${locale}">
    <div class="compatibility-card">
      <h2>${copy.compatibilityTitle}</h2>
      <p>${copy.compatibilityBody}</p>
      <p>${copy.compatibilityConfirm}</p>
      <div class="compatibility-actions">
        <button class="compatibility-cancel" type="button" data-compatibility-cancel>${copy.cancel}</button>
        <button class="compatibility-continue" type="button" data-compatibility-continue>${copy.continue}</button>
      </div>
    </div>
  </dialog>
  <footer id="friend-links-${locale}" class="friend-links" aria-label="${en ? "Links" : "友情链接"}">
    <h2>${en ? "Links" : "友情链接"}</h2>
    <div class="friend-links-badges">
    <a href="https://sellwithboost.com" target="_blank" rel="noopener noreferrer">
      <img src="https://sellwithboost.com/badge/listing.svg" alt="Listed on Sell With boost" height="40" loading="lazy" />
    </a>
<a href="https://launchkiwi.com/p/ading" target="_blank" rel="noopener">
  <img src="https://launchkiwi.com/badge-light.svg" alt="Featured on LaunchKiwi" width="198" height="62" />
</a>
<a href="https://smolhunt.com/projects/ading?utm_source=badge" target="_blank" rel="noopener noreferrer">
  <img src="https://smolhunt.com/smolhunt/images/badges/featured-on-light.svg" alt="Featured on Smol Hunt" style="height:44px;width:auto"/>
</a>
<a href="https://smolsaas.com/projects/ading?utm_source=badge" target="_blank" rel="noopener noreferrer">
  <img src="https://smolsaas.com/smolsaas/images/badges/featured-on-light.svg" alt="Featured on Smol Saas" style="height:44px;width:auto"/>
</a>
<a href="https://lookingfortools.com/projects/ading-2157?utm_source=badge" target="_blank" rel="noopener noreferrer">
  <img src="https://lookingfortools.com/lookingfortools/images/badges/featured-on-light.svg" alt="Featured on Looking For Tools" style="height:44px;width:auto"/>
</a>
<a href="https://supalaun.ch/projects/ading?utm_source=badge" target="_blank" rel="noopener noreferrer">
  <img src="https://supalaun.ch/supalaunch/images/badges/featured-on-light.svg" alt="Featured on Supa Launch" style="height:44px;width:auto"/>
</a>
<a href="https://findtop.tools/projects/ading?utm_source=badge" target="_blank" rel="noopener noreferrer">
  <img src="https://findtop.tools/findtoptools/images/badges/featured-on-light.svg" alt="Featured on Find Top Tools" style="height:44px;width:auto"/>
</a>
<a href="https://smolrank.com/projects/ading?utm_source=badge" target="_blank" rel="noopener noreferrer">
  <img src="https://smolrank.com/smolrank/images/badges/featured-on-light.svg" alt="Featured on Smol Rank" style="height:44px;width:auto"/>
</a>
<a href="https://smollaunchpad.com/projects/ading?utm_source=badge" target="_blank" rel="noopener noreferrer">
  <img src="https://smollaunchpad.com/smollaunchpad/images/badges/featured-on-light.svg" alt="Featured on Smol LaunchPad" style="height:44px;width:auto"/>
</a>
    </div>
    <p class="icp"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${ICP_NUMBER}</a></p>
  </footer>
</main>`;
}

const META = {
  zh: {
    title: "阿钉 ADing — 给 Agent 用的钉钉：多 Agent 协作，手机远程指挥 Claude Code、Codex",
    description: "阿钉（ADing）把 Claude Code、Codex、Qoder 等 AI 编程 Agent 拉进同一个群聊，像同事一样讨论、分工、接力、互相 review；还能在 iPhone 上远程给 Mac 上的 Agent 派活。碳基人、硅基人，一视同仁。"
  },
  en: {
    title: "ADing — DingTalk for Agents: multi-agent teamwork for Claude Code, Codex and more",
    description: "ADing brings Claude Code, Codex, Qoder and other AI coding agents into one group chat to discuss, delegate, hand off and review each other's work like teammates. Run the agents on your Mac and direct them remotely from your iPhone."
  }
};

/** Escape < in structured data so it doesn't end the script tag early */
const jsonLd = (data) => JSON.stringify(data).replace(/</g, "\\u003c");

/**
 * The Chinese page is at /ading/ and the English page at /ading/en/; separate URLs let search engines index each.
 * base is the relative path from the current page to the site directory; images, release.json and policy pages are located through it.
 */
export function renderSite(locale = "zh") {
  const en = locale === "en";
  const base = en ? "../" : "";
  const { title, description } = META[locale];
  const url = SITE_URLS[locale];
  const image = `${SITE_URLS.zh}shots/${locale}/team.jpg`;
  const structured = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: en ? "ADing" : "阿钉 ADing",
    alternateName: en ? "阿钉" : "ADing",
    description,
    url,
    image,
    inLanguage: en ? "en" : "zh-CN",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS 14+, iOS 17+",
    offers: { "@type": "Offer", price: "0", priceCurrency: en ? "USD" : "CNY" }
  };
  return `<!doctype html>
<html lang="${en ? "en" : "zh-CN"}" data-locale="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}" />
<link rel="canonical" href="${url}" />
<link rel="alternate" hreflang="zh-CN" href="${SITE_URLS.zh}" />
<link rel="alternate" hreflang="en" href="${SITE_URLS.en}" />
<link rel="alternate" hreflang="x-default" href="${SITE_URLS.zh}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${url}" />
<meta property="og:title" content="${escape(title)}" />
<meta property="og:description" content="${escape(description)}" />
<meta property="og:image" content="${image}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="${base}icon.png" />
<script type="application/ld+json">${jsonLd(structured)}</script>
<script>
  // Each language has its own URL. The ?lang= parameter and a language the user picked manually take priority; otherwise the Chinese page sends non-Chinese visitors to the English page based on browser language.
  // Search engine crawlers aren't redirected, so both URLs get indexed.
  (() => {
    const param = new URLSearchParams(location.search).get("lang");
    ${en ? `if (param === "zh" || param === "zh-CN") location.replace("../" + location.hash);` : `let saved = null;
    try { saved = localStorage.getItem("ading-site-locale"); } catch {}
    const language = (navigator.languages?.[0] || navigator.language || "").toLowerCase();
    const crawler = /bot|crawl|spider|slurp|preview/i.test(navigator.userAgent);
    const english = param === "en"
      || (!param && (saved === "en" || (!saved && !crawler && language !== "" && !language.startsWith("zh"))));
    if (english) location.replace("en/" + location.hash);`}
  })();
</script>
<style>
  :root {
    --text: #17171a; --secondary: #55555c; --muted: #8e8e96;
    --accent: #2f6fd0; --accent-soft: #eaf2ff; --line: #e9e9ec; --soft: #f7f7f8; --surface: #fff;
    --ready: #0f8a4a; --ready-soft: #e6f6ec; --soon: #c2410c; --soon-soft: #fff1e6;
    --code-bg: #eef4fd; --code-line: #cfdef5; --code-text: #1e2a3d; --code-muted: #6b7a90;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --text: #ececf0; --secondary: #a8a8b0; --muted: #75757d;
      --accent: #74a5e8; --accent-soft: #16233a; --line: #2a2a2f; --soft: #1a1a1d; --surface: #111113;
      --ready: #4ade80; --ready-soft: #10261a; --soon: #fb923c; --soon-soft: #2a1a0e;
      --code-bg: #16233a; --code-line: #2a3d5c; --code-text: #e3ebf7; --code-muted: #8a9ab3;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  .lang-switch {
    position: fixed; top: 16px; right: 16px; z-index: 80; display: flex; padding: 3px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 999px;
    box-shadow: 0 4px 16px rgb(15 23 42 / 8%);
  }
  .lang-switch a {
    padding: 4px 12px; font-size: 13px; line-height: 1.5; color: var(--secondary);
    text-decoration: none; border-radius: 999px;
  }
  .lang-switch a:hover { color: var(--text); }
  .lang-switch a[aria-current="page"] { color: #fff; background: var(--accent); cursor: default; }
  body {
    margin: 0; padding: 0 20px 96px;
    font: 15px/1.75 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
    color: var(--text); background: var(--surface);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  p { margin: 0 0 12px; }

  header { padding: 88px 0 64px; text-align: center; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 0 0 22px; }
  .brand img { width: 72px; height: 72px; display: block; }
  h1 { margin: 0; font-size: 44px; line-height: 1.1; letter-spacing: -.02em; font-weight: 700; }
  .slogan { margin: 0 0 10px; font-size: 26px; line-height: 1.35; font-weight: 650; letter-spacing: -.01em; }
  .subline { margin: 0 auto; max-width: 620px; font-size: 18px; color: var(--secondary); }

  .get {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0; align-items: stretch;
    max-width: 860px; margin: 28px auto 0; text-align: left;
    background: var(--soft); border: 1px solid var(--line); border-radius: 16px;
  }
  .quickstart { max-width: 860px; margin: 14px auto 0; text-align: left; color: var(--secondary); font-size: 13px; }
  .quickstart summary { cursor: pointer; color: var(--accent); }
  .quickstart ol { padding-left: 22px; }
  .quickstart li { margin: 8px 0; }
  .quickstart a { color: var(--accent); }
  .help-links { max-width: 860px; margin: 8px auto 0; display: flex; flex-wrap: wrap; gap: 16px; text-align: left; font-size: 12px; }
  .help-links a { color: var(--secondary); }
  .desktop { min-width: 0; padding: 18px 20px; }
  .platform-title { display: block; font-size: 16px; line-height: 1.4; }
  .desktop > .platform-title { margin-bottom: 12px; }
  .download {
    display: flex; flex-direction: column; justify-content: center; gap: 2px;
    padding: 10px 14px;
    color: #fff; text-decoration: none; background: var(--accent); border-radius: 10px;
    transition: transform .15s ease, opacity .15s ease;
  }
  .download:hover { opacity: .92; transform: translateY(-1px); }
  .download strong { font-size: 14px; }
  .download span { font-size: 11.5px; opacity: .85; }
  .brew {
    display: flex; flex-direction: column; gap: 3px; min-width: 0;
    margin-top: 10px; color: var(--code-text);
  }
  .brew-label { font-size: 12px; color: var(--code-muted); }
  .brew-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .brew code {
    flex: 1; min-width: 0; overflow-wrap: anywhere;
    font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .brew code::before { content: "$ "; color: var(--code-muted); }
  .copy {
    flex: none; padding: 3px 8px; color: var(--accent); font: inherit; font-size: 12px; font-weight: 600;
    background: var(--surface); border: 1px solid var(--code-line); border-radius: 8px; cursor: pointer;
  }
  .copy:hover { border-color: var(--accent); }

  /* Both platforms share a compact download panel; desktop on the left, mobile on the right. */
  .iphone {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    padding: 18px 20px; border-left: 1px solid var(--line);
  }
  .iphone-text { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
  .iphone-text p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--secondary); }
  .iphone-requirement { font-size: 11.5px; line-height: 1.6; color: var(--muted); }
  .app-store {
    margin-top: 4px; padding: 7px 14px; font-size: 13px; font-weight: 600; text-decoration: none;
    background: var(--text); color: var(--surface); border-radius: 10px; transition: opacity .15s ease;
  }
  .app-store:hover { opacity: .85; }
  .app-store.soon { color: var(--secondary); background: var(--surface); border: 1px dashed var(--line); }
  .iphone-qr { flex: none; align-self: center; width: 84px; margin: 0; text-align: center; }
  .iphone-qr svg { display: block; width: 84px; height: 84px; border-radius: 6px; }
  .iphone-qr figcaption { margin-top: 5px; font-size: 10.5px; line-height: 1.5; color: var(--muted); }

  section { padding: 56px 0; border-top: 1px solid var(--line); }
  h2 { margin: 0 0 6px; font-size: 26px; letter-spacing: -.01em; font-weight: 700; text-align: center; }
  .section-lead { margin: 0 auto 32px; max-width: 620px; color: var(--secondary); text-align: center; }

  /* There will be dozens of Agents: small icon + name, wrapped into a list */
  .agents { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; max-width: 820px; margin: 0 auto; padding: 0; list-style: none; }
  .agents li {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 14px 6px 8px; font-size: 14px; font-weight: 400; color: var(--secondary);
    background: var(--soft); border: 1px solid var(--line); border-radius: 999px;
  }
  @media(max-width:650px) { .agents { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  .agents img { width: 22px; height: 22px; border-radius: 6px; box-shadow: 0 0 0 1px var(--line); }
  .note { margin: 18px 0 0; font-size: 13.5px; color: var(--muted); text-align: center; }

  .features { display: flex; flex-direction: column; gap: 28px; }
  /* One card per feature, with spacing between cards so features don't run together */
  .feature {
    display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 40px; align-items: center;
    padding: 36px 40px; background: var(--soft); border: 1px solid var(--line); border-radius: 22px;
  }
  .feature:nth-child(even) .feature-text { order: 2; }
  .feature-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .num { font: 700 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
  .badge { padding: 3px 10px; font-size: 12px; font-weight: 600; border-radius: 999px; }
  .badge.ready { color: var(--ready); background: var(--ready-soft); }
  .badge.soon { color: var(--soon); background: var(--soon-soft); }
  .feature h3 { margin: 0 0 14px; font-size: 22px; line-height: 1.35; letter-spacing: -.01em; }
  .label { margin: 0 0 2px; font-size: 12px; font-weight: 650; color: var(--muted); letter-spacing: .04em; }
  .feature-text p:not(.label) { color: var(--secondary); }
  .warn { padding: 8px 12px; font-size: 13.5px; color: var(--soon) !important; background: var(--soon-soft); border-radius: 10px; }

  ol.marks { margin: 16px 0 0; padding: 0; list-style: none; counter-reset: mark; }
  ol.marks li { position: relative; margin: 0 0 8px; padding-left: 32px; font-size: 14px; counter-increment: mark; }
  ol.marks li::before {
    content: counter(mark); position: absolute; left: 0; top: 2px;
    display: grid; place-items: center; width: 22px; height: 22px;
    font-size: 12px; font-weight: 700; color: #fff; background: #ff6a3d; border-radius: 50%;
  }

  .shot {
    display: block; overflow: hidden; background: var(--surface);
    border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 18px 40px rgb(15 23 42 / 10%);
  }
  .shot img { display: block; width: 100%; height: auto; }
  a.shot { transition: transform .2s ease; }
  a.shot:hover { transform: translateY(-2px); }
  .soon-art { box-shadow: none; border-style: dashed; }
  .soon-art svg { display: block; width: 100%; height: auto; }
  .is-soon .feature-media { width: 100%; max-width: 440px; justify-self: center; }
  .figure { padding: 18px; box-shadow: none; }
  .diagram { display: block; width: 100%; height: auto; color: var(--muted); }
  .diagram .d-card rect { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
  .diagram .d-new rect { stroke-dasharray: 6 5; }
  .diagram .d-hub rect { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 2; }
  .diagram .d-title { fill: var(--text); font: 600 15px -apple-system, "PingFang SC", sans-serif; }
  .diagram .d-sub { fill: var(--secondary); font: 12.5px ui-monospace, Menlo, "PingFang SC", monospace; }
  .diagram .d-badge circle { fill: #ff6a3d; }
  .diagram .d-badge text { fill: #fff; font: 700 12px -apple-system, sans-serif; }

  .compatibility-dialog {
    width: min(520px, calc(100vw - 32px)); padding: 0; color: var(--text); background: var(--surface);
    border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 24px 80px rgb(15 23 42 / 30%);
  }
  .compatibility-dialog::backdrop { background: rgb(15 23 42 / 58%); backdrop-filter: blur(2px); }
  .compatibility-card { padding: 26px; }
  .compatibility-card h2 { margin: 0 0 14px; text-align: left; font-size: 22px; }
  .compatibility-card p { color: var(--secondary); }
  .compatibility-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
  .compatibility-actions button { padding: 9px 16px; font: inherit; font-weight: 600; border-radius: 10px; cursor: pointer; }
  .compatibility-cancel { color: var(--secondary); background: var(--soft); border: 1px solid var(--line); }
  .compatibility-continue { color: #fff; background: var(--accent); border: 1px solid var(--accent); }

  .remote-video video { display: block; width: 100%; aspect-ratio: 16 / 9; border: 0; background: #101827; }
  .friend-links { max-width: 1120px; margin: 48px auto 0; padding: 24px; border-top: 1px solid var(--line); }
  .friend-links h2 { margin: 0 0 14px; font-size: 16px; color: var(--secondary); }
  .friend-links-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .friend-links a { display: inline-block; max-width: 100%; }
  .friend-links img { display: block; height: 40px; width: auto; max-width: 100%; }
  .icp { margin: 20px 0 0; font-size: 12px; text-align: center; }
  .icp a { color: var(--muted); text-decoration: none; }

  .lightbox {
    position: fixed; inset: 0; z-index: 90; display: grid; place-items: center;
    padding: 4vmin; background: rgb(15 23 42 / 82%);
    opacity: 0; visibility: hidden; transition: opacity .18s ease, visibility .18s ease;
  }
  .lightbox.is-open { opacity: 1; visibility: visible; }
  .lightbox img { display: block; max-width: min(1280px, 100%); max-height: 92vh; width: auto; height: auto; border-radius: 14px; box-shadow: 0 30px 80px rgb(15 23 42 / 45%); cursor: zoom-out; }
  .lightbox-close { position: absolute; top: 16px; right: 16px; width: 40px; height: 40px; padding: 0; color: #fff; font-size: 22px; line-height: 1; cursor: pointer; background: rgb(255 255 255 / 14%); border: 0; border-radius: 50%; }


  @media (max-width: 760px) {
    header { padding: 56px 0 40px; }
    h1 { font-size: 36px; }
    .slogan { font-size: 21px; }
    .subline { font-size: 16px; }
    .get { grid-template-columns: 1fr; max-width: 460px; margin-top: 24px; }
    .iphone { border-left: 0; border-top: 1px solid var(--line); }
    /* Already on a phone, so scanning is pointless; just tap the button */
    .iphone-qr { display: none; }
    .feature { grid-template-columns: 1fr; gap: 18px; padding: 22px 18px; border-radius: 18px; }
    .feature:nth-child(even) .feature-text { order: 0; }
  }
</style>
</head>
<body>
<nav class="lang-switch" aria-label="Language / 语言">
  <a href="${en ? "../" : "./"}" data-set-locale="zh" lang="zh-CN" hreflang="zh-CN"${en ? "" : ' aria-current="page"'}>中文</a>
  <a href="${en ? "./" : "en/"}" data-set-locale="en" lang="en" hreflang="en"${en ? ' aria-current="page"' : ""}>English</a>
</nav>
${renderLocale(locale, base)}

<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" hidden>
  <button class="lightbox-close" type="button" aria-label="${en ? "Close" : "关闭"}">&times;</button>
  <img alt="" />
</div>
<script>
  const UI = {
    zh: { copied: "已复制", manual: "请手动复制", copy: "复制", close: "关闭" },
    en: { copied: "Copied", manual: "Copy manually", copy: "Copy", close: "Close" }
  };
  const ui = () => UI[document.documentElement.dataset.locale === "zh" ? "zh" : "en"];

  // Manual language switch: remember the choice and go straight to that language next time the Chinese URL is opened
  for (const option of document.querySelectorAll("[data-set-locale]")) {
    option.addEventListener("click", () => {
      try { localStorage.setItem("ading-site-locale", option.dataset.setLocale); } catch {}
    });
  }

  // Download URL and latest version are read from release.json: a release only updates it, so the page itself needn't be redeployed.
  // no-store prevents the browser from caching an old release.json, so a refresh after release gets the new URL.
  // If loading fails, the button keeps pointing within the page, and the Homebrew install option is right beside it.
  fetch("${base}release.json", { cache: "no-store" })
    .then(response => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
    .then(release => {
      for (const link of document.querySelectorAll("[data-latest-download]")) link.href = release.url;
      for (const version of document.querySelectorAll("[data-latest-version]")) {
        const english = version.closest(".locale-en");
        version.textContent = (english ? "Latest " : "最新版本 ") + release.version + " · " + release.sizeMb
          + (english ? " MB · macOS 14+ · Apple silicon" : " MB · macOS 14+ · Apple 芯片");
      }
    })
    .catch(() => {});

  for (const link of document.querySelectorAll("[data-latest-download]")) {
    link.addEventListener("click", event => {
      if (link.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault();
      const dialog = link.closest(".locale")?.querySelector("[data-compatibility-dialog]");
      if (!(dialog instanceof HTMLDialogElement)) return;
      dialog.dataset.downloadUrl = link.href;
      dialog.showModal();
    });
  }

  for (const dialog of document.querySelectorAll("[data-compatibility-dialog]")) {
    dialog.querySelector("[data-compatibility-cancel]")?.addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-compatibility-continue]")?.addEventListener("click", () => {
      const url = dialog.dataset.downloadUrl;
      dialog.close();
      if (url) location.href = url;
    });
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  }

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const text = document.querySelector(button.dataset.copy)?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = button.closest(".locale-en") ? UI.en.copied : UI.zh.copied;
      } catch {
        button.textContent = button.closest(".locale-en") ? UI.en.manual : UI.zh.manual;
      }
      setTimeout(() => { button.textContent = button.closest(".locale-en") ? UI.en.copy : UI.zh.copy; }, 1600);
    });
  }

  const lightbox = document.getElementById("lightbox");
  if (lightbox) {
    const image = lightbox.querySelector("img");
    const closeButton = lightbox.querySelector(".lightbox-close");
    const close = () => {
      lightbox.classList.remove("is-open");
      document.body.style.overflow = "";
      setTimeout(() => { lightbox.hidden = true; image?.removeAttribute("src"); }, 180);
    };
    for (const link of document.querySelectorAll("a.shot[data-zoom]")) {
      link.addEventListener("click", event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        if (!image) return;
        image.src = link.getAttribute("href") || "";
        image.alt = link.querySelector("img")?.alt || "";
        lightbox.hidden = false;
        document.body.style.overflow = "hidden";
        requestAnimationFrame(() => lightbox.classList.add("is-open"));
      });
    }
    lightbox.addEventListener("click", event => { if (event.target === lightbox || event.target === closeButton) close(); });
    image?.addEventListener("click", close);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !lightbox.hidden) close(); });
  }
</script>
</body>
</html>
`;
}
