export function sidebarLabel(
  text: string,
  count: number | undefined,
  action?: HTMLButtonElement
): HTMLElement {
  const label = document.createElement("div");
  const name = document.createElement("span");
  const total = document.createElement("span");
  label.className = "sidebar-label";
  total.className = "sidebar-count";
  name.textContent = text;
  total.textContent = String(count);
  label.append(name);
  if (count !== undefined) label.append(total);
  if (action) label.append(action);
  return label;
}

