interface ReadingPosition {
  bottom: boolean;
  top: number;
  anchor?: string;
  offset?: number;
}

/** Keep the visible message stable across renders; follow arrivals only at the bottom. */
export class ScrollPosition {
  private key: string | null = null;
  private readonly positions = new Map<string, ReadingPosition>();

  constructor(
    private readonly pane: HTMLElement,
    private readonly isVisible: () => boolean = () => pane.clientHeight > 0
  ) {}

  // Overlay animations scale viewport coordinates, but scrollTop uses layout pixels.
  private relativeTop(child: Element): number {
    const pane = this.pane;
    const rect = pane.getBoundingClientRect();
    const scale = pane.offsetHeight ? rect.height / pane.offsetHeight : 1;
    return (child.getBoundingClientRect().top - rect.top) / (scale || 1);
  }

  beforeRender(key: string | null): () => void {
    const pane = this.pane;
    // Hidden panels have no useful geometry. Preserve their last visible position.
    if (this.key !== null && this.isVisible()) {
      const edge = pane.getBoundingClientRect().top;
      const anchor = Array.from(pane.children).find(child =>
        (child as HTMLElement).dataset.scrollKey && child.getBoundingClientRect().bottom > edge
      ) as HTMLElement | undefined;
      this.positions.set(this.key, {
        bottom: pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 8,
        top: pane.scrollTop,
        anchor: anchor?.dataset.scrollKey,
        offset: anchor ? this.relativeTop(anchor) : undefined
      });
    }
    this.key = key;
    const saved = key === null ? undefined : this.positions.get(key);
    return () => {
      if (!this.isVisible()) return;
      if (!saved || saved.bottom) {
        pane.scrollTop = pane.scrollHeight;
        return;
      }
      const anchor = saved.anchor && Array.from(pane.children).find(child =>
        (child as HTMLElement).dataset.scrollKey === saved.anchor
      );
      pane.scrollTop = anchor
        ? pane.scrollTop + this.relativeTop(anchor) - (saved.offset ?? 0)
        : saved.top;
    };
  }
}
