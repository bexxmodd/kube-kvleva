import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import * as edges from '../static/js/edges.js';
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
  const byDataId = (id) => $$('[data-id]').find((e) => e.dataset.id === id);
  return {document, window, view, calls, $, $$, byDataId};
}

function load(t, scope, items, {parentKey = null} = {}) {
  tree.openList(t, scope, parentKey);
  tree.addPage(t, tree.scopeKey(scope), fx.page(items));
}

/** default namespace open; the deployment is collapsed. */
function collapsedTree() {
  const t = tree.createTree();
  load(t, NS, [fx.gateway(), fx.route(), fx.service(), fx.deployment(), fx.configMap()]);
  return t;
}

/** default namespace open with the rollout opened down to the pod. */
function openTree() {
  const t = collapsedTree();
  load(t, {type: 'parent', uid: 'dep-1'}, [fx.replicaSet()], {parentKey: 'ns:default'});
  load(t, {type: 'parent', uid: 'rs-1'}, [fx.pod()], {parentKey: 'parent:dep-1'});
  return t;
}

const canvas = (t) => ({overview: fx.overview(), tree: t, selection: null});

/** Gives an element a layout rectangle, which jsdom cannot compute. */
function place(element, left, top, width = 100, height = 40) {
  element.getBoundingClientRect = () =>
      ({left, top, width, height, right: left + width, bottom: top + height, x: left, y: top});
}

const drawn = ($$) => $$('#arrow-paths > path').map((p) => ({
  from: p.dataset.from, to: p.dataset.to, d: p.getAttribute('d'),
  emphasized: p.classList.contains('emphasized'), marker: p.getAttribute('marker-end'),
}));

// --- What the arrow logic may ask the view -----------------------------------

test('rendered widgets and every area box count as rendered, folded resources do not', () => {
  const {view} = mount();
  view.renderCanvas(canvas(collapsedTree()));

  assert.equal(view.hasElement('svc-1'), true);
  assert.equal(view.hasElement('dep-1'), true);
  assert.equal(view.hasElement('rs-1'), false, 'inside the collapsed deployment');
  assert.equal(view.hasElement('pod-1'), false);
  for (const area of ['nodes', 'cluster', 'ns:default', 'ns:shop']) {
    assert.equal(view.hasElement(area), true, `${area} has a box even while closed`);
  }
  assert.equal(view.hasElement('ns:unknown'), false);
});

test('what is rendered follows the canvas', () => {
  const {view} = mount();
  view.renderCanvas(canvas(openTree()));
  assert.equal(view.hasElement('pod-1'), true);

  view.renderCanvas(canvas(collapsedTree()));
  assert.equal(view.hasElement('pod-1'), false);
});

test('containment follows the nesting of the rendered boxes', () => {
  const {view} = mount();
  view.renderCanvas(canvas(openTree()));

  assert.equal(view.contains('ns:default', 'svc-1'), true);
  assert.equal(view.contains('dep-1', 'pod-1'), true);
  assert.equal(view.contains('pod-1', 'dep-1'), false);
  assert.equal(view.contains('svc-1', 'dep-1'), false);
  assert.equal(view.contains('dep-1', 'dep-1'), false, 'an element does not contain itself');
  assert.equal(view.contains('ns:shop', 'svc-1'), false);
  assert.equal(view.contains('ns:default', 'not-rendered'), false);
});

test('a pod shown in its namespace and under its node is represented by the namespace instance', () => {
  const {view} = mount();
  const t = openTree();
  load(t, {type: 'nodes'}, [fx.node()]);
  load(t, {type: 'node', name: 'kvleva-control-plane'}, [fx.pod()], {parentKey: 'nodes'});
  view.renderCanvas(canvas(t));

  assert.equal(view.contains('node-1', 'pod-1'), false, 'so the pod -> node arrow can be drawn');
  assert.equal(view.contains('rs-1', 'pod-1'), true);
});

test('a pod shown only under its node is contained in that node', () => {
  const {view} = mount();
  const t = tree.createTree();
  load(t, {type: 'nodes'}, [fx.node()]);
  load(t, {type: 'node', name: 'kvleva-control-plane'}, [fx.pod()], {parentKey: 'nodes'});
  view.renderCanvas(canvas(t));

  assert.equal(view.contains('node-1', 'pod-1'), true, 'so the pod -> node arrow is dropped');
});

// --- Drawing -----------------------------------------------------------------

test('an arrow is a curve from the border of its source to the border of its target', () => {
  const {view, $, $$, byDataId} = mount();
  view.renderCanvas(canvas(collapsedTree()));
  place($('#arrows'), 260, 50, 900, 2000);
  place(byDataId('route-1'), 300, 100);
  place(byDataId('gw-1'), 600, 220);

  view.drawArrows([{from: 'route-1', to: 'gw-1', relations: ['parentRefs'], emphasized: false}]);

  // In layer coordinates the route is at (40, 50) and the gateway at (340, 170).
  const expected = edges.curve({x: 40, y: 50, width: 100, height: 40}, {x: 340, y: 170, width: 100, height: 40});
  assert.equal(expected, 'M140 70 C240 70 240 190 340 190');
  assert.deepEqual(drawn($$), [
    {from: 'route-1', to: 'gw-1', d: expected, emphasized: false, marker: 'url(#arrowhead)'},
  ]);
  const path = $('#arrow-paths > path');
  assert.equal(path.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.ok(path.classList.contains('arrow'));
});

test('emphasized arrows get their own style and arrowhead and are drawn on top', () => {
  const {view, $, $$, byDataId} = mount();
  view.renderCanvas(canvas(collapsedTree()));
  place($('#arrows'), 0, 0);
  place(byDataId('route-1'), 0, 0);
  place(byDataId('gw-1'), 300, 0);
  place(byDataId('svc-1'), 300, 100);

  view.drawArrows([
    {from: 'route-1', to: 'gw-1', relations: [], emphasized: true},
    {from: 'route-1', to: 'svc-1', relations: [], emphasized: false},
  ]);

  assert.deepEqual(drawn($$).map((a) => [a.to, a.emphasized, a.marker]), [
    ['svc-1', false, 'url(#arrowhead)'],
    ['gw-1', true, 'url(#arrowhead-emphasized)'],
  ]);
});

test('an arrow can end at an area box', () => {
  const {view, $, $$, byDataId} = mount();
  view.renderCanvas(canvas(collapsedTree()));
  place($('#arrows'), 0, 0);
  place(byDataId('gw-1'), 0, 300);
  place(byDataId('cluster'), 0, 100, 800, 30);

  view.drawArrows([{from: 'gw-1', to: 'cluster', relations: [], emphasized: false}]);

  assert.equal(drawn($$)[0].d, edges.curve({x: 0, y: 300, width: 100, height: 40}, {x: 0, y: 100, width: 800, height: 30}));
});

test('drawing again replaces the previous arrows', () => {
  const {view, $, $$, byDataId} = mount();
  view.renderCanvas(canvas(collapsedTree()));
  place($('#arrows'), 0, 0);
  place(byDataId('route-1'), 0, 0);
  place(byDataId('gw-1'), 300, 0);
  view.drawArrows([{from: 'route-1', to: 'gw-1', relations: [], emphasized: false}]);

  view.drawArrows([{from: 'gw-1', to: 'route-1', relations: [], emphasized: false}]);
  assert.deepEqual(drawn($$).map((a) => [a.from, a.to]), [['gw-1', 'route-1']]);

  view.drawArrows([]);
  assert.equal($$('#arrow-paths > path').length, 0);
  assert.ok($('#arrowhead'), 'the arrowhead definitions are kept');
});

test('an arrow whose end is no longer rendered is skipped', () => {
  const {view, $$} = mount();
  view.renderCanvas(canvas(collapsedTree()));

  view.drawArrows([{from: 'route-1', to: 'vanished', relations: [], emphasized: false}]);

  assert.equal($$('#arrow-paths > path').length, 0);
});

// --- Revealing ---------------------------------------------------------------

test('revealing a resource scrolls its widget into view and flashes it', () => {
  const {view, window, byDataId} = mount();
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function(options) {
    scrolled.push([this.dataset.id, options]);
  };
  view.renderCanvas(canvas(openTree()));

  const found = view.reveal('pod-1');

  assert.equal(found, true);
  assert.deepEqual(scrolled, [['pod-1', {block: 'center', inline: 'nearest'}]]);
  assert.ok(byDataId('pod-1').classList.contains('flash'));

  fire(byDataId('pod-1'), 'animationend');
  assert.ok(!byDataId('pod-1').classList.contains('flash'), 'the flash ends with its animation');
});

test('revealing another resource moves the flash', () => {
  const {view, window, byDataId, $$} = mount();
  window.Element.prototype.scrollIntoView = () => {};
  view.renderCanvas(canvas(openTree()));

  view.reveal('pod-1');
  view.reveal('svc-1');

  assert.deepEqual($$('.flash').map((e) => e.dataset.id), ['svc-1']);
  assert.ok(!byDataId('pod-1').classList.contains('flash'));
});

test('revealing something that is not rendered reports failure', () => {
  const {view, window, $$} = mount();
  window.Element.prototype.scrollIntoView = () => {};
  view.renderCanvas(canvas(collapsedTree()));

  assert.equal(view.reveal('pod-1'), false);
  assert.equal($$('.flash').length, 0);
});

test('revealing works where scrollIntoView is unavailable', () => {
  const {view, byDataId} = mount();
  view.renderCanvas(canvas(collapsedTree()));

  assert.equal(view.reveal('svc-1'), true);
  assert.ok(byDataId('svc-1').classList.contains('flash'));
});
