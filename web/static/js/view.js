// DOM building and updating: header, sidebar, canvas and drawer. This is the
// only module (besides main.js) that touches the document.
//
// SECURITY: everything that comes from the API (names, reasons, messages,
// YAML, kinds...) is untrusted. It reaches the page only through `textContent`,
// `createTextNode`, `value` and `setAttribute` on a fixed set of harmless
// attribute names. No markup is ever built from strings.

import {groupKinds, groupState, isKindHidden, matchKinds} from './filters.js';
import {
  clampDrawerWidth, clampSidebarWidth, DRAWER_MIN_WIDTH, otherTheme, PANEL_KEY_STEP, panelMaxWidth,
  SIDEBAR_MIN_WIDTH,
} from './layout.js';
import {childScope, lanes, remaining, scopeKey} from './tree.js';
import {tokenize} from './yaml.js';

const HEALTHS = ['green', 'yellow', 'red'];

/** Each health pairs its color with a distinct shape, so color is not the only cue. */
const GLYPH = {green: '●', yellow: '▲', red: '■'};

/**
 * @param {string} health Untrusted health value from the API.
 * @return {string} One of the three known health values, or '' for anything else.
 */
function knownHealth(health) {
  return HEALTHS.includes(health) ? health : '';
}

/**
 * @param {!Document} doc The document holding the static shell (index.html).
 * @param {!Object<string, function(...*)>} handlers Callbacks for user
 *     intent; the view never changes application state itself.
 * @return {!Object} The view.
 */
export function createView(doc, handlers) {
  const byId = (id) => doc.getElementById(id);

  /**
   * Creates an element. `text` and attribute values are always treated as
   * plain text, never as markup.
   * @param {string} tag
   * @param {{class?: string, text?: string, attrs?: !Object<string, string>}=} options
   * @param {!Array<?Node>=} children Null entries are skipped.
   * @return {!HTMLElement}
   */
  function el(tag, {class: className, text, attrs} = {}, children = []) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, String(value));
    for (const child of children) {
      if (child) node.append(child);
    }
    return node;
  }

  /**
   * A colored shape for a health value. The dot carries its own health class,
   * so it never takes the color of the box it happens to sit in.
   */
  function dot(health) {
    const known = knownHealth(health);
    return el('span', {
      class: known ? `dot health-${known}` : 'dot',
      text: GLYPH[known] ?? '?',
      attrs: {'aria-hidden': 'true'},
    });
  }

  /**
   * Runs `render`, which replaces DOM below `root`, and afterwards returns the
   * keyboard focus to the element that stands for the previously focused one.
   * @param {!Element} root
   * @param {function()} render
   */
  function keepFocus(root, render) {
    const active = doc.activeElement;
    const key = active && root.contains(active) ? active.dataset.focusKey : undefined;
    render();
    if (key === undefined || active.isConnected) return;
    for (const candidate of root.querySelectorAll('[data-focus-key]')) {
      if (candidate.dataset.focusKey === key) {
        candidate.focus({preventScroll: true});
        return;
      }
    }
  }

  // --- Header ----------------------------------------------------------------

  function renderSync(sync) {
    const node = byId('sync');
    const wasOpen = node.querySelector('.sync-errors')?.open === true;
    node.className = `sync ${sync.ready ? 'ok' : 'pending'}`;
    node.title = `${sync.kindsSynced} of ${sync.kindsTotal} resource types synced`;
    const status = sync.ready ? '● synced' : `syncing ${sync.kindsSynced}/${sync.kindsTotal}`;
    const children = [doc.createTextNode(status)];
    const errors = sync.errors ?? [];
    if (errors.length > 0) {
      const details = el('details', {class: 'sync-errors'}, [
        el('summary', {text: `⚠ ${errors.length} resource ${errors.length === 1 ? 'type' : 'types'} failed to sync`}),
        el('ul', {}, errors.map((e) => el('li', {text: `${e.kindId}: ${e.message}`}))),
      ]);
      details.open = wasOpen;
      children.push(details);
    }
    node.replaceChildren(...children);
  }

  function renderPills(totals, filters) {
    const pills = byId('pills');
    keepFocus(pills, () => {
      pills.replaceChildren(...HEALTHS.map((health) => {
        const shown = filters.health[health];
        return el('button', {
          class: `pill health-${health}`,
          attrs: {
            'type': 'button',
            'data-health': health,
            'data-focus-key': `pill:${health}`,
            'aria-pressed': String(shown),
            'aria-label': `${totals[health]} ${health} resources; ${shown ? 'shown' : 'hidden'}`,
            'title': `${shown ? 'Hide' : 'Show'} ${health} resources`,
          },
        }, [dot(health), el('span', {class: 'pill-count', text: totals[health]})]);
      }));
    });
  }

  /** The switch for system resources, with how many there are. */
  function renderSystemSwitch(count, shown) {
    byId('system-toggle').checked = shown;
    byId('system-count').textContent = count > 0 ? `${count} ${shown ? 'shown' : 'hidden'}` : '';
  }

  function renderHeader({overview, filters, stream}) {
    byId('cluster-name').textContent = overview.cluster.name;
    byId('cluster-version').textContent = overview.cluster.version;
    renderSync(overview.sync);
    byId('stream').textContent = stream === 'reconnecting' ? 'reconnecting…' : '';
    renderSystemSwitch(overview.systemResources ?? 0, filters.system === true);
    renderPills(overview.health, filters);
    const search = byId('search');
    // Never fight the user: leave the box alone while they are typing in it.
    if (doc.activeElement !== search) search.value = filters.q;
  }

  byId('system-toggle').addEventListener('change', (event) => handlers.onSystemToggle(event.target.checked));
  byId('pills').addEventListener('click', (event) => {
    const pill = event.target.closest('[data-health]');
    if (pill) handlers.onHealthToggle(pill.dataset.health);
  });
  byId('search').addEventListener('input', (event) => handlers.onSearch(event.target.value));

  // --- Sidebar ---------------------------------------------------------------

  /** Last model given to renderSidebar, so typing in the box can re-narrow. */
  let sidebarModel = null;

  /** One resource type: a checkbox, its name, and how many there are. */
  function kindRow(kind, filters) {
    const box = el('input', {attrs: {
      'type': 'checkbox', 'data-kind-id': kind.kindId, 'data-focus-key': `kind:${kind.kindId}`,
    }});
    box.checked = !isKindHidden(filters, kind.kindId);
    return el('li', {class: 'kind-row'}, [el('label', {class: 'check'}, [
      box,
      el('span', {class: 'kind-name', text: kind.kind}),
      el('span', {class: 'count', text: kind.count}),
    ])]);
  }

  /**
   * Names of the API groups whose types the user dropped down. Groups start
   * collapsed, so that the list opens as a short survey of the groups.
   */
  let expandedGroups = new Set();

  /**
   * The disclosure button of an API group: expands or collapses the types
   * listed under it. It only changes the list, never a filter.
   * @param {string} group
   * @param {boolean} expanded Whether the types of the group are listed.
   * @param {boolean} narrowing Whether the user is narrowing the list by text.
   * @return {!HTMLElement}
   */
  function groupToggle(group, expanded, narrowing) {
    const button = el('button', {class: 'toggle group-toggle', text: expanded ? '▾' : '▸', attrs: {
      'type': 'button',
      'data-group-toggle': group,
      'data-focus-key': `group-toggle:${group}`,
      'aria-expanded': String(expanded),
      'aria-label': `${expanded ? 'Collapse' : 'Expand'} the resource types of ${group}`,
      'title': narrowing ? 'Everything that matches the text is listed' : expanded ? 'Collapse' : 'Expand',
    }});
    // Narrowing lists every match, so there is nothing to collapse meanwhile.
    button.disabled = narrowing;
    return button;
  }

  /**
   * One API group: a heading with a disclosure button and a checkbox that
   * acts on every type of the group, followed by those types once the group
   * is expanded.
   */
  function kindGroup({group, kinds, count}, filters, narrowing) {
    const box = el('input', {attrs: {
      'type': 'checkbox', 'data-group': group, 'data-focus-key': `group:${group}`,
      'aria-label': `All resource types of ${group}`,
    }});
    const state = groupState(filters, kinds);
    box.checked = state === 'shown';
    box.indeterminate = state === 'partly';
    const expanded = narrowing || expandedGroups.has(group);
    return el('li', {class: expanded ? 'kind-group' : 'kind-group collapsed', attrs: {'data-group': group}}, [
      el('div', {class: 'kind-group-bar'}, [
        groupToggle(group, expanded, narrowing),
        el('label', {class: 'check kind-group-head'}, [
          box,
          el('span', {class: 'kind-group-name', text: group}),
          el('span', {class: 'count', text: count}),
        ]),
      ]),
      expanded ? el('ul', {class: 'kind-group-kinds'}, kinds.map((kind) => kindRow(kind, filters))) : null,
    ]);
  }

  /** The API groups currently listed, by name, for the group checkboxes. */
  let listedGroups = new Map();

  function renderKindList() {
    const {overview, filters} = sidebarModel;
    const list = byId('kind-list');
    const text = byId('kind-search').value;
    // Narrowing happens before grouping, so a group only lists, counts, and
    // acts on the types that match.
    const groups = groupKinds(matchKinds(overview.kinds, text));
    // While narrowing, a match is listed even when its group is collapsed:
    // someone looking for a type must not be told it does not exist.
    const narrowing = text.trim() !== '';
    listedGroups = new Map(groups.map((g) => [g.group, g]));
    keepFocus(list, () => {
      list.replaceChildren(...groups.map((g) => kindGroup(g, filters, narrowing)));
    });
  }

  function renderSidebar(model) {
    sidebarModel = model;
    const {filters} = model;
    for (const box of byId('health-filter').querySelectorAll('input[data-health]')) {
      box.checked = filters.health[box.dataset.health] === true;
    }
    renderKindList();
  }

  /**
   * Expands exactly the named API groups in the list of resource types; every
   * other group is collapsed. Names of groups the cluster does not have are
   * kept for when it does.
   * @param {!Array<string>} groups
   */
  function setExpandedGroups(groups) {
    expandedGroups = new Set(groups);
    if (sidebarModel) renderKindList();
  }

  byId('health-filter').addEventListener('change', (event) => {
    if (event.target.dataset.health) handlers.onHealthToggle(event.target.dataset.health);
  });
  byId('kind-list').addEventListener('change', (event) => {
    const {kindId, group} = event.target.dataset;
    if (kindId !== undefined) {
      handlers.onKindHidden(kindId, !event.target.checked);
    } else if (group !== undefined && listedGroups.has(group)) {
      const kindIds = listedGroups.get(group).kinds.map((kind) => kind.kindId);
      handlers.onKindsHidden(kindIds, !event.target.checked);
    }
  });
  byId('kind-list').addEventListener('click', (event) => {
    const group = event.target.closest('[data-group-toggle]')?.dataset.groupToggle;
    if (group === undefined) return;
    // Deleting returns false when the group was not expanded: expand it.
    if (!expandedGroups.delete(group)) expandedGroups.add(group);
    renderKindList();
    handlers.onGroupsExpanded([...expandedGroups]);
  });
  byId('kinds-all').addEventListener('click', () => handlers.onAllKindsHidden(false));
  byId('kinds-none').addEventListener('click', () => handlers.onAllKindsHidden(true));
  byId('kind-search').addEventListener('input', () => {
    if (sidebarModel) renderKindList();
  });

  // --- Canvas ----------------------------------------------------------------

  /** Model of the canvas being rendered: {overview, tree, selection}. */
  let canvasModel = null;

  /**
   * Element id -> rendered elements. Ids are resource uids for widgets and the
   * area keys (`nodes`, `cluster`, `ns:<name>`) for areas. A pod can be
   * rendered twice: in its namespace and under its node.
   * @type {!Map<string, !Array<!Element>>}
   */
  const rendered = new Map();

  /**
   * List key -> what its toggle button opens or closes.
   * @type {!Map<string, {scope: !Object, parentKey: ?string}>}
   */
  const toggles = new Map();

  function register(id, element) {
    const elements = rendered.get(id);
    if (elements) {
      elements.push(element);
    } else {
      rendered.set(id, [element]);
    }
  }

  /** @return {string} The worst health with a non-zero count in a rollup. */
  function worst(rollup) {
    if (rollup.red > 0) return 'red';
    return rollup.yellow > 0 ? 'yellow' : 'green';
  }

  function rollupEl(rollup) {
    return el('span', {
      class: 'rollup',
      attrs: {'aria-label': `${rollup.green} green, ${rollup.yellow} yellow, ${rollup.red} red`},
    }, HEALTHS.map((health) => el('span', {
      class: `rollup-item health-${health}${rollup[health] > 0 ? '' : ' zero'}`,
    }, [dot(health), el('span', {class: 'rollup-count', text: rollup[health]})])));
  }

  /**
   * The disclosure button that opens or closes the list of `scope`.
   * @param {!Object} scope
   * @param {?string} parentKey Key of the list the button is rendered in.
   * @param {boolean} open
   * @param {string} label What the button opens, for assistive technology.
   * @return {!HTMLElement}
   */
  function toggleButton(scope, parentKey, open, label) {
    const key = scopeKey(scope);
    toggles.set(key, {scope, parentKey});
    return el('button', {class: 'toggle', text: open ? '▾' : '▸', attrs: {
      'type': 'button',
      'data-toggle': key,
      'data-focus-key': `toggle:${key}`,
      'aria-expanded': String(open),
      'aria-label': `${open ? 'Close' : 'Open'} ${label}`,
    }});
  }

  function renderContainer(container, pod, list) {
    const health = knownHealth(container.health);
    const reason = container.reason || container.state || '';
    const kind = container.init ? 'Init container' : 'Container';
    return el('div', {
      class: `container${health ? ` health-${health}` : ''}${container.init ? ' init' : ''}`,
      attrs: {
        'data-container': container.name,
        'data-focus-key': `container:${list.key}:${pod.uid}:${container.name}`,
        'tabindex': '0',
        'role': 'button',
        'title': reason,
        'aria-label': `${kind} ${container.name}, ${health || 'unknown'}${reason ? `: ${reason}` : ''}`,
      },
    }, [
      dot(container.health),
      el('span', {class: 'container-name', text: container.name}),
      container.init ? el('span', {class: 'tag', text: 'init'}) : null,
    ]);
  }

  function renderWidget(item, list) {
    const scope = childScope(item, list.scope);
    const childList = scope ? canvasModel.tree.lists.get(scopeKey(scope)) : undefined;
    const open = childList !== undefined;
    const health = knownHealth(item.health);
    const label = `${item.kind} ${item.name}`;

    const classes = ['widget'];
    if (health) classes.push(`health-${health}`);
    if (item.selfMatch === false) classes.push('dimmed');
    if (open) classes.push('open');

    const attrs = {
      'data-id': item.uid,
      'data-kind-id': item.kindId,
      'data-focus-key': `widget:${list.key}:${item.uid}`,
      'tabindex': '0',
      // A widget holds further controls (toggle, containers, children), so it
      // is a labelled group rather than a button.
      'role': 'group',
      'aria-label': `${label}, ${health || 'unknown'}${item.reason ? `: ${item.reason}` : ''}`,
    };
    if (item.reason) attrs.title = item.reason;

    const node = el('div', {class: classes.join(' '), attrs}, [
      el('div', {class: 'widget-head'}, [
        scope ? toggleButton(scope, list.key, open, label) : null,
        dot(item.health),
        el('span', {class: 'kind', text: item.kind}),
        el('span', {class: 'name', text: item.name}),
        scope?.type === 'parent' && !open ? rollupEl(item.rollup) : null,
      ]),
      item.reason ? el('div', {class: 'reason', text: item.reason}) : null,
      item.containers?.length ?
          el('div', {class: 'containers'}, item.containers.map((c) => renderContainer(c, item, list))) : null,
      open ? el('div', {class: 'children'}, [renderList(childList)]) : null,
    ]);
    register(item.uid, node);
    return node;
  }

  function renderList(list) {
    const node = el('div', {class: 'list'});
    if (!list.loaded) {
      node.append(el('p', {class: 'note', text: 'Loading…'}));
      return node;
    }
    if (list.error) {
      node.append(el('p', {class: 'note error', text: `Could not load: ${list.error}`}));
    } else if (list.items.length === 0) {
      node.append(el('p', {class: 'note', text: 'Nothing to show.'}));
    }
    for (const lane of lanes(list.items)) {
      node.append(el('div', {class: 'lane'}, [
        el('div', {class: 'lane-label', text: lane.kind}),
        el('div', {class: 'lane-items'}, lane.items.map((item) => renderWidget(item, list))),
      ]));
    }
    const left = remaining(list);
    if (left > 0) {
      node.append(el('button', {class: 'more', text: `Show more (${left} remaining)`, attrs: {
        'type': 'button', 'data-more': list.key, 'data-focus-key': `more:${list.key}`,
      }}));
    }
    return node;
  }

  /** The areas of the cluster box, in display order. */
  function areaModels(overview) {
    return [
      {scope: {type: 'nodes'}, title: 'Nodes', info: overview.nodes},
      {scope: {type: 'cluster'}, title: 'Cluster-wide', info: overview.clusterScoped},
      ...overview.namespaces.map((ns) => ({
        scope: {type: 'namespace', name: ns.name}, title: `namespace: ${ns.name}`, info: ns, namespace: ns,
      })),
    ];
  }

  function renderArea({scope, title, info, namespace}) {
    const key = scopeKey(scope);
    const list = canvasModel.tree.lists.get(key);
    const open = list !== undefined;
    const titleEl = el('span', {class: 'area-title', text: title});
    if (namespace) {
      // The header of a namespace box stands for the Namespace object itself.
      const health = knownHealth(namespace.health);
      titleEl.classList.add('selectable');
      titleEl.setAttribute('data-select-uid', namespace.uid);
      titleEl.setAttribute('data-focus-key', `namespace:${namespace.name}`);
      titleEl.setAttribute('tabindex', '0');
      titleEl.setAttribute('role', 'button');
      titleEl.setAttribute('title', namespace.reason ?? '');
      titleEl.setAttribute('aria-label',
          `Namespace ${namespace.name}, ${health || 'unknown'}${namespace.reason ? `: ${namespace.reason}` : ''}`);
    }
    const node = el('section', {
      class: `area health-${worst(info.rollup)}${open ? ' open' : ''}`,
      attrs: {'data-id': key, 'aria-label': title},
    }, [
      el('header', {class: 'area-head'}, [
        toggleButton(scope, null, open, title),
        namespace ? dot(namespace.health) : null,
        titleEl,
        el('span', {class: 'count', text: info.count}),
        rollupEl(info.rollup),
      ]),
      open ? renderList(list) : null,
    ]);
    register(key, node);
    return node;
  }

  /** Moves the `selected` highlight to what the model says is selected. */
  function applySelection() {
    const areas = byId('areas');
    for (const node of areas.querySelectorAll('.selected')) node.classList.remove('selected');
    const selection = canvasModel?.selection;
    if (!selection) return;
    if (selection.container === undefined) {
      for (const widget of rendered.get(selection.uid) ?? []) widget.classList.add('selected');
      for (const title of areas.querySelectorAll('[data-select-uid]')) {
        if (title.dataset.selectUid === selection.uid) title.classList.add('selected');
      }
      return;
    }
    for (const widget of rendered.get(selection.uid) ?? []) {
      for (const section of widget.children) {
        if (!section.classList.contains('containers')) continue;
        for (const container of section.children) {
          if (container.dataset.container === selection.container) container.classList.add('selected');
        }
      }
    }
  }

  function renderCanvas(model) {
    canvasModel = model;
    byId('cluster-title').textContent = `cluster: ${model.overview.cluster.name}`;
    const scroller = byId('canvas');
    const areas = byId('areas');
    // The areas are rebuilt from the model. What the user must not lose over a
    // (live) re-render is put back explicitly: scroll offsets and focus.
    const {scrollTop, scrollLeft} = scroller;
    keepFocus(areas, () => {
      rendered.clear();
      toggles.clear();
      areas.replaceChildren(...areaModels(model.overview).map(renderArea));
    });
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = scrollLeft;
    applySelection();
  }

  /**
   * @param {string} id A resource uid or an area key.
   * @return {?Element} The element standing for it. A pod rendered both in its
   *     namespace and under its node is represented by the namespace instance.
   */
  function elementFor(id) {
    const elements = rendered.get(id);
    if (!elements) return null;
    return elements.find((e) => !e.parentElement.closest('[data-kind-id="core/Node"]')) ?? elements[0];
  }

  /** @return {boolean} Whether a widget or area box with this id is rendered. */
  function hasElement(id) {
    return rendered.has(id);
  }

  /**
   * Scrolls a rendered resource or area into view and flashes it.
   * @param {string} id
   * @return {boolean} False when nothing with this id is rendered.
   */
  function reveal(id) {
    const element = elementFor(id);
    if (!element) return false;
    for (const old of doc.querySelectorAll('.flash')) old.classList.remove('flash');
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({block: 'center', inline: 'nearest'});
    }
    element.classList.add('flash');
    return true;
  }

  /**
   * Updates the highlight without rendering the canvas again.
   * @param {?{uid: string, container?: string}} selection
   */
  function setSelection(selection) {
    if (!canvasModel) return;
    canvasModel = {...canvasModel, selection};
    applySelection();
  }

  /** @return {?Element} The element an event happened on. */
  function targetElement(event) {
    const target = event.target;
    return target.nodeType === 1 ? target : target.parentElement;
  }

  /**
   * @param {!Element} target
   * @return {?{uid: string, container?: string}} What a click or key press on
   *     `target` selects: the innermost container, namespace header or widget.
   */
  function selectionAt(target) {
    const node = target.closest('[data-container], [data-select-uid], .widget');
    if (!node) return null;
    if (node.dataset.container !== undefined) {
      return {uid: node.closest('.widget').dataset.id, container: node.dataset.container};
    }
    if (node.dataset.selectUid !== undefined) return {uid: node.dataset.selectUid};
    return {uid: node.dataset.id};
  }

  const canvasEl = byId('canvas');

  canvasEl.addEventListener('click', (event) => {
    const target = targetElement(event);
    const control = target.closest('button');
    if (control) {
      if (control.dataset.toggle !== undefined) {
        const toggle = toggles.get(control.dataset.toggle);
        if (toggle) handlers.onToggle(toggle.scope, toggle.parentKey);
      } else if (control.dataset.more !== undefined) {
        handlers.onShowMore(control.dataset.more);
      }
      return;
    }
    const selection = selectionAt(target);
    if (selection) handlers.onSelect(selection);
  });

  canvasEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = targetElement(event);
    // Only when the selectable thing itself has the focus; buttons inside it
    // handle their own keys.
    if (!target.matches('.widget, [data-container], [data-select-uid]')) return;
    event.preventDefault();
    handlers.onSelect(selectionAt(target));
  });

  byId('expand-all').addEventListener('click', () => handlers.onExpandAll());
  byId('collapse-all').addEventListener('click', () => handlers.onCollapseAll());

  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') handlers.onCloseDrawer();
  });

  canvasEl.addEventListener('animationend', (event) => targetElement(event).classList.remove('flash'));

  // --- Drawer ----------------------------------------------------------------

  /** Identifies what the drawer shows, to tell a refresh from a new selection. */
  let drawerKey = null;

  const qualifiedName = (namespace, name) => (namespace ? `${namespace}/${name}` : name);

  function healthBadge(health) {
    return el('span', {class: 'badge'}, [dot(health), doc.createTextNode(` ${knownHealth(health) || 'unknown'}`)]);
  }

  function note(text, isError = false) {
    return el('p', {class: isError ? 'note error' : 'note', text});
  }

  /** A monospace block of YAML with light syntax coloring. */
  function yamlBlock(text) {
    const pre = el('pre', {class: 'yaml'});
    tokenize(text).forEach((tokens, index) => {
      if (index > 0) pre.append('\n');
      for (const token of tokens) {
        pre.append(token.type === 'text' ?
            doc.createTextNode(token.text) : el('span', {class: `tok-${token.type}`, text: token.text}));
      }
    });
    return pre;
  }

  /**
   * @param {!Array<string>} columns Header labels.
   * @param {!Array<{cells: !Array<*>, class?: string}>} rows
   * @return {!HTMLElement}
   */
  function table(columns, rows) {
    return el('div', {class: 'table-wrap'}, [el('table', {class: 'grid'}, [
      el('thead', {}, [el('tr', {}, columns.map((text) => el('th', {text, attrs: {scope: 'col'}})))]),
      el('tbody', {}, rows.map((row) =>
          el('tr', {class: row.class}, row.cells.map((text) => el('td', {text: text ?? ''}))))),
    ])]);
  }

  function section(name, title, children, action = null) {
    return el('section', {class: `section ${name}`}, [
      el('div', {class: 'section-head'}, [el('h3', {class: 'section-title', text: title}), action]),
      ...children,
    ]);
  }

  function configurationSection(yaml) {
    const copy = el('button', {class: 'copy', text: 'Copy', attrs: {'type': 'button', 'data-focus-key': 'copy'}});
    copy.addEventListener('click', () => {
      Promise.resolve(handlers.onCopy(yaml)).then((copied) => {
        copy.textContent = copied ? 'Copied' : 'Copy failed';
      });
    });
    return section('configuration', 'Configuration', [yamlBlock(yaml)], copy);
  }

  function statusSection(conditions, statusYaml) {
    const children = [];
    if (conditions.length > 0) {
      children.push(table(
          ['Type', 'Status', 'Reason', 'Message', 'Last transition', 'Source'],
          conditions.map((c) => ({cells: [c.type, c.status, c.reason, c.message, c.lastTransitionTime, c.source]}))));
    }
    if (statusYaml) children.push(yamlBlock(statusYaml));
    if (children.length === 0) children.push(note('No status.'));
    return section('status', 'Status', children);
  }

  function eventsSection(events, eventsError) {
    const children = [];
    if (eventsError) {
      children.push(note(`Events could not be loaded: ${eventsError}`, true));
    } else if (events.length === 0) {
      children.push(note('No events'));
    }
    if (events.length > 0) {
      children.push(table(
          ['Type', 'Reason', 'Message', 'Count', 'Last seen', 'Source'],
          events.map((e) => ({
            cells: [e.type, e.reason, e.message, e.count, e.lastSeen, e.source],
            class: e.type === 'Warning' ? 'warning' : undefined,
          }))));
    }
    return section('events', 'Events', children);
  }

  /** A link that selects and reveals another resource. */
  function resourceLink(target, focusKey) {
    const button = el('button', {
      class: 'link',
      text: `${target.kind} ${qualifiedName(target.namespace, target.name)}`,
      attrs: {'type': 'button', 'data-focus-key': focusKey},
    });
    button.addEventListener('click', () => handlers.onReveal(target));
    return button;
  }

  const relationEl = (relation) => (relation ? el('span', {class: 'relation', text: relation}) : null);

  /** Children of a list item, separated by spaces so the text reads naturally. */
  function spaced(parts) {
    const nodes = [];
    for (const part of parts) {
      if (!part) continue;
      if (nodes.length > 0) nodes.push(doc.createTextNode(' '));
      nodes.push(part);
    }
    return nodes;
  }

  function linkGroup(name, title, links) {
    return el('div', {class: 'link-group'}, [
      el('h4', {class: 'subsection-title', text: title}),
      el('ul', {class: 'links'}, links.map((link) => {
        const health = knownHealth(link.health);
        return el('li', {class: health ? `health-${health}` : undefined}, spaced([
          dot(link.health),
          resourceLink(link, `link:${name}:${link.uid}:${link.relation ?? ''}`),
          relationEl(link.relation),
        ]));
      })),
    ]);
  }

  function missingGroup(missing) {
    return el('div', {class: 'link-group missing'}, [
      el('h4', {class: 'subsection-title', text: 'Missing references'}),
      el('ul', {class: 'links'}, missing.map((m) => el('li', {}, spaced([
        el('span', {class: 'missing-mark', text: '⚠', attrs: {'aria-label': 'missing'}}),
        el('span', {class: 'missing-name', text: `${m.kind} ${qualifiedName(m.namespace, m.name)}`}),
        relationEl(m.relation),
      ])))),
    ]);
  }

  function connectionsSection(detail) {
    const children = [];
    for (const [name, title] of [['owners', 'Owned by'], ['outgoing', 'Refers to'], ['incoming', 'Referred to by']]) {
      const links = detail[name] ?? [];
      if (links.length > 0) children.push(linkGroup(name, title, links));
    }
    if ((detail.missing ?? []).length > 0) children.push(missingGroup(detail.missing));
    if (children.length === 0) children.push(note('No connections.'));
    return section('connections', 'Connections', children);
  }

  function drawerHead(kind, name, health, reason, extra = []) {
    const known = knownHealth(health);
    return el('header', {class: `drawer-head${known ? ` health-${known}` : ''}`}, [
      el('div', {class: 'drawer-kind', text: kind}),
      el('h2', {class: 'drawer-name', text: name}),
      el('div', {class: 'drawer-health'}, [healthBadge(health), el('span', {class: 'drawer-reason', text: reason ?? ''})]),
      ...extra,
    ]);
  }

  function resourceContent(detail) {
    const {summary} = detail;
    return [
      drawerHead(summary.kind, qualifiedName(summary.namespace, summary.name), summary.health, summary.reason),
      // Product requirement: the configuration first, the status after it.
      configurationSection(detail.yaml ?? ''),
      statusSection(detail.conditions ?? [], detail.statusYaml ?? ''),
      eventsSection(detail.events ?? [], detail.eventsError ?? ''),
      connectionsSection(detail),
    ];
  }

  function containerContent(detail) {
    const {container, pod} = detail;
    const facts = [
      ['Image', container.image],
      ['State', container.state],
      ['Ready', container.ready ? 'yes' : 'no'],
      ['Restarts', container.restarts],
    ];
    return [
      drawerHead(container.init ? 'Init container' : 'Container', container.name, container.health, container.reason, [
        el('dl', {class: 'facts'}, facts.flatMap(([label, value]) =>
            [el('dt', {text: label}), el('dd', {text: value ?? ''})])),
        el('p', {class: 'drawer-back'}, spaced([doc.createTextNode('in'), resourceLink(pod, 'back')])),
      ]),
      configurationSection(detail.yaml ?? ''),
      statusSection([], detail.statusYaml ?? ''),
      eventsSection(detail.events ?? [], detail.eventsError ?? ''),
    ];
  }

  function drawerContent(drawer) {
    switch (drawer.state) {
      case 'loading': return [note('Loading…')];
      case 'gone': return [note('This resource no longer exists.')];
      case 'error': return [note(`Could not load the details: ${drawer.message}`, true)];
      default:
        return drawer.selection.container === undefined ?
            resourceContent(drawer.detail) : containerContent(drawer.detail);
    }
  }

  /**
   * @param {{state: string, selection?: {uid: string, container?: string},
   *          detail?: !Object, message?: string}} drawer `state` is one of
   *     closed, loading, ready, gone, error.
   */
  function renderDrawer(drawer) {
    const panel = byId('drawer');
    const body = byId('drawer-body');
    // The divider of the details panel is only there while the panel is.
    byId('drawer-resizer').hidden = drawer.state === 'closed';
    if (drawer.state === 'closed') {
      panel.hidden = true;
      body.replaceChildren();
      drawerKey = null;
      return;
    }
    const key = `${drawer.selection.uid}\n${drawer.selection.container ?? ''}`;
    // A refresh of what is already shown keeps the reading position; a new
    // selection starts at the top.
    const scrollTop = key === drawerKey ? panel.scrollTop : 0;
    drawerKey = key;
    panel.hidden = false;
    keepFocus(body, () => body.replaceChildren(...drawerContent(drawer)));
    panel.scrollTop = scrollTop;
  }

  byId('drawer-close').addEventListener('click', () => handlers.onCloseDrawer());

  /**
   * Shows or clears the application-level error banner.
   * @param {?string} message
   */
  function renderError(message) {
    const banner = byId('app-error');
    banner.hidden = !message;
    banner.textContent = message ?? '';
  }

  // --- Side panel widths -------------------------------------------------------
  // The divider between a side panel and the canvas can be dragged, or moved
  // with the arrow keys while focused. The width is applied here; the
  // application only hears about the width the user settled on.

  const viewportWidth = () => doc.defaultView.innerWidth;

  /**
   * Makes a side panel resizable through its divider.
   * @param {{
   *   panel: !Element,
   *   divider: !Element,
   *   min: number,
   *   clamp: function(*, number): number,
   *   widthAt: function(number): number,
   *   grow: number,
   *   report: function(number),
   * }} options `clamp` brings a width within the panel's limits for a window
   *     width (never more than a third of it). `widthAt` is the panel width
   *     that puts the divider under a pointer at the given x. `grow` is +1
   *     when moving the divider right widens the panel and -1 when moving it
   *     left does. `report` hears the width the user settled on.
   * @return {function(?number)} Gives the panel a width in pixels; null
   *     restores its default.
   */
  function resizable({panel, divider, min, clamp, widthAt, grow, report}) {
    /** Width the panel was given, or null while it has its default. */
    let width = null;
    let dragging = false;

    /** Keeps the divider's description for assistive technology up to date. */
    function describe() {
      const viewport = viewportWidth();
      const max = panelMaxWidth(viewport);
      divider.setAttribute('aria-valuemin', String(Math.min(min, max)));
      divider.setAttribute('aria-valuemax', String(max));
      divider.setAttribute('aria-valuenow', String(clamp(width, viewport)));
    }

    function setWidth(wanted) {
      if (wanted === null || wanted === undefined) {
        width = null;
        panel.style.width = '';
      } else {
        width = clamp(wanted, viewportWidth());
        panel.style.width = `${width}px`;
      }
      describe();
    }

    divider.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      // Without this the drag would select text across the page.
      event.preventDefault();
      dragging = true;
      doc.body.classList.add('resizing-panel');
    });
    // The pointer leaves the thin divider as soon as it moves, so the rest of
    // the drag is followed on the whole document.
    doc.addEventListener('mousemove', (event) => {
      if (dragging) setWidth(widthAt(event.clientX));
    });
    doc.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      doc.body.classList.remove('resizing-panel');
      if (width !== null) report(width);
    });
    divider.addEventListener('keydown', (event) => {
      const direction = {ArrowLeft: -1, ArrowRight: 1}[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      setWidth(clamp(width, viewportWidth()) + direction * grow * PANEL_KEY_STEP);
      report(width);
    });
    // The stylesheet caps the panel when the window shrinks; only the limits
    // announced on the divider need refreshing.
    doc.defaultView.addEventListener('resize', describe);
    describe();
    return setWidth;
  }

  const sidebarEl = byId('sidebar');
  const resizer = byId('sidebar-resizer');
  const setSidebarWidth = resizable({
    panel: sidebarEl,
    divider: resizer,
    min: SIDEBAR_MIN_WIDTH,
    clamp: clampSidebarWidth,
    // The filters panel starts at the left edge of the window.
    widthAt: (x) => x - sidebarEl.getBoundingClientRect().left,
    grow: 1,
    report: (width) => handlers.onSidebarWidth(width),
  });

  const drawerEl = byId('drawer');
  const setDrawerWidth = resizable({
    panel: drawerEl,
    divider: byId('drawer-resizer'),
    min: DRAWER_MIN_WIDTH,
    clamp: clampDrawerWidth,
    // The details panel ends at the right edge of the window, so its divider
    // is on its left and dragging to the left widens it.
    widthAt: (x) => (drawerEl.getBoundingClientRect().right || viewportWidth()) - x,
    grow: -1,
    report: (width) => handlers.onDrawerWidth(width),
  });

  // --- Hiding the filters panel ----------------------------------------------
  // The button in the header hides the panel together with its divider. The
  // filters themselves are untouched: they keep applying while out of sight.

  const sidebarToggle = byId('sidebar-toggle');

  /**
   * Hides or shows the filters panel.
   * @param {boolean} hidden
   */
  function setSidebarHidden(hidden) {
    // Keyboard focus must not stay behind in a panel that is no longer there.
    const focusInside = hidden && sidebarEl.contains(doc.activeElement);
    sidebarEl.hidden = hidden;
    resizer.hidden = hidden;
    sidebarToggle.setAttribute('aria-expanded', String(!hidden));
    sidebarToggle.title = hidden ? 'Show the filters panel' : 'Hide the filters panel';
    if (focusInside) sidebarToggle.focus();
  }

  sidebarToggle.addEventListener('click', () => {
    const hidden = !sidebarEl.hidden;
    setSidebarHidden(hidden);
    handlers.onSidebarHidden(hidden);
  });

  // --- Theme -----------------------------------------------------------------
  // The stylesheet has a night theme (the default) and a day theme, chosen by
  // the data-theme attribute of the root element. The button in the header
  // names the theme it switches to.

  const THEME_BUTTON = {
    day: {icon: '\u2600\uFE0E', name: 'Day'},
    night: {icon: '\u263E\uFE0E', name: 'Night'},
  };

  /**
   * Shows the page in a theme.
   * @param {string} theme 'day'; anything else is the night theme.
   */
  function setTheme(theme) {
    const shown = theme === 'day' ? 'day' : 'night';
    const other = otherTheme(shown);
    doc.documentElement.dataset.theme = shown;
    byId('theme-icon').textContent = THEME_BUTTON[other].icon;
    byId('theme-name').textContent = THEME_BUTTON[other].name;
    const label = `Switch to the ${other} theme`;
    byId('theme-toggle').setAttribute('aria-label', label);
    byId('theme-toggle').title = label;
  }

  byId('theme-toggle').addEventListener('click', () => {
    // The page itself knows its theme: js/theme-boot.js may have applied a
    // remembered one before this module ran.
    const theme = otherTheme(doc.documentElement.dataset.theme);
    setTheme(theme);
    handlers.onTheme(theme);
  });

  return {
    renderHeader, renderSidebar, renderCanvas, renderDrawer, renderError,
    setSelection, hasElement, reveal, setSidebarWidth, setSidebarHidden, setDrawerWidth, setExpandedGroups,
    setTheme,
  };
}
