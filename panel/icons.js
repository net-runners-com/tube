// Tube's icons: inline SVG strings, sized per use. `svg` builds one; `I` holds the named ones.
export const svg = (d, { size = 22, fill = 'none', sw = 1.6, vb = 24 } = {}) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="${fill}" stroke="${fill === 'none' ? 'currentColor' : 'none'}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
export const I = {
  search: (s) => svg('<circle cx="11" cy="11" r="7.5"/><path d="M16.5 16.5 20.5 20.5"/>', { size: s }),
  back: (s = 16) => svg('<path d="M15 5 8 12l7 7"/>', { size: s, sw: 2 }),
  down: (s = 12) => svg('<path d="m6 9 6 6 6-6"/>', { size: s, sw: 2 }),
  more: (s = 16) => svg('<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>', { size: s, fill: 'currentColor' }),
  play: (s = 22) => svg('<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.2-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>', { size: s, fill: 'currentColor' }),
  pause: (s = 22) => svg('<rect x="6" y="4" width="4.2" height="16" rx="1.2"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.2"/>', { size: s, fill: 'currentColor' }),
  rew: (s = 22) => svg('<path d="M11 7 6 12l5 5M18 7l-5 5 5 5"/>', { size: s, sw: 2 }),
  fwd: (s = 22) => svg('<path d="m13 7 5 5-5 5M6 7l5 5-5 5"/>', { size: s, sw: 2 }),
  close: (s = 18) => svg('<path d="M6 6l12 12M18 6 6 18"/>', { size: s, sw: 2 }),
  plus: (s = 18) => svg('<path d="M12 5v14M5 12h14"/>', { size: s, sw: 2.4 }),
  gear: (s = 18) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', { size: s, sw: 1.5 }),
  like: (s = 20) => svg('<path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm0 0 4.5-7.2a1.8 1.8 0 0 1 3.3 1.3L13.8 9H19a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.7 21H7"/>', { size: s, sw: 1.5 }),
  save: (s = 20) => svg('<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>', { size: s, sw: 1.5 }),
  saved: (s = 20) => svg('<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>', { size: s, fill: 'currentColor' }),
  check: (s = 12) => svg('<circle cx="12" cy="12" r="10" fill="#3d7bf2" stroke="none"/><path d="m7.5 12.5 3 3 6-6.5" stroke="#fff" stroke-width="2.4"/>', { size: s }),
  fire: (s = 16) => svg('<path d="M12 22c4 0 7-2.7 7-6.8 0-4.3-3.4-6.6-4.6-10.7-.3-1-1.6-1.2-2.1-.3C10.8 7.2 8 8.3 8 12c-1-.6-1.6-1.6-1.8-2.6-.1-.6-.9-.8-1.2-.2C4.4 10.4 5 12 5 15.2 5 19.3 8 22 12 22z"/>', { size: s, sw: 1.6 }),
  music: (s = 16) => svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>', { size: s, sw: 1.6 }),
  game: (s = 16) => svg('<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r=".6" fill="currentColor"/><circle cx="18" cy="13.5" r=".6" fill="currentColor"/>', { size: s, sw: 1.6 }),
  bulb: (s = 16) => svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>', { size: s, sw: 1.6 }),
  news: (s = 16) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>', { size: s, sw: 1.6 }),
  sport: (s = 16) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a14 14 0 0 1 0 18M3 12h18"/>', { size: s, sw: 1.6 }),
  liked: (s = 20) => svg('<path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm0 0 4.5-7.2a1.8 1.8 0 0 1 3.3 1.3L13.8 9H19a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.7 21H7"/>', { size: s, fill: 'currentColor' }),
  clock: (s = 18) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', { size: s, sw: 1.6 }),
  fill: (s = 16) => svg('<path d="M17 17 7 7M7 15V7h8"/>', { size: s, sw: 1.8 }),
  pip: (s = 18) => svg('<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11.5" width="7.5" height="6" rx="1.2" fill="currentColor" stroke="none"/>', { size: s, sw: 1.6 }),
  vol: (s = 18) => svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>', { size: s, sw: 1.6 }),
  volLow: (s = 18) => svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>', { size: s, sw: 1.6 }),
  muted: (s = 18) => svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>', { size: s, sw: 1.6 }),
  cc: (s = 18, on = false) => svg(`<rect x="2.5" y="5" width="19" height="14" rx="3"${on ? ' fill="currentColor"' : ''}/><path d="M10.5 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6" stroke="${on ? '#000' : 'currentColor'}"/>`, { size: s, sw: 1.6 }),
  repeat: (s = 15) => svg('<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M7 21.5 3.5 18 7 14.5"/><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"/>', { size: s, sw: 1.8 }),
  autoplay: (s = 15) => svg('<path d="M4 5.5v13l9-6.5z"/><path d="M16 5.5v13M20 5.5v13"/>', { size: s, sw: 1.8 }),
  sliders: (s = 15) => svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>', { size: s, sw: 1.7 }),
  reset: (s = 15) => svg('<path d="M20 12a8 8 0 1 1-2.3-5.6L20 8.5"/><path d="M20 3.5v5h-5"/>', { size: s, sw: 1.8 }),
  minus: (s = 14) => svg('<path d="M5 12h14"/>', { size: s, sw: 2.2 }),
  download: (s = 20) => svg('<path d="M12 3.5v11M7 10l5 5 5-5"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>', { size: s, sw: 1.6 }),
  done: (s = 20) => svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>', { size: s, sw: 1.6 }),
  lofi: (s = 15) => svg('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="2.5" y="13.5" width="4.5" height="7" rx="1.8"/><rect x="17" y="13.5" width="4.5" height="7" rx="1.8"/>', { size: s, sw: 1.8 }),
  shuffle: (s = 22) => svg('<path d="M3 7h3.5c2.6 0 4 1.6 5.5 5s2.9 5 5.5 5H21M18 14l3 3-3 3M3 17h3.5c1.3 0 2.3-.4 3.1-1.2M14.4 8.2C15.2 7.4 16.2 7 17.5 7H21M18 4l3 3-3 3"/>', { size: s, sw: 1.7 }),
  prev: (s = 32) => svg('<path d="M6 5v14"/><path d="M19 5.5v13L9 12z"/>', { size: s, sw: 1.5 }),
  next: (s = 32) => svg('<path d="M18 5v14"/><path d="M5 5.5v13L15 12z"/>', { size: s, sw: 1.5 }),
  loopIc: (s = 22) => svg('<path d="M17 3.5 20 6.5 17 9.5"/><path d="M4 12v-1.5a4 4 0 0 1 4-4h12M7 20.5 4 17.5 7 14.5"/><path d="M20 12v1.5a4 4 0 0 1-4 4H4"/>', { size: s, sw: 1.7 }),
  lyrics: (s = 20) => svg('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 8.5h7M12 8.5v8"/>', { size: s, sw: 1.7 }),
  queue: (s = 20) => svg('<path d="M4 6h12M4 10.5h12M4 15h6"/><path d="M17 18.5V11l3.5-1"/><circle cx="15" cy="18.5" r="2"/>', { size: s, sw: 1.7 }),
  image: (s = 16) => svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5.5-5 4 3.5 2.5-2 4.5 3.5"/>', { size: s, sw: 1.7 }),
  film: (s = 16) => svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9.2 5 2.8-5 2.8z"/>', { size: s, sw: 1.7 }),
  back10: (s = 26) => svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 3.5v4h4"/><text x="12" y="15.3" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui">10</text>', { size: s, sw: 1.8 }),
  fwd10: (s = 26) => svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M20 3.5v4h-4"/><text x="12" y="15.3" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui">10</text>', { size: s, sw: 1.8 }),
  listPlus: (s = 20) => svg('<path d="M4 6h11M4 11h11M4 16h7"/><path d="M18 13v7M14.5 16.5h7"/>', { size: s, sw: 1.6 }),
  lock: (s = 12) => svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', { size: s, sw: 1.8 }),
  // Tube's mark: a squeeze tube, crimped end up, cap down, with a highlight
  tube: (s = 16) => svg('<path d="M6 3h12v2.6H6z"/><path d="M6.6 5.6h10.8L15.2 18H8.8z"/><path d="M9 18h6v3.2H9z"/><path d="M9.6 8.4l.8 6.4"/>', { size: s, sw: 1.7 }),
  link: (s = 20) => svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.6 6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/>', { size: s, sw: 1.6 }),
  heart: (s = 12) => svg('<path d="M12 20.5s-8-4.6-8-10.4A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 3.1c0 5.8-8 10.4-8 10.4z"/>', { size: s, fill: 'currentColor' }),
  pin: (s = 11) => svg('<path d="M9 3h6l-1 6 3 3H7l3-3zM12 12v9"/>', { size: s, sw: 1.8 }),
  tick: (s = 14) => svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', { size: s, sw: 2.2 }),
  user: (s = 22) => svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', { size: s, sw: 1.6 })
}
export const NAV_ICONS = {
  home: [
    svg('<path d="M4 10.2 12 4l8 6.2V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M12 15.5v2"/>', { size: 24, sw: 1.4 }),
    '<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M4 10.2 12 4l8 6.2V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M12 15.5v2" style="stroke:rgb(var(--panel))" stroke-width="1.6" stroke-linecap="round"/></svg>'
  ],
  explore: [
    svg('<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="M14.8 9.2 13.3 13.3 9.2 14.8 10.7 10.7z"/>', { size: 24, sw: 1.4 }),
    '<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="M14.8 9.2 13.3 13.3 9.2 14.8 10.7 10.7z" fill="none" style="stroke:rgb(var(--panel))" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  ],
  channels: [
    svg('<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5z"/><path d="M15 4.2a3.4 3.4 0 0 1 0 6.6M17.5 13.8c2.4.8 4 3.2 4 6.2h-3"/>', { size: 24, sw: 1.4 }),
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="7.5" r="3.8"/><path d="M2.5 20.5c0-3.8 2.9-6.8 6.5-6.8s6.5 3 6.5 6.8z"/><path d="M15.3 3.9a3.7 3.7 0 0 1 0 7.2zM17.5 13.6c2.5.8 4.2 3.4 4.2 6.9h-4.4c0-2.8-.3-5.1-1.6-6.9z"/></svg>'
  ],
  settings: [
    svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', { size: 24, sw: 1.4 }),
    '<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/><circle cx="12" cy="12" r="3" style="fill:rgb(var(--panel))"/></svg>'
  ],
  library: [
    svg('<rect x="3.5" y="7.5" width="17" height="13" rx="2.5"/><path d="M6 5h12M8 2.8h8"/><path d="M10.5 11.5v5l4-2.5z"/>', { size: 24, sw: 1.4 }),
    '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M6 5h12M8 2.8h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="3.5" y="7.5" width="17" height="13" rx="2.5" fill="currentColor"/><path d="M10.5 11.5v5l4-2.5z" style="fill:rgb(var(--panel))"/></svg>'
  ]
}

