/**
 * The app's single hover tooltip layer.
 *
 * Three rules:
 *
 * 1. **One bubble per control.** The browser pops its own native bubble for the title attribute;
 *    if the shared layer pops another, there are two. So take the title off while we own the control and put it back on leave —
 *    taken off rather than deleted, because the title in the DOM is still a contract that accessibility and tests depend on.
 *
 * 2. **No tooltip when the button already has text.** When an icon has "Contacts" below it or a button says
 *    "Send", a bubble saying the same thing adds nothing and is just a distraction. Only icon-only controls need one.
 *    The exception is disabled controls (aria-disabled): the tooltip explains why it can't be clicked rather than repeating the button text.
 *    The same goes for disabled rows, and the reason overrides the tooltips of the avatar and status light in the row.
 *
 * 3. **Keep tooltips short.** The bubble is at most 300px wide; anything longer gets truncated, which is as good as saying nothing. Long content belongs on a details page.
 *    This isn't enforced at runtime — blocking it would leave icon-only controls with no tooltip at all, which is worse;
 *    instead the UI tests catch it: a tooltip that's too long fails the tests.
 */

export function installTooltips(): void {
  const tip = document.createElement("div");
  tip.id = "icon-tooltip";
  tip.setAttribute("popover", "manual");
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);
  document.body.classList.add("shared-tooltips");

  let anchor: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Pointer position while hovering and the time the bubble should appear: used to reattach to the new node when a list re-render replaces the anchor */
  let anchorPoint: { x: number; y: number } | null = null;
  let dueAt = 0;
  /** Native title taken off while we own the control; restored as-is on leave */
  let borrowed: { node: Element; title: string; addedTooltip: boolean } | null = null;
  /** Native titles of child elements in a disabled row: the bubble is shown for the whole row, but the browser would still pop its own when the pointer moves onto a child */
  let borrowedInner: { node: Element; title: string }[] = [];

  const label = (node: Element) => {
    // An explicit data-tooltip wins; an empty string means "no tooltip here" —
    // used to silence controls that have an aria-label (needed by screen readers) but shouldn't show a bubble.
    const explicit = node.getAttribute("data-tooltip");
    if (explicit !== null) return explicit;
    return node.getAttribute("title") || node.getAttribute("aria-label") || node.getAttribute("alt") || "";
  };

  /**
   * If the control shows its own text (a label under an icon, a text button), no bubble is needed to repeat it.
   * aria-hidden decorations such as count badges don't count as text; otherwise icon-only buttons with badges would lose their tooltip.
   */
  const showsOwnText = (node: Element) => {
    if (!(node instanceof HTMLElement)) return false;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (!parent || !text.textContent?.trim()) continue;
      const hidden = parent.closest("[aria-hidden='true']");
      if (hidden && node.contains(hidden)) continue;
      if (parent.checkVisibility()) return true;
    }
    return false;
  };

  const borrowNativeTitle = (node: Element) => {
    if (node.getAttribute("aria-disabled") === "true") {
      borrowedInner = [...node.querySelectorAll("[title]")].map(inner => ({ node: inner, title: inner.getAttribute("title") ?? "" }));
      for (const inner of borrowedInner) inner.node.removeAttribute("title");
      observer.takeRecords();
    }
    const title = node.getAttribute("title");
    if (title === null) return;
    // Move the text into data-tooltip first so label() returns the same result after the title is removed,
    // and the MutationObserver below won't treat it as "tooltip content changed".
    const addedTooltip = node.getAttribute("data-tooltip") === null;
    if (addedTooltip) node.setAttribute("data-tooltip", title);
    node.removeAttribute("title");
    borrowed = { node, title, addedTooltip };
    observer.takeRecords();
  };

  const returnNativeTitle = () => {
    for (const inner of borrowedInner) if (inner.node.isConnected) inner.node.setAttribute("title", inner.title);
    if (borrowedInner.length) observer.takeRecords();
    borrowedInner = [];
    if (!borrowed) return;
    const { node, title, addedTooltip } = borrowed;
    borrowed = null;
    if (node.isConnected) {
      if (addedTooltip) node.removeAttribute("data-tooltip");
      node.setAttribute("title", title);
    }
    observer.takeRecords();
  };

  const hide = () => {
    clearTimeout(timer);
    anchor = null;
    anchorPoint = null;
    returnNativeTitle();
    if (tip.matches(":popover-open")) tip.hidePopover();
  };

  const show = (node: Element) => {
    const text = label(node);
    if (!node.isConnected || !text) return hide();
    tip.textContent = text;
    if (!tip.matches(":popover-open")) tip.showPopover();
    const r = node.getBoundingClientRect(), t = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.left + (r.width - t.width) / 2))}px`;
    tip.style.top = `${r.top >= t.height + 12 ? r.top - t.height - 8 : Math.min(innerHeight - t.height - 8, r.bottom + 8)}px`;
  };

  const bind = (target: Element | null, point: { x: number; y: number } | null, delay: number) => {
    const node = target?.closest('[aria-disabled="true"][data-tooltip]') ?? target?.closest("button,[data-tooltip],[title],[role=img][aria-label],img[alt]:not([alt=''])") ?? null;
    if (node === anchor) { anchorPoint = point; return; }
    hide();
    if (!node || node.closest("#icon-tooltip")) return;

    const text = label(node);
    // data-tooltip-always: the tooltip has information beyond the button text (e.g. the domain to open), so show it anyway
    const redundant = showsOwnText(node) && node.getAttribute("aria-disabled") !== "true" && !node.hasAttribute("data-tooltip-always");
    anchor = node;
    anchorPoint = point;
    dueAt = performance.now() + delay;
    // Remove the title even when no bubble will be shown; otherwise the browser pops its own.
    borrowNativeTitle(node);
    if (!text || redundant) return;
    if (delay > 0) timer = setTimeout(() => { if (anchor === node) show(node); }, delay);
    else show(node);
  };

  const enter = (event: Event) => {
    const point = event instanceof PointerEvent ? { x: event.clientX, y: event.clientY } : null;
    bind(event.target instanceof Element ? event.target : null, point, 180);
  };

  const observer = new MutationObserver(() => {
    if (anchor && !anchor.isConnected) {
      // A list re-render (the menu is rebuilt whenever an Agent's status changes) replaced the anchor but the pointer didn't move: reattach to the new node under the pointer,
      // otherwise the bubble vanishes for no reason and only comes back after the mouse moves.
      const point = anchorPoint, remaining = Math.max(0, dueAt - performance.now());
      hide();
      if (point) bind(document.elementFromPoint(point.x, point.y), point, remaining);
    } else if (anchor && tip.matches(":popover-open") && tip.textContent !== label(anchor)) show(anchor);
  });

  document.addEventListener("pointerover", enter, true);
  document.addEventListener("focusin", enter, true);
  document.addEventListener("pointerout", event => {
    if (anchor && !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) hide();
  }, true);
  document.addEventListener("focusout", hide, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  observer.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["title", "aria-label", "data-tooltip"]
  });
}
