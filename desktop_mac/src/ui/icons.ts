/** Shared semantic icons. State changes color, never the icon's geometry. */
const downloadPath = '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 18v2h14v-2"/>';
const paths = {
  temporary: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  permanent: '<path d="M12 12C9 8 7.5 7 5.5 7C0 7 0 17 5.5 17C9 17 15 7 18.5 7C24 7 24 17 18.5 17C16.5 17 15 16 12 12"/>',
  shared: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
  conversation: '<rect x="4" y="4" width="16" height="16" rx="3" /> <path d="m8 10 1.5 1.5L12 8.8M14 10h3M8 15h9" />',
  knowledge: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v14.5H5.5A1.5 1.5 0 0 0 4 20Z" /> <path d="M4 18.5A1.5 1.5 0 0 1 5.5 17H19" /> <path d="M8.5 8.5h6" />',
  support: '<path d="M4 12a8 8 0 1 1 16 0v5a2 2 0 0 1-2 2h-2" /> <path d="M4 12v3a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 2M20 12v3a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2" /> <path d="M10 19h4" />',
  collapse: '<path d="m14 7-5 5 5 5" />',
  conversationSwitcher: '<path d="M5 6h14M5 12h10M5 18h7" /> <path d="m17 15 3 3-3 3" />',
  activity: '<path d="M5 7h8M5 12h14M5 17h10" /> <circle cx="17" cy="7" r="2" /> <circle cx="18" cy="17" r="2" />',
  report: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5v9a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 14.5Z" /> <path d="M8 8h8M8 12h6" />',
  send: '<path d="m5 12 14-7-4.5 14-3-6.5L5 12Z" />',
  reply: '<path d="M4 5h16v12H8l-4 3Z" /> <path d="M8.5 11h.01M12 11h.01M15.5 11h.01" />',
  expand: '<path d="m7 9 5 5 5-5" />',
  warning: '<path d="M12 3 3.8 18a1.4 1.4 0 0 0 1.2 2h14a1.4 1.4 0 0 0 1.2-2Z" /> <path d="M12 9v4M12 17h.01" />',
  feedback: '<path d="M4 5h16v12H8l-4 3Z" /> <path d="M8 9h8M8 13h5" />',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />',
  add: '<path d="M12 5v14M5 12h14"/>',
  // Use the trash can only for actually deleting data (tasks, contacts, workspaces); for removing without deleting data use remove.
  delete: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
  share: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
  remove: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  leader: '<path d="m3 7 5 4 4-7 4 7 5-4-2 11H5L3 7Z"/><path d="M5 21h14"/>',
  back: '<path d="m14 5-7 7 7 7M7 12h14"/>',
  play: '<path d="M8.25 5.55a1.25 1.25 0 0 1 1.9-1.06l9.12 6.45a1.3 1.3 0 0 1 0 2.12l-9.12 6.45a1.25 1.25 0 0 1-1.9-1.06Z"/>',
  pause: '<rect x="7" y="6" width="3.5" height="12" rx="1.4"/><rect x="13.5" y="6" width="3.5" height="12" rx="1.4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  refresh: '<path d="M20 6v5h-5M18.3 15a7 7 0 1 1-1.2-7.8L20 10"/>',
  install: downloadPath,
  download: downloadPath,
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4M8.5 11h5M11 8.5v5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4M8.5 11h5"/>',
  connect: '<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v3"/>',
  login: '<path d="M3 12h13m-5-5 5 5-5 5M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
  open: '<path d="M14 4h6v6m0-6-9 9M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M5.5 20v-1.5a6.5 6.5 0 0 1 13 0V20"/>',
  agent: '<path d="M12 3.5V6"/><rect x="5.5" y="6" width="13" height="9.5" rx="3.5"/><path d="M9.5 10v1.5M14.5 10v1.5M3.5 10v2M20.5 10v2M6.5 20.5v-.5a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v.5"/>',
  agents: '<path d="M8 6.5V9"/><rect x="2.5" y="9" width="11" height="8" rx="3"/><path d="M6 12v1.25M10 12v1.25M3.5 21.5v-.5a2.5 2.5 0 0 1 2.5-2.5h4a2.5 2.5 0 0 1 2.5 2.5v.5"/><path d="M16 2v2M11 7.5V6.5A2.5 2.5 0 0 1 13.5 4h5A2.5 2.5 0 0 1 21 6.5v2.5a2.5 2.5 0 0 1-2.5 2.5h-3M14.5 6.75V8M17.5 6.75V8M16 14h2a3 3 0 0 1 3 3v4.5"/>',
  personAdd:'<circle cx="10" cy="7" r="4"/><path d="M3.5 20v-1.5a6.5 6.5 0 0 1 11.2-4.5M18 13v7M14.5 16.5h7"/>',
  language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  settings: '<path d="m9.5 3-.6 2.2-2 .9-2-.6-2.4 4.1 1.6 1.6v2.3l-1.6 1.6 2.4 4.1 2-.6 2 .9.6 2.2h5l.6-2.2 2-.9 2 .6 2.4-4.1-1.6-1.6v-2.3l1.6-1.6-2.4-4.1-2 .6-2-.9-.6-2.2Z"/><circle cx="12" cy="12" r="3"/>'
} as const;

export type IconName = keyof typeof paths;
const filled = new Set<IconName>(["play", "pause", "stop"]);

export function iconSvg(name: IconName): string {
  return `<svg data-icon="${name}" viewBox="0 0 24 24" fill="${filled.has(name) ? "currentColor" : "none"}" stroke="${filled.has(name) ? "none" : "currentColor"}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

/** Preserve IDs/hidden on static SVGs because runtime state owns these attributes. */
export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<SVGElement>("svg[data-icon]").forEach(svg => {
    const name = svg.dataset.icon as IconName;
    if (!Object.hasOwn(paths, name)) return;
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", filled.has(name) ? "currentColor" : "none");
    svg.setAttribute("stroke", filled.has(name) ? "none" : "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = paths[name];
  });
}
