/** Reorder by stable identity; labels and persisted item metadata are untouched. */
export function moveEntry<T extends { key: string }>(items: T[], source: string, target: string, before: boolean): boolean {
  if (source === target) return false;
  const from = items.findIndex(item => item.key === source);
  if (from < 0 || !items.some(item => item.key === target)) return false;
  const [item] = items.splice(from, 1);
  const destination = items.findIndex(entry => entry.key === target) + (before ? 0 : 1);
  items.splice(destination, 0, item);
  return from !== destination;
}

/** Handles isolate touch dragging from scrolling and ordinary navigation clicks.
 * Pointer capture keeps listeners local, including cancellation on teardown. */
export function attachReorder(
  entries: { key: string; el: HTMLElement; label: string }[],
  axis: "horizontal" | "vertical",
  onMove: (source: string, target: string, before: boolean) => Promise<void>,
): void {
  let busy = false;
  const groupKey = `${axis}:${entries.map(entry => entry.key).sort().join(",")}`;
  const group = entries[0]?.el.parentElement;
  if (group) group.dataset.reorderGroup = groupKey;
  for (const entry of entries) {
    const isButton = entry.el.tagName === "BUTTON";
    const handle = entry.el.createSpan({ cls: "mos-drag-handle", text: "\u283f", attr: isButton
      ? { "aria-hidden": "true", title: "Drag to reorder, or focus the button and use arrow keys" }
      : { role: "button", tabindex: "0", "aria-label": `Reorder ${entry.label}`,
        title: "Drag to reorder, or use arrow keys" } });
    const keyboardTarget = isButton ? entry.el : handle;
    if (isButton) entry.el.title = "Click to open. Use arrow keys to reorder.";
    entry.el.prepend(handle);
    let start: { x: number; y: number; id: number } | null = null;
    let dragging = false;
    let destination: { key: string; before: boolean } | null = null;
    const clearMarkers = () => entries.forEach(item => item.el.classList.remove("mos-drop-before", "mos-drop-after"));
    const reset = () => {
      start = null;
      dragging = false;
      destination = null;
      entry.el.classList.remove("mos-is-dragging");
      clearMarkers();
    };
    const move = async (target: string, before: boolean) => {
      if (busy) return;
      busy = true;
      try { await onMove(entry.key, target, before); }
      finally { busy = false; }
    };
    handle.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
    handle.addEventListener("pointerdown", event => {
      if (busy || event.button !== 0 || event.isPrimary === false) return;
      event.stopPropagation();
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (!start || event.pointerId !== start.id) return;
      if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
      dragging = true;
      entry.el.classList.add("mos-is-dragging");
      clearMarkers();
      destination = null;
      for (const candidate of entries) {
        const rect = candidate.el.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue;
        if (candidate.key === entry.key) break;
        const before = axis === "horizontal" ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top + rect.height / 2;
        destination = { key: candidate.key, before };
        candidate.el.classList.add(before ? "mos-drop-before" : "mos-drop-after");
        break;
      }
    });
    handle.addEventListener("pointerup", event => {
      if (!start || event.pointerId !== start.id) return;
      const drop = dragging ? destination : null;
      reset();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (drop) void move(drop.key, drop.before);
    });
    handle.addEventListener("pointercancel", reset);
    handle.addEventListener("lostpointercapture", reset);
    keyboardTarget.addEventListener("keydown", event => {
      if (event.key === "Escape") { reset(); event.stopPropagation(); return; }
      const previous = axis === "horizontal" ? "ArrowLeft" : "ArrowUp";
      const next = axis === "horizontal" ? "ArrowRight" : "ArrowDown";
      if (event.key !== previous && event.key !== next) return;
      event.preventDefault();
      event.stopPropagation();
      const index = entries.indexOf(entry) + (event.key === previous ? -1 : 1);
      const target = entries[index];
      const parent = entry.el.parentElement;
      const scope = entry.el.closest(".workspace-leaf-content, .vertical-tab-content") ?? entry.el.ownerDocument;
      if (target) void move(target.key, event.key === previous).then(() => {
        const currentGroup = parent?.isConnected ? parent : Array.from(scope.querySelectorAll<HTMLElement>("[data-reorder-group]"))
          .find(candidate => candidate.dataset.reorderGroup === groupKey);
        const replacement = Array.from(currentGroup?.children ?? []).find(candidate => (candidate as HTMLElement).dataset.reorderKey === entry.key);
        if (replacement?.tagName === "BUTTON") (replacement as HTMLElement).focus();
        else replacement?.querySelector<HTMLElement>(".mos-drag-handle")?.focus();
      });
    });
    entry.el.dataset.reorderKey = entry.key;
    entry.el.classList.add(`mos-reorder-${axis}`);
  }
}
