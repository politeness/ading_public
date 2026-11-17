interface Overlay {
  element: HTMLElement;
  anchor: HTMLElement | null;
  closing: boolean;
  animation?: Animation;
  reopen(): void;
  close(): void;
}

/**
 * Close the dialog by clicking the backdrop: it only counts as a "backdrop click" when both press and release land on the backdrop.
 *
 * The target of `click` is the nearest common ancestor of the press and release points, so when pressing inside the card
 * and releasing on the backdrop (e.g. dragging to select text, or releasing after dragging the mouse out of the window), the target is also
 * the `<dialog>` itself, and looking only at `click` would close the dialog by mistake. Conversely, pressing on the backdrop
 * and releasing after dragging into the card is misjudged too, so both endpoints must be checked.
 *
 * Closing is still triggered in `click`: `OverlayController` intercepts `click` in the document capture phase
 * and turns backdrop clicks that land on the anchor button into a toggle; moving it earlier to pointerup
 * would make it reopen the dialog after the dialog has already closed.
 */
export function closeOnBackdropClick(dialog: HTMLDialogElement, close: () => void = () => dialog.close()): void {
  let downOnBackdrop = false;
  let upOnBackdrop = false;
  dialog.addEventListener("pointerdown", event => { downOnBackdrop = event.target === dialog; }, true);
  dialog.addEventListener("pointerup", event => { upOnBackdrop = event.target === dialog; }, true);
  dialog.addEventListener("pointercancel", () => { downOnBackdrop = upOnBackdrop = false; }, true);
  dialog.addEventListener("click", event => {
    const clickedBackdrop = downOnBackdrop && upOnBackdrop && event.target === dialog;
    downOnBackdrop = upOnBackdrop = false;
    if (clickedBackdrop) close();
  });
}

/** Shared, interruptible opening/return motion for dialogs and anchored panels. */
export class OverlayController {
  private readonly overlays: Overlay[] = [];
  private invoker: HTMLElement | null = null;

  constructor() {
    document.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLElement>("button,[role=button],img");
      const match = [...this.overlays].reverse().find(entry => {
        const anchor = this.anchor(entry);
        if (!anchor) return false;
        const visible = entry.element instanceof HTMLDialogElement ? entry.element.open : !entry.element.hidden;
        if (!visible && !entry.closing) return false;
        if (entry.element.contains(target) && target !== entry.element) return false;
        if (anchor === button || anchor.contains(target)) return true;
        // A modal backdrop receives the click instead of its underlying launch button.
        const r = anchor.getBoundingClientRect();
        return target === entry.element && event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      });
      if (match && match.element instanceof HTMLDialogElement) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (match.closing) match.reopen(); else match.close();
        return;
      }
      if (button) this.invoker = button;
    }, true);
  }

  private anchor(entry: Overlay): HTMLElement | null {
    if (entry.anchor?.isConnected) return entry.anchor;
    if (entry.anchor?.id) return document.getElementById(entry.anchor.id);
    return null;
  }

  private motion(entry: Overlay, closing: boolean, complete?: () => void): void {
    entry.animation?.cancel();
    const element = entry.element;
    const panel = element.getBoundingClientRect();
    const anchor = this.anchor(entry)?.getBoundingClientRect();
    const x = anchor ? anchor.x + anchor.width / 2 - panel.x - panel.width / 2 : 0;
    const y = anchor ? anchor.y + anchor.height / 2 - panel.y - panel.height / 2 : -12;
    const sx = anchor ? Math.max(.035, Math.min(1, anchor.width / panel.width)) : .96;
    const sy = anchor ? Math.max(.035, Math.min(1, anchor.height / panel.height)) : .96;
    // Individual transforms preserve layout transforms such as translateX(-50%).
    const collapsed = { translate: `${x}px ${y}px`, scale: `${sx} ${sy}`, opacity: 0 };
    const expanded = { translate: "0px 0px", scale: "1 1", opacity: 1 };
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : closing ? 190 : 220;
    const animation = element.animate(closing ? [expanded, collapsed] : [collapsed, expanded], { duration, easing: closing ? "cubic-bezier(.4,0,.8,.3)" : "cubic-bezier(.16,1,.3,1)", fill: "none" });
    entry.animation = animation;
    animation.onfinish = () => {
      if (entry.animation !== animation) return;
      entry.animation = undefined;
      complete?.();
      if (closing) this.anchor(entry)?.animate([{ boxShadow: "0 0 0 0 rgb(22 119 255 / 28%)" }, { boxShadow: "0 0 0 7px rgb(22 119 255 / 0%)" }], { duration: 240 });
    };
  }

  dialogs(): void {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
      const open = dialog.showModal.bind(dialog);
      const close = dialog.close.bind(dialog);
      let returnValue = "";
      const entry: Overlay = {
        element: dialog, anchor: null, closing: false,
        reopen: () => {
          entry.closing = false;
          if (!dialog.open) open();
          this.motion(entry, false);
        },
        close: () => {
          if (!dialog.open || entry.closing) return;
          entry.closing = true;
          this.motion(entry, true, () => { entry.closing = false; close(returnValue); });
        }
      };
      this.overlays.push(entry);
      dialog.showModal = () => {
        if (dialog.open && !entry.closing) { entry.close(); return; }
        if (!dialog.open) entry.anchor = this.invoker ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        entry.reopen();
      };
      dialog.close = value => { returnValue = value ?? ""; entry.close(); };
      dialog.addEventListener("cancel", event => { event.preventDefault(); entry.close(); });
      // Forms using method=dialog must go through the same close path.
      dialog.addEventListener("submit", event => {
        if (!(event.target instanceof HTMLFormElement) || event.target.method !== "dialog") return;
        event.preventDefault(); entry.close();
      });
    }
  }

  panel(element: HTMLElement, anchor: HTMLElement): void {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden")!;
    let hidden = Boolean(element.hidden);
    const setNative = (value: boolean): void => descriptor.set!.call(element, value);
    const entry: Overlay = {
      element, anchor, closing: false,
      reopen: () => { element.hidden = false; }, close: () => { element.hidden = true; }
    };
    this.overlays.push(entry);
    Object.defineProperty(element, "hidden", {
      configurable: true,
      get: () => hidden,
      set: (value: boolean) => {
        value = Boolean(value);
        if (hidden === value) return;
        hidden = value;
        entry.closing = value;
        if (value) {
          element.inert = true;
          this.motion(entry, true, () => { setNative(true); element.inert = false; entry.closing = false; });
        } else {
          element.inert = false;
          setNative(false);
          this.motion(entry, false);
        }
      }
    });
  }
}
