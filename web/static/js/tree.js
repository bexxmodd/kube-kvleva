// View model of the canvas: which lists are open, what each has loaded, how
// items group into lanes, what to open on first load, and what to refetch on a
// refresh. DOM-free; the view renders this state and main.js drives it.
//
// A *scope* names one list of GET /api/resources:
//   {type: 'nodes'} | {type: 'cluster'} | {type: 'namespace', name}
//   | {type: 'parent', uid} | {type: 'node', name}
// Only open lists exist in the tree, so the tree (and the DOM rendered from it)
// stays bounded by what the user opened.

/** Items requested per page. */
export const PAGE_SIZE = 100;

/**
 * @typedef {{
 *   key: string,
 *   scope: !Object,
 *   parentKey: ?string,
 *   depth: number,
 *   items: !Array<!Object>,
 *   total: number,
 *   loaded: boolean,
 *   error: ?string,
 * }} List
 */

/**
 * @param {{type: string, name?: string, uid?: string}} scope
 * @return {string} Stable identifier of the scope's list.
 */
export function scopeKey(scope) {
  switch (scope.type) {
    case 'nodes': return 'nodes';
    case 'cluster': return 'cluster';
    case 'namespace': return `ns:${scope.name}`;
    case 'parent': return `parent:${scope.uid}`;
    case 'node': return `node:${scope.name}`;
    default: throw new TypeError(`unknown scope ${JSON.stringify(scope)}`);
  }
}

/** @return {{lists: !Map<string, !List>}} A tree with nothing open. */
export function createTree() {
  return {lists: new Map()};
}

/**
 * @param {!Object} tree
 * @param {string} key
 * @return {boolean}
 */
export function isOpen(tree, key) {
  return tree.lists.has(key);
}

/**
 * @param {!Object} tree
 * @param {string} key
 * @return {!List|undefined}
 */
export function getList(tree, key) {
  return tree.lists.get(key);
}

/**
 * Opens a list (no-op when already open).
 * @param {!Object} tree
 * @param {!Object} scope
 * @param {?string=} parentKey Key of the list whose item contains this list;
 *     null for the top-level areas.
 * @return {!List}
 */
export function openList(tree, scope, parentKey = null) {
  const key = scopeKey(scope);
  const existing = tree.lists.get(key);
  if (existing) return existing;
  const parent = parentKey === null ? undefined : tree.lists.get(parentKey);
  const list = {
    key, scope, parentKey,
    depth: parent ? parent.depth + 1 : 0,
    items: [], total: 0, loaded: false, error: null,
  };
  tree.lists.set(key, list);
  return list;
}

/**
 * Closes a list and every list opened inside it.
 * @param {!Object} tree
 * @param {string} key
 * @return {!Array<string>} Keys that were closed.
 */
export function closeList(tree, key) {
  if (!tree.lists.delete(key)) return [];
  const closed = [key];
  for (const list of [...tree.lists.values()]) {
    if (list.parentKey === key) closed.push(...closeList(tree, list.key));
  }
  return closed;
}

/**
 * Appends a page to an open list.
 * @param {!Object} tree
 * @param {string} key
 * @param {{items: !Array<!Object>, total: number}} page
 * @return {boolean} False when the list was closed in the meantime.
 */
export function addPage(tree, key, page) {
  const list = tree.lists.get(key);
  if (!list) return false;
  const seen = new Set(list.items.map((item) => item.uid));
  for (const item of page.items) {
    if (!seen.has(item.uid)) {
      seen.add(item.uid);
      list.items.push(item);
    }
  }
  list.total = page.total;
  list.loaded = true;
  list.error = null;
  return true;
}

/**
 * @param {!Object} tree
 * @param {string} key
 * @param {string} message
 */
export function setError(tree, key, message) {
  const list = tree.lists.get(key);
  if (!list) return;
  list.error = message;
  list.loaded = true;
}

/**
 * @param {!List} list
 * @return {number} Matches that exist on the server but are not loaded.
 */
export function remaining(list) {
  return Math.max(0, list.total - list.items.length);
}

/**
 * @param {!List} list
 * @return {?{offset: number, limit: number}} The next page to request, or null
 *     when everything is loaded.
 */
export function nextPageRequest(list) {
  if (list.loaded && remaining(list) === 0) return null;
  return {offset: list.items.length, limit: PAGE_SIZE};
}

/**
 * Groups items into lanes: runs of consecutive items of the same kind. Items
 * arrive sorted by kind, so this never reorders anything.
 * @param {!Array<!Object>} items
 * @return {!Array<{kindId: string, kind: string, items: !Array<!Object>}>}
 */
export function lanes(items) {
  const result = [];
  for (const item of items) {
    const last = result[result.length - 1];
    if (last && last.kindId === item.kindId) {
      last.items.push(item);
    } else {
      result.push({kindId: item.kindId, kind: item.kind, items: [item]});
    }
  }
  return result;
}

/**
 * The list a widget shows when it is opened.
 * @param {!Object} item A ResourceSummary.
 * @param {!Object} listScope Scope of the list the item is shown in.
 * @return {?Object} A scope, or null when the widget has nothing to open.
 */
export function childScope(item, listScope) {
  if (listScope.type === 'node') return null;
  if (listScope.type === 'nodes') return {type: 'node', name: item.name};
  return item.childCount > 0 ? {type: 'parent', uid: item.uid} : null;
}

// --- Initial expansion -------------------------------------------------------

/** Clusters up to this many resources start expanded. */
export const AUTO_EXPAND_MAX_RESOURCES = 400;

/** Child lists up to this many items are opened by the initial expansion. */
export const AUTO_EXPAND_MAX_CHILDREN = 10;

/** How many levels below an area the initial expansion opens. */
export const AUTO_EXPAND_DEPTH = 2;

const namespaceScopes = (overview) =>
    overview.namespaces.map((ns) => ({type: 'namespace', name: ns.name}));

/**
 * @param {!Object} overview The /api/overview response.
 * @return {!Array<!Object>} Scopes of every area, in display order.
 */
export function areaScopes(overview) {
  return [{type: 'nodes'}, {type: 'cluster'}, ...namespaceScopes(overview)];
}

/**
 * @param {!Object} overview
 * @return {!Array<!Object>} Areas to open on first load: the Nodes area and
 *     every namespace of a small cluster, nothing for a large one.
 */
export function initialScopes(overview) {
  const {green, yellow, red} = overview.health;
  if (green + yellow + red > AUTO_EXPAND_MAX_RESOURCES) return [];
  return [{type: 'nodes'}, ...namespaceScopes(overview)];
}

/**
 * @param {!List} list A list that just loaded during the initial expansion.
 * @return {!Array<!Object>} Child lists to open inside it.
 */
export function autoOpenScopes(list) {
  if (list.depth >= AUTO_EXPAND_DEPTH) return [];
  const scopes = [];
  for (const item of list.items) {
    const scope = childScope(item, list.scope);
    if (scope?.type === 'parent' && item.childCount <= AUTO_EXPAND_MAX_CHILDREN) scopes.push(scope);
  }
  return scopes;
}

// --- Refresh planning --------------------------------------------------------

/** Largest page the backend serves. */
const MAX_LIMIT = 500;

/**
 * Requests that reload every open list while keeping the number of pages each
 * one had loaded. Long lists are split into requests of at most MAX_LIMIT.
 * @param {!Object} tree
 * @return {!Array<{key: string, scope: !Object, offset: number, limit: number}>}
 */
export function refreshRequests(tree) {
  const requests = [];
  for (const list of tree.lists.values()) {
    const pages = Math.max(1, Math.ceil(list.items.length / PAGE_SIZE));
    const count = pages * PAGE_SIZE;
    for (let offset = 0; offset < count; offset += MAX_LIMIT) {
      requests.push({key: list.key, scope: list.scope, offset, limit: Math.min(MAX_LIMIT, count - offset)});
    }
  }
  return requests;
}

/**
 * Replaces what an open list has loaded with freshly fetched pages.
 * @param {!Object} tree
 * @param {string} key
 * @param {!Array<{items: !Array<!Object>, total: number}>} pages In order.
 * @return {boolean} False when the list was closed in the meantime.
 */
export function replaceItems(tree, key, pages) {
  const list = tree.lists.get(key);
  if (!list) return false;
  list.items = [];
  for (const page of pages) addPage(tree, key, page);
  return true;
}

/**
 * @param {!Object} tree
 * @param {!List} list
 * @param {!Set<string>} namespaces Names of the existing namespaces.
 * @return {boolean} Whether the thing that contains the list is still shown.
 */
function isAnchored(tree, list, namespaces) {
  if (list.scope.type === 'namespace') return namespaces.has(list.scope.name);
  if (list.parentKey === null) return true;
  const parent = tree.lists.get(list.parentKey);
  if (!parent) return false;
  if (!parent.loaded) return true;
  return parent.items.some((item) => {
    const scope = childScope(item, parent.scope);
    return scope !== null && scopeKey(scope) === list.key;
  });
}

/**
 * Closes lists whose container no longer exists: a deleted namespace, a
 * resource that disappeared from its list, or one that lost its children.
 * @param {!Object} tree
 * @param {!Object} overview
 * @return {!Array<string>} Keys that were closed.
 */
export function prune(tree, overview) {
  const namespaces = new Set(overview.namespaces.map((ns) => ns.name));
  const closed = [];
  for (const list of [...tree.lists.values()]) {
    if (tree.lists.has(list.key) && !isAnchored(tree, list, namespaces)) {
      closed.push(...closeList(tree, list.key));
    }
  }
  return closed;
}

/**
 * What a change means for the details drawer.
 * @param {?string} uid Resource shown in the drawer, if any.
 * @param {{changed: !Array<string>, deleted: !Array<string>, overflow: boolean}} change
 * @return {string} 'gone', 'refetch' or 'none'.
 */
export function drawerRefresh(uid, change) {
  if (!uid) return 'none';
  if (change.deleted.includes(uid)) return 'gone';
  if (change.overflow || change.changed.includes(uid)) return 'refetch';
  return 'none';
}

/**
 * Turns change notifications into refreshes: debounced, rate limited, never
 * overlapping. Notifications that arrive in between are merged and handed to
 * the next refresh.
 * @param {{
 *   run: function({changed: !Array<string>, deleted: !Array<string>, overflow: boolean}): (!Promise|undefined),
 *   setTimeout: function(function(), number): *,
 *   clearTimeout: function(*),
 *   now: function(): number,
 *   debounceMs?: number,
 *   minIntervalMs?: number,
 * }} options
 * @return {{notify: function(!Object), stop: function()}}
 */
export function createRefreshScheduler(
    {run, setTimeout, clearTimeout, now, debounceMs = 500, minIntervalMs = 2000}) {
  let pending = null;
  let timer = null;
  let running = false;
  let stopped = false;
  let lastStart = -Infinity;
  let lastNotify = 0;

  function arm() {
    if (stopped || running || pending === null) return;
    if (timer !== null) clearTimeout(timer);
    const due = Math.max(lastNotify + debounceMs, lastStart + minIntervalMs);
    timer = setTimeout(fire, Math.max(0, due - now()));
  }

  function fire() {
    timer = null;
    const batch = {changed: [...pending.changed], deleted: [...pending.deleted], overflow: pending.overflow};
    pending = null;
    running = true;
    lastStart = now();
    let result;
    try {
      result = run(batch);
    } catch (err) {
      result = Promise.reject(err);
    }
    // A failed refresh is not fatal: the next change simply triggers another.
    Promise.resolve(result).catch(() => {}).then(() => {
      running = false;
      arm();
    });
  }

  return {
    notify(change) {
      if (stopped) return;
      pending ??= {changed: new Set(), deleted: new Set(), overflow: false};
      for (const uid of change.changed ?? []) pending.changed.add(uid);
      for (const uid of change.deleted ?? []) pending.deleted.add(uid);
      pending.overflow ||= change.overflow === true;
      lastNotify = now();
      arm();
    },
    stop() {
      stopped = true;
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

// --- Nearest rendered ancestor -------------------------------------------------
//
// Element ids are the uid of a widget, `ns:<name>` for a namespace box,
// `cluster` for the cluster-wide area and `nodes` for the Nodes area.

const NODE_KIND = 'core/Node';
const NAMESPACE_KIND = 'core/Namespace';

/**
 * Ids that can stand for a resource on the page, most specific first: its own
 * widget, then its containers from the innermost outward.
 * @param {{uid: string, kindId: string, name: string, path?: !Array<string>}} resource
 * @return {!Array<string>}
 */
function representatives(resource) {
  const ids = [resource.uid];
  // A Namespace object is shown as its namespace box, not as a widget.
  if (resource.kindId === NAMESPACE_KIND) ids.push(`ns:${resource.name}`);
  const path = resource.path ?? [];
  for (let i = path.length - 1; i >= 0; i--) {
    // Nodes are cluster-scoped but live in their own area.
    ids.push(path[i] === 'cluster' && resource.kindId === NODE_KIND ? 'nodes' : path[i]);
  }
  return ids;
}

/**
 * Finds what represents a resource on the page: its own widget or, when that
 * is folded away or filtered out, the nearest rendered box around it.
 * @param {!Object} resource A ResourceSummary or a Link.
 * @param {function(string): boolean} isRendered
 * @return {?string} An element id, or null when nothing of it is rendered.
 */
export function lift(resource, isRendered) {
  return representatives(resource).find(isRendered) ?? null;
}
