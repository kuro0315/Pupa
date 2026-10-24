const svg = (body: string, viewBox = '0 0 24 24') => `<svg viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
const stroke = 'stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"';
export const icons = {
  search: svg(`<circle cx="10.5" cy="10.5" r="6.5" ${stroke}/><path d="m16 16 4.5 4.5" ${stroke}/>`),
  settings: svg(`<path d="m9.1 3-.5 2.2-2 .9-2-.7L2 9.9l1.7 1.5v2.2L2 15.1l2.6 4.5 2-.7 2 .9.5 2.2h5.8l.5-2.2 2-.9 2 .7 2.6-4.5-1.7-1.5v-2.2L22 9.9l-2.6-4.5-2 .7-2-.9L14.9 3H9.1Z" transform="translate(1 0) scale(.91)" ${stroke}/><circle cx="12" cy="12" r="3.1" ${stroke}/>`),
  close: svg(`<path d="m6 6 12 12M18 6 6 18" ${stroke}/>`),
  pin: svg(`<path d="m15 3 6 6-4 1-3 5-2-1-6 6M10 12l-1-2 5-3 1-4M9 10l5 5" ${stroke}/>`),
  trash: svg(`<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" ${stroke}/>`),
  copy: svg(`<rect x="8" y="8" width="12" height="13" rx="2" ${stroke}/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" ${stroke}/>`),
  check: svg(`<path d="m5 12 4 4L19 6" ${stroke}/>`),
  text: svg(`<path d="M5 5h14M12 5v15M8 20h8" ${stroke}/>`),
  link: svg(`<path d="m10 13 4-4M8 15l-1 1a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m0 3 1-1a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0" transform="translate(2 1)" ${stroke}/>`),
  code: svg(`<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" ${stroke}/>`),
  pause: svg(`<path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`),
  play: svg(`<path d="m8 4 12 8-12 8V4Z" ${stroke}/>`),
  lock: svg(`<rect x="5" y="10" width="14" height="11" rx="3" ${stroke}/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" ${stroke}/>`),
  arrow: svg(`<path d="M5 12h14m-5-5 5 5-5 5" ${stroke}/>`),
  spark: svg(`<path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7L12 2Z" ${stroke}/>`),
  butterfly: svg(`<path d="M31 31C18 8 3 10 5 26c1 8 11 13 23 12C13 36 9 45 17 50c9 5 15-4 17-13 2 9 8 18 17 13 8-5 4-14-11-12 12 1 22-4 23-12 2-16-13-18-26 5" fill="currentColor"/><path d="M34 30v12M32 29l-4-7m8 7 4-7" stroke="#494351" stroke-width="2" stroke-linecap="round"/><ellipse cx="19" cy="26" rx="4" ry="5" transform="rotate(-28 19 26)" fill="#fffdf7"/><ellipse cx="49" cy="26" rx="4" ry="5" transform="rotate(28 49 26)" fill="#fffdf7"/>`, '0 0 68 60'),
};
