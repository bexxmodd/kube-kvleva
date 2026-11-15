// Wiring: application state, user intent, loading, and the refresh loop.
//
// `startApp` takes every browser facility it needs as an argument, so the whole
// app can run against a fake backend and a fake clock in tests. Loading this
// module in a browser starts the app with the real ones (see the bottom).
//
// The app is read-only: the only network traffic is GET requests issued by
// api.js and the EventSource stream.

import {createApi} from './api.js';
import {
  loadFilters, saveFilters, setAllKindsHidden, setKindHidden, setKindsHidden, setQuery, setSystem, toggleHealth,
  toQuery,
} from './filters.js';
import {
  loadDrawerWidth, loadExpandedGroups, loadSidebarHidden, loadSidebarWidth, loadTheme, saveDrawerWidth,
  saveExpandedGroups, saveSidebarHidden, saveSidebarWidth, saveTheme,
} from './layout.js';
import {
  addPage, areaScopes, autoOpenScopes, childScope, closeList, createRefreshScheduler, createTree,
  drawerRefresh, getList, initialScopes, isOpen, lift, nextPageRequest, openList, prune, refreshRequests, remaining,
  replaceItems, scopeKey, setError,
} from './tree.js';
import {createView} from './view.js';

/** Delay before retrying when the backend cannot be reached on load. */
const RETRY_MS = 3000;

/** The search box waits this long after the last keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

/** Extra pages loaded per list while looking for a resource to reveal. */
const REVEAL_MAX_PAGES = 10;

/**
 * @param {{
 *   document: !Document,
 *   fetch: function(string, !Object): !Promise<!Response>,
 *   EventSource: function(new: EventSource, string),
 *   storage: (?Storage|undefined),
 *   setTimeout: function(function(), number): *,
 *   clearTimeout: function(*),
 *   now: function(): number,
 *   clipboard: ({writeText: function(string): !Promise}|undefined),
 * }} env
 * @return {{stop: function()}}
 */
export function startApp(env) {
  const api = createApi({fetch: env.fetch, EventSource: env.EventSource});

  const state = {
    /** The latest /api/overview response; null until the first load. */
    overview: null,
    filters: loadFilters(env.storage),
    /** Bumped whenever the filter query changes; older responses are dropped. */
    filterEpoch: 0,
    tree: createTree(),
    /** @type {?{uid: string, container?: string}} */
    selection: null,
    drawer: {state: 'closed'},
    /** 'open' or 'reconnecting'. */
    stream: 'open',
  };

  /** List key -> promise of the page request in flight for that list. */
  const loading = new Map();

  let searchTimer = null;
  let stopped = false;

  const view = createView(env.document, {
    onToggle: (scope, parentKey) => toggle(scope, parentKey),
    onShowMore: (key) => loadNextPage(key),
    onExpandAll: () => expandAll(),
    onCollapseAll: () => collapseAll(),
    onSelect: (selection) => select(selection),
    onReveal: (target) => reveal(target),
    onCloseDrawer: () => closeDrawer(),
    onSidebarWidth: (width) => saveSidebarWidth(env.storage, width),
    onSidebarHidden: (hidden) => saveSidebarHidden(env.storage, hidden),
    onDrawerWidth: (width) => saveDrawerWidth(env.storage, width),
    onGroupsExpanded: (groups) => saveExpandedGroups(env.storage, groups),
    onTheme: (theme) => saveTheme(env.storage, theme),
    onSystemToggle: (shown) => applyFilters(setSystem(state.filters, shown)),
    onHealthToggle: (health) => applyFilters(toggleHealth(state.filters, health)),
    onKindHidden: (kindId, hidden) => applyFilters(setKindHidden(state.filters, kindId, hidden)),
    onKindsHidden: (kindIds, hidden) => applyFilters(setKindsHidden(state.filters, kindIds, hidden)),
    onAllKindsHidden: (hidden) =>
        applyFilters(setAllKindsHidden(state.filters, state.overview?.kinds ?? [], hidden)),
    onSearch: (text) => {
      env.clearTimeout(searchTimer);
      searchTimer = env.setTimeout(() => applyFilters(setQuery(state.filters, text)), SEARCH_DEBOUNCE_MS);
    },
    onCopy: async (text) => {
      try {
        await env.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
  });

  // The layout and the theme do not depend on the cluster, so what the user
  // chose for them (the theme, the widths of the side panels, whether the
  // filters panel is shown, and which API groups are expanded in it) is
  // restored right away.
  view.setTheme(loadTheme(env.storage));
  view.setSidebarWidth(loadSidebarWidth(env.storage));
  view.setSidebarHidden(loadSidebarHidden(env.storage));
  view.setDrawerWidth(loadDrawerWidth(env.storage));
  view.setExpandedGroups(loadExpandedGroups(env.storage));

  // --- Rendering -------------------------------------------------------------
  // Nothing can be rendered before the first overview has arrived; controls of
  // the static shell that are used earlier only change state.

  function renderSidebar() {
    if (state.overview === null) return;
    view.renderSidebar({overview: state.overview, filters: state.filters});
  }

  function renderHeader() {
    if (state.overview === null) return;
    view.renderHeader({overview: state.overview, filters: state.filters, stream: state.stream});
  }

  function renderChrome() {
    renderHeader();
    renderSidebar();
  }

  function renderCanvas() {
    if (state.overview === null) return;
    view.renderCanvas({overview: state.overview, tree: state.tree, selection: state.selection});
  }

  function renderDrawer() {
    view.renderDrawer(state.drawer);
  }

  // --- Lists -----------------------------------------------------------------

  /**
   * Loads the next page of an open list. Concurrent calls for the same list
   * share one request.
   * @param {string} key
   * @return {!Promise<void>}
   */
  function loadNextPage(key) {
    const inFlight = loading.get(key);
    if (inFlight) return inFlight;
    const list = getList(state.tree, key);
    const request = list ? nextPageRequest(list) : null;
    if (!request) return Promise.resolve();

    const epoch = state.filterEpoch;
    // A page is dropped when its list was closed (or closed and reopened) or
    // the filters changed while it was on its way.
    const current = () => getList(state.tree, key) === list && epoch === state.filterEpoch;
    const done = (async () => {
      try {
        const page = await api.resources(list.scope, toQuery(state.filters), request);
        if (current()) addPage(state.tree, key, page);
      } catch (err) {
        if (current()) setError(state.tree, key, err.message);
      } finally {
        loading.delete(key);
      }
      renderCanvas();
    })();
    loading.set(key, done);
    return done;
  }

  /**
   * Opens a list and loads its first page.
   * @param {!Object} scope
   * @param {?string} parentKey
   * @param {boolean} auto Whether to keep opening small child lists (the
   *     initial expansion).
   * @return {!Promise<void>}
   */
  async function open(scope, parentKey, auto = false) {
    const list = openList(state.tree, scope, parentKey);
    renderCanvas();
    await loadNextPage(list.key);
    if (auto && getList(state.tree, list.key) === list) {
      await Promise.all(autoOpenScopes(list).map((child) => open(child, list.key, true)));
    }
  }

  function toggle(scope, parentKey) {
    const key = scopeKey(scope);
    if (isOpen(state.tree, key)) {
      closeList(state.tree, key);
      renderCanvas();
      return Promise.resolve();
    }
    return open(scope, parentKey);
  }

  function expandAll() {
    if (state.overview === null) return Promise.resolve();
    return Promise.all(areaScopes(state.overview).map((scope) => open(scope, null)));
  }

  function collapseAll() {
    for (const key of [...state.tree.lists.keys()]) closeList(state.tree, key);
    renderCanvas();
  }

  /**
   * Refetches every open list, keeping the number of pages each had loaded.
   * Only open lists exist in the tree, so nothing closed is ever fetched.
   * @return {!Promise<function()>} Applies the fetched pages to the tree; it
   *     does nothing when the filters changed in the meantime.
   */
  async function fetchOpenLists() {
    const epoch = state.filterEpoch;
    const query = toQuery(state.filters);
    const results = await Promise.all(refreshRequests(state.tree).map(async (request) => {
      try {
        const page = await api.resources(request.scope, query, {offset: request.offset, limit: request.limit});
        return {key: request.key, page};
      } catch (err) {
        return {key: request.key, error: err.message};
      }
    }));
    return () => {
      // The filters changed while these were on their way: a newer reload
      // owns the lists now.
      if (epoch !== state.filterEpoch) return;
      const byKey = new Map();
      for (const result of results) {
        if (!byKey.has(result.key)) byKey.set(result.key, []);
        byKey.get(result.key).push(result);
      }
      for (const [key, parts] of byKey) {
        const failed = parts.find((part) => part.error !== undefined);
        if (failed) {
          // Keep what the list shows and say that it could not be refreshed.
          setError(state.tree, key, failed.error);
        } else {
          replaceItems(state.tree, key, parts.map((part) => part.page));
        }
      }
    };
  }

  async function reloadLists() {
    const apply = await fetchOpenLists();
    apply();
    prune(state.tree, state.overview);
    renderCanvas();
  }

  /**
   * Brings everything shown up to date after the cluster changed: the
   * overview and every open list, fetched side by side. Lists whose container
   * is no longer in the overview are closed.
   * @return {!Promise<void>}
   */
  async function reloadEverything() {
    const epoch = state.filterEpoch;
    const [overview, applyLists] =
        await Promise.all([api.overview(toQuery(state.filters)).catch(() => null), fetchOpenLists()]);
    // The filters changed while this was on its way: a newer reload owns the
    // page now.
    if (epoch !== state.filterEpoch) return;
    // When the overview could not be fetched the previous one stays.
    if (overview) state.overview = overview;
    applyLists();
    prune(state.tree, state.overview);
    renderChrome();
    renderCanvas();
  }

  /**
   * Reloads after the system resources switch was flipped. The switch changes
   * what the cluster consists of, so the overview comes first: lists of
   * namespaces that are no longer shown are closed instead of refetched.
   * @return {!Promise<void>}
   */
  async function reloadCluster() {
    const epoch = state.filterEpoch;
    const overview = await api.overview(toQuery(state.filters)).catch(() => null);
    if (epoch !== state.filterEpoch) return;
    // When the overview could not be fetched the previous one stays.
    if (overview) {
      state.overview = overview;
      prune(state.tree, overview);
      renderChrome();
    }
    await reloadLists();
  }

  // --- Filters ---------------------------------------------------------------

  function applyFilters(next) {
    const before = toQuery(state.filters);
    state.filters = next;
    saveFilters(env.storage, next);
    // Before the first load there is nothing to refetch: the load itself will
    // use these filters.
    if (state.overview === null) return Promise.resolve();
    renderChrome();
    const after = toQuery(next);
    // A change that leaves the query as it was (unchecking the last health
    // checks all of them again) needs no refetch.
    if (JSON.stringify(after) === JSON.stringify(before)) return Promise.resolve();
    state.filterEpoch++;
    // The other filters only narrow the lists; the overview stays as it is.
    return after.system === before.system ? reloadLists() : reloadCluster();
  }

  // --- Selection and the drawer ----------------------------------------------

  /** Identifies the latest details request; older responses are dropped. */
  let detailsToken = 0;

  async function loadDetails(selection) {
    const token = ++detailsToken;
    let drawer;
    try {
      const detail = selection.container === undefined ?
          await api.resource(selection.uid) : await api.container(selection.uid, selection.container);
      drawer = {state: 'ready', selection, detail};
    } catch (err) {
      drawer = err.status === 404 ?
          {state: 'gone', selection} : {state: 'error', selection, message: err.message};
    }
    if (token !== detailsToken) return;
    state.drawer = drawer;
    renderDrawer();
  }

  function select(selection) {
    state.selection = selection;
    state.drawer = {state: 'loading', selection};
    view.setSelection(selection);
    renderDrawer();
    return loadDetails(selection);
  }

  function closeDrawer() {
    detailsToken++;
    state.selection = null;
    state.drawer = {state: 'closed'};
    view.setSelection(null);
    renderDrawer();
  }

  // --- Revealing -------------------------------------------------------------

  /** @return {?Object} Scope of the area that holds a resource, if it exists. */
  function areaScopeOf(target) {
    if (target.kindId === 'core/Node') return {type: 'nodes'};
    const root = (target.path ?? [])[0];
    if (root === 'cluster') return {type: 'cluster'};
    if (typeof root !== 'string' || !root.startsWith('ns:')) return null;
    const name = root.slice('ns:'.length);
    return state.overview.namespaces.some((ns) => ns.name === name) ? {type: 'namespace', name} : null;
  }

  /** Opens a list if needed and waits for its first page. */
  async function ensureOpen(scope, parentKey) {
    const key = scopeKey(scope);
    if (!isOpen(state.tree, key)) {
      openList(state.tree, scope, parentKey);
      renderCanvas();
    }
    if (!getList(state.tree, key).loaded) await loadNextPage(key);
    return getList(state.tree, key) ?? null;
  }

  /** Finds an item in a list, loading a bounded number of further pages. */
  async function findItem(list, uid) {
    for (let extraPages = 0; ; extraPages++) {
      const item = list.items.find((candidate) => candidate.uid === uid);
      if (item) return item;
      const exhausted = remaining(list) === 0 || list.error !== null || getList(state.tree, list.key) !== list;
      if (exhausted || extraPages >= REVEAL_MAX_PAGES) return null;
      await loadNextPage(list.key);
    }
  }

  /**
   * Selects a resource and reveals it: opens the containers named in its
   * path, then scrolls it (or, when the filters hide it, its nearest shown
   * ancestor) into view and flashes it.
   * @param {{uid: string, kindId: string, name: string, path?: !Array<string>}} target
   *     A Link or a ResourceSummary.
   * @return {!Promise<void>}
   */
  async function reveal(target) {
    const details = select({uid: target.uid});
    // A Namespace object is its namespace box, which is always rendered.
    if (target.kindId !== 'core/Namespace') {
      const areaScope = areaScopeOf(target);
      let list = areaScope ? await ensureOpen(areaScope, null) : null;
      for (const ancestor of (target.path ?? []).slice(1)) {
        if (!list) break;
        // An ancestor the filters hide is skipped: its children were promoted
        // into the list we are already in.
        const item = await findItem(list, ancestor);
        const scope = item ? childScope(item, list.scope) : null;
        if (scope) list = await ensureOpen(scope, list.key);
      }
      if (list) await findItem(list, target.uid);
    }
    const id = lift(target, view.hasElement);
    if (id !== null) view.reveal(id);
    await details;
  }

  // --- Live updates ----------------------------------------------------------

  /**
   * Brings what is shown up to date: the overview, every open list, and the
   * drawer when its resource is affected. Open state, loaded page counts,
   * selection, focus and scroll are kept (the view restores the last two).
   * @param {{changed: !Array<string>, deleted: !Array<string>, overflow: boolean}} change
   * @return {!Promise<void>}
   */
  async function refresh(change) {
    if (stopped || state.overview === null) return;

    const selection = state.selection;
    switch (drawerRefresh(selection?.uid ?? null, change)) {
      case 'gone':
        detailsToken++;
        state.drawer = {state: 'gone', selection};
        renderDrawer();
        break;
      case 'refetch':
        // Not awaited, and without a "Loading…" flash: the drawer keeps what
        // it shows until the new details arrive.
        loadDetails(selection);
        break;
      default:
    }

    await reloadEverything();
  }

  const scheduler = createRefreshScheduler({
    run: refresh, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, now: env.now,
  });

  const closeStream = api.subscribe({
    onChange: (change) => {
      // The event sent right after connecting only repeats the current
      // revision: when nothing is newer than what is shown, nothing is fetched.
      const nothingNew = !change.overflow && change.changed.length === 0 && change.deleted.length === 0 &&
          state.overview !== null && change.revision <= state.overview.revision;
      if (!nothingNew) scheduler.notify(change);
    },
    onState: (stream) => {
      const wasDown = state.stream === 'reconnecting';
      state.stream = stream;
      if (state.overview !== null) renderHeader();
      // Changes may have been missed while the stream was down.
      if (stream === 'open' && wasDown) scheduler.notify({changed: [], deleted: [], overflow: true});
    },
  });

  // --- Loading ---------------------------------------------------------------

  async function load() {
    if (stopped) return;
    try {
      state.overview = await api.overview(toQuery(state.filters));
    } catch (err) {
      view.renderError(`Cannot reach the kvleva backend: ${err.message}. Retrying…`);
      env.setTimeout(load, RETRY_MS);
      return;
    }
    view.renderError(null);
    renderChrome();
    renderCanvas();
    await Promise.all(initialScopes(state.overview).map((scope) => open(scope, null, true)));
  }

  load();

  return {
    stop() {
      stopped = true;
      env.clearTimeout(searchTimer);
      scheduler.stop();
      closeStream();
    },
  };
}

/**
 * @param {!Window} win
 * @return {?Storage} localStorage, or null where the browser forbids it.
 */
function storageOf(win) {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

// In a browser, start with the real facilities. (Tests import this module
// without a global document and call startApp themselves.)
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const win = window;
  startApp({
    document,
    fetch: (url, init) => win.fetch(url, init),
    EventSource: win.EventSource,
    storage: storageOf(win),
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id),
    now: () => Date.now(),
    clipboard: win.navigator.clipboard,
  });
}
