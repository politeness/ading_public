import { t, type MessageKey } from "./i18n.js";

type Step = { id: string; target: string; key: MessageKey };
const groups: Step[][] = [
  [{id:"discover",target:"#agents-entry",key:"app.onboarding.discover"},
   {id:"permissions",target:"#app-settings-entry",key:"app.onboarding.permissions"},
   {id:"support",target:"#support-entry",key:"app.onboarding.support"}],
  [{id:"create",target:"#new-group",key:"app.onboarding.create"}],
  [{id:"share",target:'.contact-list-item[data-own-agent="true"] .contact-item-share',key:"app.onboarding.share"},
   {id:"avatar",target:'.contact-list-item[data-own-agent="true"] .avatar',key:"app.onboarding.avatar"}],
  [{id:"switch",target:"#conversation-switcher-button",key:"app.onboarding.switch"},
   {id:"activity",target:"#toggle-process",key:"app.onboarding.activity"}]
];
const STORAGE = "ading.onboarding.v2";
// Capture before startup records the discovery introduction.
const localEligible = localStorage.getItem(`${STORAGE}.local`) !== null
  || localStorage.getItem("ading.agents-intro-shown") !== "true";
const stepIds = groups.flat().map(step => step.id);
let installed = false;

/** Only acknowledge explicit Next/Skip; absent or hidden anchors remain pending. */
export function installOnboarding(account: () => AccountStatus): void {
  if (installed) return;
  installed = true;
  let storageKey = "";
  let completed = new Set<string>();
  const card = document.createElement("div");
  card.id = "onboarding-card";
  card.className = "onboarding-card";
  card.setAttribute("popover", "manual");
  card.setAttribute("role", "region");
  card.setAttribute("aria-live", "polite");
  const copy = document.createElement("p");
  const actions = document.createElement("div");
  const skip = document.createElement("button");
  const next = document.createElement("button");
  skip.type = next.type = "button";
  skip.textContent = t("app.onboarding.skip");
  next.className = "onboarding-next";
  actions.append(skip, next); card.append(copy, actions); document.body.append(card);
  const ring = document.createElement("div");
  ring.className = "onboarding-ring";
  ring.setAttribute("popover", "manual");
  ring.setAttribute("aria-hidden", "true");
  document.body.append(ring);
  // Four independent panes leave the real target and its surroundings untouched.
  const shade = document.createElement("div");
  shade.className = "onboarding-shade";
  shade.setAttribute("popover", "manual");
  shade.setAttribute("aria-hidden", "true");
  const panes = Array.from({length:4}, () => {
    const pane = document.createElement("div"); shade.append(pane); return pane;
  });
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.classList.add("onboarding-arrow");
  arrow.setAttribute("data-illustration", "onboarding-pointer");
  arrow.innerHTML = '<defs><marker id="onboarding-tip" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2 2 L10 6 L2 10" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></marker></defs><path class="onboarding-arrow-halo"/><path class="onboarding-arrow-line" marker-end="url(#onboarding-tip)"/>';
  shade.append(arrow); document.body.append(shade);
  let current: Step | undefined;
  let pending = false;
  let loadedAccount = "";
  let loadingAccount = "";
  let writeQueue = Promise.resolve();
  const save = () => {
    try { localStorage.setItem(storageKey, JSON.stringify([...completed])); } catch { /* Session progress still works. */ }
    const status = account();
    if (!status.signedIn) return;
    const userId = status.user.userId;
    const mask = stepIds.reduce((bits, id, index) => completed.has(id) ? bits | (1 << index) : bits, 0);
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const active = account();
      if (!active.signedIn || active.user.userId !== userId) return;
      const result = await (window as typeof window & { ading: AdingBridge }).ading.onboardingProgress(mask);
      if (!result.ok) throw new Error("Could not save onboarding progress");
    });
    return writeQueue;
  };
  const hide = () => { card.hidePopover(); ring.hidePopover(); shade.hidePopover(); current = undefined; };
  const visible = (node: HTMLElement): boolean => {
    const r = node.getBoundingClientRect();
    return node.checkVisibility({checkVisibilityCSS:true}) && r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  };
  const update = () => {
    pending = false;
    if (saving) return;
    const status = account();
    const eligible = status.signedIn ? status.onboardingEligible === true : localEligible;
    const key = `${STORAGE}.${status.signedIn ? status.user.userId : "local"}`;
    if (key !== storageKey) {
      hide();
      storageKey = key;
      loadedAccount = "";
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
        completed = new Set(Array.isArray(saved) ? saved.filter(item => typeof item === "string") : []);
      } catch { completed = new Set(); }
    }
    if (status.signedIn && loadedAccount !== key) {
      hide();
      if (loadingAccount !== key) {
        loadingAccount = key;
        const requestedKey = key;
        void (window as typeof window & { ading: AdingBridge }).ading.onboardingProgress().then(result => {
          if (storageKey !== requestedKey || !result.ok || result.data?.version !== 1) return;
          const mask = result.data.completedSteps;
          // Server state is authoritative; local cache must not reset test accounts.
          completed = new Set(stepIds.filter((_, index) => (mask & (1 << index)) !== 0));
          loadedAccount = requestedKey;
          localStorage.setItem(requestedKey, JSON.stringify([...completed]));
        }).catch(error => console.warn(error)).finally(() => {
          if (loadingAccount === requestedKey) loadingAccount = "";
          if (loadedAccount === requestedKey) schedule();
        });
      }
      return;
    }
    if (!eligible) { hide(); return; }
    if (document.querySelector("dialog[open]")) { hide(); return; }
    let chosen: Step | undefined;
    let anchor: HTMLElement | undefined;
    for (const group of groups) {
      const step = group.find(item => !completed.has(item.id));
      if (!step) continue;
      const target = Array.from(document.querySelectorAll<HTMLElement>(step.target)).find(visible);
      if (target) { chosen = step; anchor = target; break; }
    }
    if (!chosen || !anchor) { hide(); return; }
    if (current?.id !== chosen.id) {
      current = chosen; copy.textContent = t(chosen.key);
      const group = groups.find(items => items.includes(chosen!))!;
      next.textContent = t(group.at(-1) === chosen ? "app.onboarding.done" : "app.onboarding.next");
      card.dataset.step = chosen.id;
    }
    shade.showPopover(); card.showPopover(); ring.showPopover();
    const r = anchor.getBoundingClientRect();
    const gap = 14;
    const left = Math.max(0,r.left-gap), top = Math.max(0,r.top-gap);
    const right = Math.min(innerWidth,r.right+gap), bottom = Math.min(innerHeight,r.bottom+gap);
    const boxes = [[0,0,innerWidth,top],[0,bottom,innerWidth,innerHeight-bottom],[0,top,left,bottom-top],[right,top,innerWidth-right,bottom-top]];
    boxes.forEach(([x,y,w,h], i) => Object.assign(panes[i].style,{left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`}));
    const c = card.getBoundingClientRect();
    const tx = r.left+r.width/2, ty = r.top+r.height/2;
    // Start at the card edge facing the target; keep the arrow outside the copy.
    const dx = tx-(c.left+c.width/2), dy = ty-(c.top+c.height/2);
    const scale = Math.min((c.width/2+12)/Math.max(Math.abs(dx),1),(c.height/2+12)/Math.max(Math.abs(dy),1));
    const sx = c.left+c.width/2+dx*scale, sy = c.top+c.height/2+dy*scale;
    const endScale = Math.min((r.width/2+gap+10)/Math.max(Math.abs(dx),1),(r.height/2+gap+10)/Math.max(Math.abs(dy),1));
    const ex = tx-dx*endScale, ey = ty-dy*endScale;
    const path = `M ${sx} ${sy} Q ${(sx+ex)/2+dy*.12} ${(sy+ey)/2-dx*.12} ${ex} ${ey}`;
    arrow.setAttribute("viewBox",`0 0 ${innerWidth} ${innerHeight}`);
    arrow.querySelectorAll(":scope > path").forEach(node=>node.setAttribute("d",path));
    Object.assign(ring.style,{left:`${r.left-4}px`,top:`${r.top-4}px`,width:`${r.width+8}px`,height:`${r.height+8}px`});

  };
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(update); } };
  let saving = false;
  const acknowledge = async (wholeGroup: boolean) => {
    if (!current || saving) return;
    saving = true;
    next.disabled = skip.disabled = true;
    const key = storageKey;
    const previous = new Set(completed);
    if (wholeGroup) for (const step of groups.find(group => group.includes(current!))!) completed.add(step.id);
    else completed.add(current.id);
    try { await save(); }
    catch {
      if (storageKey === key) {
        completed = previous;
        localStorage.setItem(key, JSON.stringify([...previous]));
        copy.textContent = t("app.onboarding.saveFailed");
      }
      return;
    } finally {
      saving = false;
      next.disabled = skip.disabled = false;
    }
    if (storageKey === key) update();
  };
  next.onclick = () => { void acknowledge(false); };
  skip.onclick = () => { void acknowledge(true); };
  document.addEventListener("keydown",event=>{if(event.key==="Escape" && current){skip.click();event.stopPropagation();}},true);
  new MutationObserver(records=>{
    if(records.some(record=> !card.contains(record.target) && record.target!==ring)) schedule();
  }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["hidden","class","open"]});
  window.addEventListener("ading-account-changed",schedule);
  window.addEventListener("resize",schedule);
  document.addEventListener("scroll",schedule,true);
  schedule();
}
