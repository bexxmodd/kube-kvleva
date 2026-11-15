import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import * as tree from '../static/js/tree.js';
import * as fx from './fixtures.js';
import {assertNoPageErrors, fire, loadShell, recorder} from './helpers.js';

afterEach(assertNoPageErrors);

const NS = {type: 'namespace', name: 'default'};

function mount() {
  const {document, window} = loadShell();
  const {handlers, calls} = recorder();
  const view = viewModule.createView(document, handlers);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  /** The element with the given data-id (a widget or an area). */
  const byDataId = (id) => $$('[data-id]').find((e) => e.dataset.id === id);
  return {document, window, view, calls, $, $$, byDataId};
}

/** Opens a list in the tree and loads one page of items into it. */
function load(t, scope, items, {parentKey = null, total = items.length} = {}) {
  tree.openList(t, scope, parentKey);
  tree.addPage(t, tree.scopeKey(scope), fx.page(items, {total}));
}

/** A tree with the default namespace open and the deployment opened down to its pod. */
function rolloutTree() {
  const t = tree.createTree();
  load(t, NS, [fx.gateway(), fx.route(), fx.service(), fx.deployment(), fx.configMap()]);
  load(t, {type: 'parent', uid: fx.UID.deployment}, [fx.replicaSet()], {parentKey: 'ns:default'});
  load(t, {type: 'parent', uid: fx.UID.replicaSet}, [fx.pod()], {parentKey: 'parent:dep-1'});
  return t;
}

const canvas = (t, overrides = {}) => ({overview: fx.overview(), tree: t, selection: null, ...overrides});
const texts = (elements) => elements.map((e) => e.textContent);
const childrenMatching = (element, selector) => [...element.children].filter((c) => c.matches(selector));

// --- Areas -------------------------------------------------------------------

test('the cluster box is titled with the cluster name', () => {
  const {view, $} = mount();

  view.renderCanvas(canvas(tree.createTree()));

  assert.equal($('#cluster-title').textContent, 'cluster: kind-kvleva');
});

test('the cluster box holds Nodes, Cluster-wide and one area per namespace, in that order', () => {
  const {view, $$} = mount();

  view.renderCanvas(canvas(tree.createTree()));

  assert.deepEqual($$('#areas > .area').map((a) => a.dataset.id), ['nodes', 'cluster', 'ns:default', 'ns:shop']);
  assert.deepEqual(texts($$('#areas > .area .area-title')),
      ['Nodes', 'Cluster-wide', 'namespace: default', 'namespace: shop']);
});

test('every area header shows its resource count and green / yellow / red rollup', () => {
  const {view, byDataId} = mount();

  view.renderCanvas(canvas(tree.createTree()));

  const summary = (id) => {
    const head = byDataId(id).querySelector('.area-head');
    return [head.querySelector('.count').textContent, ...texts([...head.querySelectorAll('.rollup-item .rollup-count')])];
  };
  assert.deepEqual(summary('nodes'), ['3', '3', '0', '0']);
  assert.deepEqual(summary('cluster'), ['180', '180', '0', '0']);
  assert.deepEqual(summary('ns:default'), ['42', '40', '2', '0']);
  assert.deepEqual(summary('ns:shop'), ['7', '5', '1', '1']);
  const classes = [...byDataId('ns:shop').querySelectorAll('.area-head .rollup-item')].map((i) => i.className);
  assert.deepEqual(classes, ['rollup-item health-green', 'rollup-item health-yellow', 'rollup-item health-red']);
});

test('an area is outlined in the worst color of its rollup', () => {
  const {view, byDataId} = mount();
  const overview = fx.overview({nodes: {count: 3, rollup: fx.rollup(3, 0, 0)}});

  view.renderCanvas(canvas(tree.createTree(), {overview}));

  const health = (id) => [...byDataId(id).classList].filter((c) => c.startsWith('health-'));
  assert.deepEqual(health('nodes'), ['health-green'], 'all green');
  assert.deepEqual(health('ns:default'), ['health-yellow'], '40 green, 2 yellow');
  assert.deepEqual(health('ns:shop'), ['health-red'], '5 green, 1 yellow, 1 red');
});

test('a closed area renders nothing but its header', () => {
  const {view, byDataId, $$} = mount();

  view.renderCanvas(canvas(tree.createTree()));

  const area = byDataId('ns:default');
  assert.deepEqual([...area.children].map((c) => c.className), ['area-head']);
  assert.equal(area.querySelector('.toggle').getAttribute('aria-expanded'), 'false');
  assert.equal($$('.widget').length, 0);
});

test('an open area that is still loading says so', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  tree.openList(t, NS);

  view.renderCanvas(canvas(t));

  const area = byDataId('ns:default');
  assert.equal(area.querySelector('.toggle').getAttribute('aria-expanded'), 'true');
  assert.ok(area.classList.contains('open'));
  assert.equal(area.querySelector('.list .note').textContent, 'Loading…');
});

test('an open area whose load failed shows the error', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  tree.openList(t, NS);
  tree.setError(t, 'ns:default', 'request failed with status 500');

  view.renderCanvas(canvas(t));

  const note = byDataId('ns:default').querySelector('.list .note.error');
  assert.match(note.textContent, /request failed with status 500/);
});

test('an open area without matching resources says that nothing matches', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, []);

  view.renderCanvas(canvas(t));

  assert.equal(byDataId('ns:default').querySelector('.list .note').textContent, 'Nothing to show.');
});

// --- Lanes and widgets -------------------------------------------------------

test('consecutive resources of one kind share a labelled lane', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  const second = fx.summary({uid: 'cm-2', name: 'other'});
  load(t, NS, [fx.gateway(), fx.route(), fx.service(), fx.deployment(), fx.configMap(), second]);

  view.renderCanvas(canvas(t));

  const laneEls = childrenMatching(byDataId('ns:default').querySelector('.list'), '.lane');
  const got = laneEls.map((lane) => [
    lane.querySelector('.lane-label').textContent,
    childrenMatching(lane.querySelector('.lane-items'), '.widget').map((w) => w.dataset.id),
  ]);
  assert.deepEqual(got, [
    ['Gateway', ['gw-1']],
    ['HTTPRoute', ['route-1']],
    ['Service', ['svc-1']],
    ['Deployment', ['dep-1']],
    ['ConfigMap', ['cm-1', 'cm-2']],
  ]);
});

test('a widget shows the kind, the name and the reason of its resource', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [fx.deployment()]);

  view.renderCanvas(canvas(t));

  const widget = byDataId('dep-1');
  assert.equal(widget.querySelector('.kind').textContent, 'Deployment');
  assert.equal(widget.querySelector('.name').textContent, 'web');
  assert.equal(widget.querySelector('.reason').textContent, 'Progressing');
  assert.equal(widget.getAttribute('title'), 'Progressing', 'the reason is the tooltip');
});

for (const [health, glyph, name] of [
  ['green', '●', 'Healthy'], ['yellow', '▲', 'In-Progress'], ['red', '■', 'Failed'],
]) {
  test(`a resource that is ${name} is outlined in ${health} and marked with a matching dot`, () => {
    const {view, byDataId} = mount();
    const t = tree.createTree();
    load(t, NS, [fx.summary({uid: 'r1', health, reason: 'Because'})]);

    view.renderCanvas(canvas(t));

    const widget = byDataId('r1');
    assert.deepEqual([...widget.classList].filter((c) => c.startsWith('health-')), [`health-${health}`]);
    assert.equal(widget.querySelector('.widget-head .dot').textContent, glyph);
    assert.match(widget.getAttribute('aria-label'), new RegExp(`, ${name}: Because$`),
        'the health is also available as text, by its name');
    assert.doesNotMatch(widget.getAttribute('aria-label'), new RegExp(health));
  });
}

test('the counts of a closed box are named Healthy, In-Progress and Failed for assistive technology', () => {
  const {view, byDataId} = mount();

  view.renderCanvas(canvas(tree.createTree()));

  assert.equal(byDataId('ns:default').querySelector('.rollup').getAttribute('aria-label'),
      '40 Healthy, 2 In-Progress, 0 Failed');
});

test('the header of a namespace box names the health of the namespace in words', () => {
  const {view, byDataId} = mount();

  view.renderCanvas(canvas(tree.createTree()));

  const title = (id) => byDataId(id).querySelector('.area-title').getAttribute('aria-label');
  assert.equal(title('ns:default'), 'Namespace default, Healthy: Active');
  assert.equal(title('ns:shop'), 'Namespace shop, In-Progress: Terminating');
});

test('a resource whose health is not known is called Unknown', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [fx.summary({uid: 'r1', kind: 'ConfigMap', name: 'odd', health: 'purple', reason: ''})]);

  view.renderCanvas(canvas(t));

  assert.match(byDataId('r1').getAttribute('aria-label'), /, Unknown$/);
});

test('an unknown health value never becomes a class name', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [fx.summary({uid: 'r1', health: 'red selected dimmed'})]);

  view.renderCanvas(canvas(t));

  assert.deepEqual([...byDataId('r1').classList], ['widget']);
});

test('a resource kept only because a descendant matched is dimmed', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [{...fx.deployment(), selfMatch: false}, fx.configMap()]);

  view.renderCanvas(canvas(t));

  assert.ok(byDataId('dep-1').classList.contains('dimmed'));
  assert.ok(!byDataId('cm-1').classList.contains('dimmed'));
});

test('a collapsed resource with children has a toggle and shows its rollup', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [fx.deployment(), fx.configMap()]);

  view.renderCanvas(canvas(t));

  const deployment = byDataId('dep-1');
  assert.equal(deployment.querySelector('.toggle').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(texts([...deployment.querySelectorAll('.widget-head .rollup-count')]), ['1', '2', '0']);
  assert.equal(deployment.querySelector('.children'), null, 'children are not rendered until opened');
  assert.equal(byDataId('cm-1').querySelector('.toggle'), null, 'nothing to open in a config map');
  assert.equal(byDataId('cm-1').querySelector('.rollup'), null);
});

test('an opened rollout nests the pod in the replica set in the deployment', () => {
  const {view, byDataId} = mount();

  view.renderCanvas(canvas(rolloutTree()));

  const deployment = byDataId('dep-1');
  const replicaSet = byDataId('rs-1');
  const pod = byDataId('pod-1');
  assert.equal(deployment.parentElement.closest('.widget'), null, 'the deployment is at the top level');
  assert.equal(replicaSet.parentElement.closest('.widget'), deployment);
  assert.equal(pod.parentElement.closest('.widget'), replicaSet);
  assert.equal(deployment.querySelector('.toggle').getAttribute('aria-expanded'), 'true');
  assert.ok(deployment.classList.contains('open'));
  assert.equal(childrenMatching(deployment.querySelector('.widget-head'), '.rollup').length, 0,
      'the rollup is only shown while collapsed');
  assert.equal(replicaSet.closest('.lane').querySelector('.lane-label').textContent, 'ReplicaSet',
      'children are grouped into lanes too');
});

test('closing a resource removes the DOM of its children', () => {
  const {view, byDataId, $$} = mount();
  const t = rolloutTree();
  view.renderCanvas(canvas(t));
  assert.equal($$('.widget').length, 7);

  tree.closeList(t, 'parent:dep-1');
  view.renderCanvas(canvas(t));

  assert.equal($$('.widget').length, 5);
  assert.equal(byDataId('rs-1'), undefined);
  assert.equal(byDataId('pod-1'), undefined);
  assert.equal(byDataId('dep-1').querySelector('.children'), null);
});

test('a pod always shows its containers inside itself, each in its own health color', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [fx.pod()]);

  view.renderCanvas(canvas(t));

  const containers = [...byDataId('pod-1').querySelectorAll('.containers > .container')];
  assert.deepEqual(containers.map((c) => c.dataset.container), ['migrate', 'app']);
  assert.deepEqual(containers.map((c) => c.querySelector('.container-name').textContent), ['migrate', 'app']);
  assert.deepEqual(containers.map((c) => [...c.classList].filter((n) => n.startsWith('health-'))),
      [['health-green'], ['health-yellow']]);
  assert.deepEqual(containers.map((c) => c.querySelector('.dot').textContent), ['●', '▲']);
  assert.deepEqual(containers.map((c) => c.getAttribute('title')), ['Completed', 'ContainerCreating']);
});

test('init containers are marked', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [fx.pod()]);

  view.renderCanvas(canvas(t));

  const [init, app] = byDataId('pod-1').querySelectorAll('.container');
  assert.ok(init.classList.contains('init'));
  assert.equal(init.querySelector('.tag').textContent, 'init');
  assert.ok(!app.classList.contains('init'));
  assert.equal(app.querySelector('.tag'), null);
});

test('a node can be opened to list the pods scheduled on it with their containers', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, {type: 'nodes'}, [fx.node()]);

  view.renderCanvas(canvas(t));
  const closed = byDataId('node-1');
  assert.equal(closed.querySelector('.toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(closed.querySelector('.widget'), null);

  load(t, {type: 'node', name: 'kvleva-control-plane'}, [fx.pod()], {parentKey: 'nodes'});
  view.renderCanvas(canvas(t));

  const pod = byDataId('node-1').querySelector('.children .widget');
  assert.equal(pod.dataset.id, 'pod-1');
  assert.equal(pod.querySelectorAll('.container').length, 2);
  assert.equal(pod.querySelector('.toggle'), null, 'the pod list of a node is flat');
});

// --- Pagination and scale ----------------------------------------------------

test('a partially loaded list offers to show more, with the number remaining', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  const items = Array.from({length: 100}, (_, i) => fx.summary({uid: `cm-${i}`, name: `cm-${i}`}));
  load(t, NS, items, {total: 250});

  view.renderCanvas(canvas(t));

  const area = byDataId('ns:default');
  assert.equal(area.querySelectorAll('.widget').length, 100);
  assert.equal(area.querySelector('.more').textContent, 'Show more (150 remaining)');
});

test('a fully loaded list has no Show more button', () => {
  const {view, $} = mount();

  view.renderCanvas(canvas(rolloutTree()));

  assert.equal($('.more'), null);
});

test('the children of a resource are paginated as well', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [{...fx.deployment(), childCount: 130}]);
  const pods = Array.from({length: 100}, (_, i) => ({...fx.pod(), uid: `p-${i}`, name: `p-${i}`}));
  load(t, {type: 'parent', uid: 'dep-1'}, pods, {parentKey: 'ns:default', total: 130});

  view.renderCanvas(canvas(t));

  assert.equal(byDataId('dep-1').querySelector('.children .more').textContent, 'Show more (30 remaining)');
});

test('only what is open is in the DOM', () => {
  const {view, $$} = mount();
  const t = tree.createTree();
  load(t, {type: 'nodes'}, [fx.node()]);
  const overview = fx.overview({health: fx.rollup(50000, 0, 0)});

  view.renderCanvas(canvas(t, {overview}));

  assert.deepEqual($$('.widget').map((w) => w.dataset.id), ['node-1']);
});

// --- Interaction -------------------------------------------------------------

test('the toggle of an area asks to open or close that area', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  byDataId('ns:shop').querySelector('.area-head .toggle').click();
  byDataId('cluster').querySelector('.area-head .toggle').click();
  byDataId('nodes').querySelector('.area-head .toggle').click();

  assert.deepEqual(calls, [
    ['onToggle', {type: 'namespace', name: 'shop'}, null],
    ['onToggle', {type: 'cluster'}, null],
    ['onToggle', {type: 'nodes'}, null],
  ]);
});

test('the toggle of a resource asks for its children, inside the list it is shown in', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  byDataId('dep-1').querySelector('.toggle').click();
  byDataId('rs-1').querySelector('.toggle').click();

  assert.deepEqual(calls, [
    ['onToggle', {type: 'parent', uid: 'dep-1'}, 'ns:default'],
    ['onToggle', {type: 'parent', uid: 'rs-1'}, 'parent:dep-1'],
  ], 'toggling never selects');
});

test('the toggle of a node asks for the pods on that node', () => {
  const {view, byDataId, calls} = mount();
  const t = tree.createTree();
  load(t, {type: 'nodes'}, [fx.node()]);
  view.renderCanvas(canvas(t));

  byDataId('node-1').querySelector('.toggle').click();

  assert.deepEqual(calls, [['onToggle', {type: 'node', name: 'kvleva-control-plane'}, 'nodes']]);
});

test('clicking a widget selects its resource', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  byDataId('svc-1').querySelector('.name').click();

  assert.deepEqual(calls, [['onSelect', {uid: 'svc-1'}]]);
});

test('clicking a nested widget selects only the innermost resource', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  byDataId('pod-1').querySelector('.kind').click();

  assert.deepEqual(calls, [['onSelect', {uid: 'pod-1'}]]);
});

test('clicking a container selects that container of its pod', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  byDataId('pod-1').querySelectorAll('.container')[1].querySelector('.container-name').click();

  assert.deepEqual(calls, [['onSelect', {uid: 'pod-1', container: 'app'}]]);
});

test('clicking a namespace header selects the Namespace object', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(tree.createTree()));

  const title = byDataId('ns:shop').querySelector('.area-title');
  title.click();

  assert.deepEqual(calls, [['onSelect', {uid: fx.UID.nsShop}]]);
  assert.equal(title.getAttribute('title'), 'Terminating', 'the namespace reason is the tooltip');
  assert.equal(byDataId('ns:shop').querySelector('.area-head .dot').textContent, '▲',
      'the Namespace object shows its own health');
});

test('the headers of the Nodes and Cluster-wide areas select nothing', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(tree.createTree()));

  byDataId('nodes').querySelector('.area-title').click();
  byDataId('cluster').querySelector('.area-title').click();

  assert.deepEqual(calls, []);
});

test('Show more asks for the next page of its list', () => {
  const {view, byDataId, calls} = mount();
  const t = tree.createTree();
  load(t, NS, [{...fx.deployment(), childCount: 130}], {total: 300});
  load(t, {type: 'parent', uid: 'dep-1'}, [fx.replicaSet()], {parentKey: 'ns:default', total: 130});
  view.renderCanvas(canvas(t));

  byDataId('dep-1').querySelector('.children .more').click();
  const areaMore = [...byDataId('ns:default').querySelectorAll('.more')].at(-1);
  areaMore.click();

  assert.deepEqual(calls, [['onShowMore', 'parent:dep-1'], ['onShowMore', 'ns:default']]);
});

test('Expand all and Collapse all are reported', () => {
  const {view, $, calls} = mount();
  view.renderCanvas(canvas(tree.createTree()));

  $('#expand-all').click();
  $('#collapse-all').click();

  assert.deepEqual(calls, [['onExpandAll'], ['onCollapseAll']]);
});

test('widgets, containers and namespace headers are reachable with the keyboard', () => {
  const {view, byDataId} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  assert.equal(byDataId('svc-1').getAttribute('tabindex'), '0');
  assert.equal(byDataId('pod-1').querySelector('.container').getAttribute('tabindex'), '0');
  assert.equal(byDataId('ns:default').querySelector('.area-title').getAttribute('tabindex'), '0');
  assert.equal(byDataId('nodes').querySelector('.area-title').hasAttribute('tabindex'), false);
});

test('Enter and Space select the focused widget', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  const enter = fire(byDataId('svc-1'), 'keydown', {key: 'Enter'});
  const space = fire(byDataId('cm-1'), 'keydown', {key: ' '});
  fire(byDataId('cm-1'), 'keydown', {key: 'a'});

  assert.deepEqual(calls, [['onSelect', {uid: 'svc-1'}], ['onSelect', {uid: 'cm-1'}]]);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(space.defaultPrevented, true, 'Space must not scroll the canvas');
});

test('Enter selects the focused container or namespace header', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  fire(byDataId('pod-1').querySelector('.container'), 'keydown', {key: 'Enter'});
  fire(byDataId('ns:default').querySelector('.area-title'), 'keydown', {key: 'Enter'});

  assert.deepEqual(calls, [
    ['onSelect', {uid: 'pod-1', container: 'migrate'}],
    ['onSelect', {uid: fx.UID.nsDefault}],
  ]);
});

test('Enter on a toggle or Show more button is left to the button', () => {
  const {view, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  const event = fire(byDataId('dep-1').querySelector('.toggle'), 'keydown', {key: 'Enter'});

  assert.deepEqual(calls, [], 'the browser turns Enter on a button into a click');
  assert.equal(event.defaultPrevented, false);
});

test('Escape closes the drawer from anywhere', () => {
  const {view, document, byDataId, calls} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  fire(byDataId('svc-1'), 'keydown', {key: 'Escape'});
  fire(document.body, 'keydown', {key: 'Escape'});

  assert.deepEqual(calls, [['onCloseDrawer'], ['onCloseDrawer']]);
});

// --- Selection and hover -----------------------------------------------------

const selectedIds = ($$) => $$('.selected').map((e) => e.dataset.id ?? e.dataset.container ?? e.textContent);

test('the selected resource is highlighted', () => {
  const {view, $$} = mount();

  view.renderCanvas(canvas(rolloutTree(), {selection: {uid: 'pod-1'}}));

  assert.deepEqual(selectedIds($$), ['pod-1']);
});

test('a selected container is highlighted instead of its pod', () => {
  const {view, $$} = mount();

  view.renderCanvas(canvas(rolloutTree(), {selection: {uid: 'pod-1', container: 'app'}}));

  assert.deepEqual(selectedIds($$), ['app']);
});

test('a selected Namespace object highlights its namespace header', () => {
  const {view, $$} = mount();

  view.renderCanvas(canvas(rolloutTree(), {selection: {uid: fx.UID.nsShop}}));

  assert.deepEqual(selectedIds($$), ['namespace: shop']);
});

test('the highlight follows a changed selection without rendering the canvas again', () => {
  const {view, $$, byDataId} = mount();
  view.renderCanvas(canvas(rolloutTree(), {selection: {uid: 'pod-1'}}));
  const before = byDataId('svc-1');

  view.setSelection({uid: 'svc-1'});
  assert.deepEqual(selectedIds($$), ['svc-1']);
  assert.equal(byDataId('svc-1'), before, 'the widget is the same element');

  view.setSelection(null);
  assert.deepEqual(selectedIds($$), []);
});

test('a pod shown both in its namespace and under its node is highlighted in both places', () => {
  const {view, $$} = mount();
  const t = rolloutTree();
  load(t, {type: 'nodes'}, [fx.node()]);
  load(t, {type: 'node', name: 'kvleva-control-plane'}, [fx.pod()], {parentKey: 'nodes'});

  view.renderCanvas(canvas(t, {selection: {uid: 'pod-1'}}));

  assert.deepEqual(selectedIds($$), ['pod-1', 'pod-1']);
});

// --- Live refresh: what a re-render must preserve ----------------------------

const focusedDescription = (document) => {
  const active = document.activeElement;
  return [active.className.split(' ')[0], active.dataset.id ?? active.dataset.toggle ?? active.dataset.container];
};

test('a refresh keeps the keyboard focus on the same widget', () => {
  const {view, document, byDataId} = mount();
  view.renderCanvas(canvas(rolloutTree()));
  byDataId('pod-1').focus();
  const before = byDataId('pod-1');

  view.renderCanvas(canvas(rolloutTree()));

  assert.notEqual(byDataId('pod-1'), before, 'this test needs the widget to be rebuilt');
  assert.deepEqual(focusedDescription(document), ['widget', 'pod-1']);
  assert.ok(document.activeElement.isConnected);
});

test('a refresh keeps the keyboard focus on a toggle, a container or a namespace header', () => {
  const {view, document, byDataId} = mount();
  view.renderCanvas(canvas(rolloutTree()));

  byDataId('dep-1').querySelector('.toggle').focus();
  view.renderCanvas(canvas(rolloutTree()));
  assert.deepEqual(focusedDescription(document), ['toggle', 'parent:dep-1']);

  byDataId('pod-1').querySelectorAll('.container')[1].focus();
  view.renderCanvas(canvas(rolloutTree()));
  assert.deepEqual(focusedDescription(document), ['container', 'app']);

  byDataId('ns:shop').querySelector('.area-title').focus();
  view.renderCanvas(canvas(rolloutTree()));
  assert.equal(document.activeElement.textContent, 'namespace: shop');
});

test('a pod shown twice keeps the focus on the instance that had it', () => {
  const {view, document, byDataId} = mount();
  const build = () => {
    const t = rolloutTree();
    load(t, {type: 'nodes'}, [fx.node()]);
    load(t, {type: 'node', name: 'kvleva-control-plane'}, [fx.pod()], {parentKey: 'nodes'});
    return t;
  };
  view.renderCanvas(canvas(build()));
  byDataId('node-1').querySelector('.widget').focus();

  view.renderCanvas(canvas(build()));

  assert.deepEqual(focusedDescription(document), ['widget', 'pod-1']);
  assert.equal(document.activeElement.parentElement.closest('.widget').dataset.id, 'node-1');
});

test('when the focused widget is gone after a refresh the focus is not moved elsewhere', () => {
  const {view, document, byDataId} = mount();
  const t = rolloutTree();
  view.renderCanvas(canvas(t));
  byDataId('pod-1').focus();

  tree.closeList(t, 'parent:rs-1');
  view.renderCanvas(canvas(t));

  assert.equal(document.activeElement, document.body);
});

test('returning the focus does not scroll the canvas', () => {
  const {view, window, byDataId} = mount();
  view.renderCanvas(canvas(rolloutTree()));
  byDataId('pod-1').focus();
  const focusOptions = [];
  const realFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function(options) {
    focusOptions.push(options);
    return realFocus.call(this, options);
  };

  view.renderCanvas(canvas(rolloutTree()));

  assert.deepEqual(focusOptions, [{preventScroll: true}]);
});

test('a refresh restores the scroll position of the canvas', () => {
  const {view, $} = mount();
  view.renderCanvas(canvas(rolloutTree()));
  const scroller = $('#canvas');
  const areas = $('#areas');
  scroller.scrollTop = 420;
  scroller.scrollLeft = 30;
  // jsdom has no layout and would keep any scroll offset. Emulate the worst a
  // browser can do while content is swapped: lose the offset entirely.
  const realReplace = areas.replaceChildren.bind(areas);
  areas.replaceChildren = (...nodes) => {
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    realReplace(...nodes);
  };

  view.renderCanvas(canvas(rolloutTree()));

  assert.equal(scroller.scrollTop, 420);
  assert.equal(scroller.scrollLeft, 30);
});

test('a refresh rebuilds the areas inside the same scroll container', () => {
  const {view, $} = mount();
  view.renderCanvas(canvas(rolloutTree()));
  const [scroller, content, areas] = [$('#canvas'), $('#canvas-content'), $('#areas')];

  view.renderCanvas(canvas(rolloutTree()));

  assert.equal($('#canvas'), scroller);
  assert.equal($('#canvas-content'), content);
  assert.equal($('#areas'), areas);
  assert.ok(scroller.isConnected && areas.isConnected);
});

// --- Health cues that must not leak between nested boxes ---------------------

test('every health dot carries its own health, whatever box it sits in', () => {
  const {view, byDataId} = mount();

  // shop: the Namespace object is yellow while the area rollup is red.
  view.renderCanvas(canvas(rolloutTree()));

  const shop = byDataId('ns:shop');
  assert.ok(shop.classList.contains('health-red'));
  const namespaceDot = shop.querySelector('.area-head > .dot');
  assert.equal(namespaceDot.textContent, '▲');
  assert.ok(namespaceDot.classList.contains('health-yellow'), 'not the red of the surrounding area');

  const podDot = byDataId('pod-1').querySelector('.widget-head > .dot');
  assert.ok(podDot.classList.contains('health-yellow'));
  const containerDots = [...byDataId('pod-1').querySelectorAll('.container > .dot')];
  assert.deepEqual(containerDots.map((d) => d.className), ['dot health-green', 'dot health-yellow']);
});

test('a dot for an unknown health is a question mark without a health class', () => {
  const {view, byDataId} = mount();
  const t = tree.createTree();
  load(t, NS, [fx.summary({uid: 'r1', health: 'purple'})]);

  view.renderCanvas(canvas(t));

  const unknown = byDataId('r1').querySelector('.widget-head > .dot');
  assert.equal(unknown.textContent, '?');
  assert.equal(unknown.className, 'dot');
});

test('widgets are labelled groups for assistive technology', () => {
  const {view, byDataId} = mount();

  view.renderCanvas(canvas(rolloutTree()));

  assert.equal(byDataId('dep-1').getAttribute('role'), 'group');
  assert.equal(byDataId('dep-1').getAttribute('aria-label'), 'Deployment web, In-Progress: Progressing');
  assert.equal(byDataId('pod-1').querySelector('.container').getAttribute('role'), 'button');
  assert.equal(byDataId('pod-1').querySelector('.container').getAttribute('aria-label'),
      'Init container migrate, Healthy: Completed');
});
