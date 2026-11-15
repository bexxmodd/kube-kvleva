// Filter state: what the sidebar and header controls hold, how it is persisted,
// and how it maps to the query parameters of GET /api/resources.
//
// All functions are pure: they return a new state and never mutate their input.
// Nothing here touches `document`, `window`, or `localStorage` directly.

const STORAGE_KEY = 'kvleva.filters';

/** Health values in the order they are sent to the backend. */
const HEALTHS = ['red', 'yellow', 'green'];

/**
 * @typedef {{
 *   health: {green: boolean, yellow: boolean, red: boolean},
 *   hiddenKinds: !Array<string>,
 *   q: string,
 *   system: boolean,
 * }} Filters
 */

/**
 * @return {!Filters} Filters that show everything a user deployed. System
 *     resources (what the cluster brought along) start hidden.
 */
export function defaultFilters() {
  return {
    health: {green: true, yellow: true, red: true},
    hiddenKinds: [],
    q: '',
    system: false,
  };
}

/**
 * Maps filters to the query parameters of a resource list request. Parameters
 * that would not filter anything are omitted.
 * @param {!Filters} filters
 * @return {{hideKinds?: string, health?: string, q?: string, system?: string}}
 */
export function toQuery(filters) {
  const query = {};
  if (filters.hiddenKinds.length > 0) query.hideKinds = filters.hiddenKinds.join(',');
  const shown = HEALTHS.filter((h) => filters.health[h]);
  if (shown.length < HEALTHS.length) query.health = shown.join(',');
  const q = filters.q.trim();
  if (q) query.q = q;
  // The backend leaves system resources out unless asked for them.
  if (filters.system) query.system = 'true';
  return query;
}

/**
 * Switches system resources on or off.
 * @param {!Filters} filters
 * @param {boolean} shown
 * @return {!Filters}
 */
export function setSystem(filters, shown) {
  return {...filters, system: shown === true};
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
  result.system = raw.system === true;
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

/** The core API group, as the backend spells it. It is listed first. */
const CORE_GROUP = 'core';

/**
 * Groups resource types by their API group for the sidebar: the core group
 * first, the others alphabetically. Inside a group the types keep the order
 * they have in the overview.
 * @param {!Array<{kindId: string, group: string, count: number}>} kinds
 * @return {!Array<{group: string, kinds: !Array<!Object>, count: number}>}
 *     `count` is the number of resources of all types of the group.
 */
export function groupKinds(kinds) {
  const byGroup = new Map();
  for (const kind of kinds) {
    if (!byGroup.has(kind.group)) byGroup.set(kind.group, {group: kind.group, kinds: [], count: 0});
    const entry = byGroup.get(kind.group);
    entry.kinds.push(kind);
    entry.count += kind.count;
  }
  return [...byGroup.values()].sort((a, b) => {
    if ((a.group === CORE_GROUP) !== (b.group === CORE_GROUP)) return a.group === CORE_GROUP ? -1 : 1;
    return a.group < b.group ? -1 : a.group > b.group ? 1 : 0;
  });
}

/**
 * Hides or shows several kinds at once (the checkbox of an API group).
 * @param {!Filters} filters
 * @param {!Array<string>} kindIds
 * @param {boolean} hidden
 * @return {!Filters}
 */
export function setKindsHidden(filters, kindIds, hidden) {
  const kinds = new Set(filters.hiddenKinds);
  for (const kindId of kindIds) {
    if (hidden) {
      kinds.add(kindId);
    } else {
      kinds.delete(kindId);
    }
  }
  return {...filters, hiddenKinds: [...kinds].sort()};
}

/**
 * @param {!Filters} filters
 * @param {!Array<{kindId: string}>} kinds The kinds of one group.
 * @return {string} 'shown' when none of them is hidden, 'hidden' when all
 *     are, 'partly' otherwise.
 */
export function groupState(filters, kinds) {
  const hidden = kinds.filter((kind) => isKindHidden(filters, kind.kindId)).length;
  if (hidden === 0) return 'shown';
  return hidden === kinds.length ? 'hidden' : 'partly';
}
