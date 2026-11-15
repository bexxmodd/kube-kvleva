// Page layout and appearance the user can adjust: the widths of the two side
// panels (filters on the left, details on the right), whether the filters
// panel is shown, which API groups are expanded in its list of resource
// types, and the theme (night or day).
//
// All functions are pure or take their storage as an argument. Nothing here
// touches `document`, `window`, or `localStorage` directly.

const SIDEBAR_WIDTH_KEY = 'kvleva.sidebarWidth';
const DRAWER_WIDTH_KEY = 'kvleva.drawerWidth';
const HIDDEN_KEY = 'kvleva.sidebarHidden';
const EXPANDED_GROUPS_KEY = 'kvleva.expandedGroups';
// js/theme-boot.js reads the same key before the modules run.
const THEME_KEY = 'kvleva.theme';

/** Width of the filters panel until the user chooses another, in pixels. */
export const SIDEBAR_DEFAULT_WIDTH = 260;

/** The filters panel cannot be made narrower than this, in pixels. */
export const SIDEBAR_MIN_WIDTH = 180;

/** Width of the details panel until the user chooses another, in pixels. */
export const DRAWER_DEFAULT_WIDTH = 480;

/** The details panel cannot be made narrower than this, in pixels. */
export const DRAWER_MIN_WIDTH = 280;

/** A side panel never takes more than this fraction of the window. */
export const PANEL_MAX_FRACTION = 1 / 3;

/** How far one arrow key press moves a divider, in pixels. */
export const PANEL_KEY_STEP = 16;

/**
 * @param {number} viewportWidth Width of the window.
 * @return {number} The widest a side panel may be.
 */
export function panelMaxWidth(viewportWidth) {
  return Math.floor(viewportWidth * PANEL_MAX_FRACTION);
}

/**
 * Brings a wanted panel width within its limits: at least the panel's
 * minimum, and never more than a third of the window. In a window so narrow
 * that the two conflict, the third wins.
 * @param {*} width Wanted width; anything but a finite number means "default".
 * @param {number} viewportWidth Width of the window.
 * @param {{min: number, fallback: number}} panel
 * @return {number} Whole pixels.
 */
function clampWidth(width, viewportWidth, {min, fallback}) {
  const wanted = typeof width === 'number' && Number.isFinite(width) ? width : fallback;
  return Math.round(Math.min(Math.max(wanted, min), panelMaxWidth(viewportWidth)));
}

/**
 * @param {*} width Wanted width of the filters panel.
 * @param {number} viewportWidth
 * @return {number} The width within the limits of the filters panel.
 */
export function clampSidebarWidth(width, viewportWidth) {
  return clampWidth(width, viewportWidth, {min: SIDEBAR_MIN_WIDTH, fallback: SIDEBAR_DEFAULT_WIDTH});
}

/**
 * @param {*} width Wanted width of the details panel.
 * @param {number} viewportWidth
 * @return {number} The width within the limits of the details panel.
 */
export function clampDrawerWidth(width, viewportWidth) {
  return clampWidth(width, viewportWidth, {min: DRAWER_MIN_WIDTH, fallback: DRAWER_DEFAULT_WIDTH});
}

/**
 * @param {?Storage|undefined} storage `localStorage`, or nothing when unavailable.
 * @param {string} key
 * @return {?number} The width saved under key, or null.
 */
function loadWidth(storage, key) {
  let text = null;
  try {
    text = storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
  // Whatever is in storage is untrusted: only a plain positive number counts.
  if (text === null || !/^\d+(\.\d+)?$/.test(text)) return null;
  const width = Number(text);
  return width > 0 ? width : null;
}

function saveWidth(storage, key, width) {
  try {
    storage?.setItem(key, String(width));
  } catch {
    // Persistence is a convenience: a full or forbidden storage is not an error.
  }
}

/**
 * @param {?Storage|undefined} storage
 * @return {?number} The filters panel width the user chose earlier, or null.
 */
export function loadSidebarWidth(storage) {
  return loadWidth(storage, SIDEBAR_WIDTH_KEY);
}

/**
 * @param {?Storage|undefined} storage
 * @param {number} width
 */
export function saveSidebarWidth(storage, width) {
  saveWidth(storage, SIDEBAR_WIDTH_KEY, width);
}

/**
 * @param {?Storage|undefined} storage
 * @return {?number} The details panel width the user chose earlier, or null.
 */
export function loadDrawerWidth(storage) {
  return loadWidth(storage, DRAWER_WIDTH_KEY);
}

/**
 * @param {?Storage|undefined} storage
 * @param {number} width
 */
export function saveDrawerWidth(storage, width) {
  saveWidth(storage, DRAWER_WIDTH_KEY, width);
}

/**
 * @param {?Storage|undefined} storage `localStorage`, or nothing when unavailable.
 * @return {boolean} Whether the user hid the filters panel; shown by default.
 */
export function loadSidebarHidden(storage) {
  try {
    return storage?.getItem(HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * @param {?Storage|undefined} storage
 * @param {boolean} hidden
 */
export function saveSidebarHidden(storage, hidden) {
  try {
    storage?.setItem(HIDDEN_KEY, hidden ? 'true' : 'false');
  } catch {
    // Persistence is a convenience: a full or forbidden storage is not an error.
  }
}

/**
 * @param {?Storage|undefined} storage `localStorage`, or nothing when unavailable.
 * @return {!Array<string>} Names of the API groups the user expanded in the
 *     list of resource types; none by default, since groups start collapsed.
 */
export function loadExpandedGroups(storage) {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(EXPANDED_GROUPS_KEY) ?? 'null');
  } catch {
    return [];
  }
  // Whatever is in storage is untrusted: only a list of names counts.
  if (!Array.isArray(saved)) return [];
  return [...new Set(saved.filter((group) => typeof group === 'string'))];
}

/**
 * @param {?Storage|undefined} storage
 * @param {!Array<string>} groups Names of the expanded API groups.
 */
export function saveExpandedGroups(storage, groups) {
  try {
    storage?.setItem(EXPANDED_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // Persistence is a convenience: a full or forbidden storage is not an error.
  }
}

/**
 * @param {*} theme
 * @return {string} The theme to switch to from `theme`: 'night' from 'day',
 *     and 'day' from anything else, since anything else is shown as night.
 */
export function otherTheme(theme) {
  return theme === 'day' ? 'night' : 'day';
}

/**
 * @param {?Storage|undefined} storage `localStorage`, or nothing when unavailable.
 * @return {string} 'day' when the user chose the day theme, otherwise 'night'.
 */
export function loadTheme(storage) {
  try {
    // Whatever is in storage is untrusted: only the one known value counts.
    return storage?.getItem(THEME_KEY) === 'day' ? 'day' : 'night';
  } catch {
    return 'night';
  }
}

/**
 * @param {?Storage|undefined} storage
 * @param {string} theme 'night' or 'day'.
 */
export function saveTheme(storage, theme) {
  try {
    storage?.setItem(THEME_KEY, theme === 'day' ? 'day' : 'night');
  } catch {
    // Persistence is a convenience: a full or forbidden storage is not an error.
  }
}
