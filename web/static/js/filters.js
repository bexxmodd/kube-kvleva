// Filter state: what the sidebar and header controls hold, how it is persisted,
// and how it maps to the query parameters of GET /api/resources.
//
// All functions are pure: they return a new state and never mutate their input.
// Nothing here touches `document`, `window`, or `localStorage` directly.

const STORAGE_KEY = 'kvleva.filters';

/** Health values in the order they are sent to the backend. */
const HEALTHS = ['red', 'yellow', 'green'];

/** How reference arrows are drawn. */
export const CONNECTION_MODES = ['all', 'selected', 'off'];

/**
 * @typedef {{
 *   health: {green: boolean, yellow: boolean, red: boolean},
 *   hiddenKinds: !Array<string>,
 *   q: string,
 *   connections: string,
 * }} Filters
 */

/** @return {!Filters} Filters that show everything. */
export function defaultFilters() {
  return {
    health: {green: true, yellow: true, red: true},
    hiddenKinds: [],
    q: '',
    connections: 'all',
  };
}

/**
 * Maps filters to the query parameters of a resource list request. Parameters
 * that would not filter anything are omitted.
 * @param {!Filters} filters
 * @return {{hideKinds?: string, health?: string, q?: string}}
 */
export function toQuery(filters) {
  const query = {};
  if (filters.hiddenKinds.length > 0) query.hideKinds = filters.hiddenKinds.join(',');
  const shown = HEALTHS.filter((h) => filters.health[h]);
  if (shown.length < HEALTHS.length) query.health = shown.join(',');
  const q = filters.q.trim();
  if (q) query.q = q;
  return query;
}

/**
 * Flips one health checkbox. A filter with no health checked would show
 * nothing at all, so unchecking the last one checks every health again.
 * @param {!Filters} filters
 * @param {string} health 'green', 'yellow' or 'red'.
 * @return {!Filters}
 */
export function toggleHealth(filters, health) {
  if (!HEALTHS.includes(health)) return filters;
  const next = {...filters.health, [health]: !filters.health[health]};
  const anyShown = HEALTHS.some((h) => next[h]);
  return {...filters, health: anyShown ? next : defaultFilters().health};
}

/**
 * @param {!Filters} filters
 * @param {string} kindId
 * @return {boolean}
 */
export function isKindHidden(filters, kindId) {
  return filters.hiddenKinds.includes(kindId);
}

/**
 * @param {!Filters} filters
 * @param {string} kindId
 * @param {boolean} hidden
 * @return {!Filters}
 */
export function setKindHidden(filters, kindId, hidden) {
  const kinds = new Set(filters.hiddenKinds);
  if (hidden) {
    kinds.add(kindId);
  } else {
    kinds.delete(kindId);
  }
  return {...filters, hiddenKinds: [...kinds].sort()};
}

/**
 * Hides or shows every kind of the overview at once (the None / All buttons).
 * @param {!Filters} filters
 * @param {!Array<{kindId: string}>} kinds `overview.kinds`.
 * @param {boolean} hidden
 * @return {!Filters}
 */
export function setAllKindsHidden(filters, kinds, hidden) {
  return {...filters, hiddenKinds: hidden ? kinds.map((k) => k.kindId).sort() : []};
}

/**
 * @param {!Filters} filters
 * @param {string} q Search text.
 * @return {!Filters}
 */
export function setQuery(filters, q) {
  return {...filters, q: String(q).trim()};
}

/**
 * @param {!Filters} filters
 * @param {string} mode One of CONNECTION_MODES; anything else is ignored.
 * @return {!Filters}
 */
export function setConnections(filters, mode) {
  return CONNECTION_MODES.includes(mode) ? {...filters, connections: mode} : filters;
}

/**
 * @param {!Filters} filters
 * @return {string}
 */
export function serialize(filters) {
  return JSON.stringify(filters);
}

/**
 * Parses persisted filters. The text is untrusted (anything may be in
 * localStorage): every field is validated and repaired to its default.
 * @param {?string|undefined} text
 * @return {!Filters}
 */
export function deserialize(text) {
  const result = defaultFilters();
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return result;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return result;

  if (raw.health !== null && typeof raw.health === 'object') {
    for (const h of HEALTHS) {
      if (raw.health[h] === false) result.health[h] = false;
    }
    if (!HEALTHS.some((h) => result.health[h])) result.health = defaultFilters().health;
  }
  if (Array.isArray(raw.hiddenKinds)) {
    const kinds = raw.hiddenKinds.filter((k) => typeof k === 'string' && k !== '');
    result.hiddenKinds = [...new Set(kinds)].sort();
  }
  if (typeof raw.q === 'string') result.q = raw.q.trim();
  if (CONNECTION_MODES.includes(raw.connections)) result.connections = raw.connections;
  return result;
}

/**
 * @param {?Storage|undefined} storage `localStorage`, or nothing when unavailable.
 * @return {!Filters}
 */
export function loadFilters(storage) {
  try {
    return deserialize(storage?.getItem(STORAGE_KEY));
  } catch {
    return defaultFilters();
  }
}

/**
 * @param {?Storage|undefined} storage
 * @param {!Filters} filters
 */
export function saveFilters(storage, filters) {
  try {
    storage?.setItem(STORAGE_KEY, serialize(filters));
  } catch {
    // Persistence is a convenience: a full or forbidden storage is not an error.
  }
}

/**
 * Narrows the resource type list of the sidebar.
 * @param {!Array<{kind: string, group: string}>} kinds `overview.kinds`.
 * @param {string} text Typed into the box above the list.
 * @return {!Array<!Object>} Matching kinds in their original order.
 */
export function matchKinds(kinds, text) {
  const needle = text.trim().toLowerCase();
  if (!needle) return kinds;
  return kinds.filter((k) =>
      k.kind.toLowerCase().includes(needle) || k.group.toLowerCase().includes(needle));
}
