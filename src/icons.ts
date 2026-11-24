/** Small line icons drawn for Typeshelf (24×24 grid, stroked with currentColor). */
const PATHS: Record<string, string> = {
  all: `<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M7.5 16 11 8l3.5 8M8.7 13.3h4.6M16.5 11.5v4.5"/>`,
  star: `<path d="m12 3.8 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>`,
  active: `<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.3 2.5 2.5 5-5.2"/>`,
  recent: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`,
  system: `<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M8.5 19.5h7M12 16v3.5"/>`,
  shapes: `<circle cx="8" cy="8" r="3.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/><path d="m16.5 3.8 3.5 6h-7zM4.5 15.5l4 4M8.5 15.5l-4 4"/>`,
  folder: `<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`,
  plus: `<path d="M12 5.5v13M5.5 12h13"/>`,
  search: `<circle cx="10.8" cy="10.8" r="6"/><path d="m15.3 15.3 4.7 4.7"/>`,
  grid: `<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>`,
  rows: `<rect x="4" y="4.5" width="16" height="6" rx="1.5"/><rect x="4" y="13.5" width="16" height="6" rx="1.5"/>`,
  panel: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15M16.8 8.5h1.4M16.8 11.5h1.4"/>`,
  gear: `<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>`,
  lock: `<rect x="6" y="11" width="12" height="8.5" rx="2"/><path d="M8.8 11V8.3a3.2 3.2 0 0 1 6.4 0V11"/>`,
  close: `<path d="m7 7 10 10M17 7 7 17"/>`,
  power: `<path d="M12 4v7.5"/><path d="M7 7a7 7 0 1 0 10 0"/>`,
  more: `<circle cx="6.5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="17.5" cy="12" r=".8"/>`,
  drop: `<rect x="4" y="4" width="16" height="16" rx="4" stroke-dasharray="3 2.6"/><path d="M12 8.5v7M8.5 12l3.5 3.5 3.5-3.5"/>`,
  filter: `<path d="M4 6.5h16M7 12h10M10 17.5h4"/>`,
  sort: `<path d="M8 19V5M4.8 8.2 8 5l3.2 3.2M16 5v14M12.8 15.8 16 19l3.2-3.2"/>`,
  chevron: `<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>`,
  imported: `<path d="M12 4v10M8 10.5l4 4 4-4"/><path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5"/>`,
  temporary: `<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.6 2.4"/><path d="M12 8v4.2l2.6 1.6"/>`,
  inactive: `<circle cx="12" cy="12" r="8.5"/>`,
  globe: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/>`,
  cloud: `<path d="M7.2 18.5h9.6a4 4 0 0 0 .5-7.97 5.5 5.5 0 0 0-10.6 1.3A3.4 3.4 0 0 0 7.2 18.5z"/>`,
  refresh: `<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>`,
  plug: `<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>`,
  palette: `<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor"/>`,
};

export function icon(name: string, size = 16): string {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
}

/** Fills every static `[data-icon]` element of the page. */
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    if (!el.querySelector(":scope > svg")) el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon!, +(el.dataset.iconSize ?? 16)));
  });
}
