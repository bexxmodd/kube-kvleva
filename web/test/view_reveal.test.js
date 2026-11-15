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

// --- What is on the page -----------------------------------------------------

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

// --- No arrows ---------------------------------------------------------------

test('the canvas draws no reference arrows and does not react to hovering', () => {
  const {view, calls, $$, byDataId} = mount();
  view.renderCanvas(canvas(openTree()));

  fire(byDataId('svc-1'), 'mouseover');
  fire(byDataId('pod-1'), 'mouseover');

  assert.equal($$('svg, path').length, 0, 'references are listed in the details, not drawn');
  assert.deepEqual(calls, [], 'hovering used to emphasize arrows; now it does nothing');
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

test('revealing a pod shown in its namespace and under its node goes to the namespace instance', () => {
  const {view, window} = mount();
  const scrolledInto = [];
  window.Element.prototype.scrollIntoView = function() {
    scrolledInto.push(this.parentElement.closest('.widget')?.dataset.id);
  };
  const t = openTree();
  load(t, {type: 'nodes'}, [fx.node()]);
  load(t, {type: 'node', name: 'kvleva-control-plane'}, [fx.pod()], {parentKey: 'nodes'});
  view.renderCanvas(canvas(t));

  view.reveal('pod-1');

  assert.deepEqual(scrolledInto, ['rs-1'], 'the instance inside its replica set, not the one under the node');
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
