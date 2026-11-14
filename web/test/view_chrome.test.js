import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import * as filters from '../static/js/filters.js';
import * as fx from './fixtures.js';
import {assertNoPageErrors, loadShell, recorder, type} from './helpers.js';

afterEach(assertNoPageErrors);

function mount() {
  const {document, window} = loadShell();
  const {handlers, calls} = recorder();
  const view = viewModule.createView(document, handlers);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  return {document, window, view, calls, $, $$};
}

const header = (overrides = {}) => ({
  overview: fx.overview(), filters: filters.defaultFilters(), stream: 'open', ...overrides,
});

const sidebar = (overrides = {}) => ({
  overview: fx.overview(), filters: filters.defaultFilters(), arrowsCapped: false, ...overrides,
});

// --- Header ------------------------------------------------------------------

test('the header shows the cluster name and server version', () => {
  const {view, $} = mount();

  view.renderHeader(header());

  assert.equal($('#cluster-name').textContent, 'kind-kvleva');
  assert.equal($('#cluster-version').textContent, 'v1.35.0');
});

test('the header says synced once every kind is loaded', () => {
  const {view, $} = mount();

  view.renderHeader(header());

  assert.match($('#sync').textContent, /synced/);
  assert.ok($('#sync').classList.contains('ok'));
  assert.equal($('#sync').getAttribute('title'), '61 of 61 resource types synced');
});

test('the header shows sync progress while kinds are still loading', () => {
  const {view, $} = mount();
  const overview = fx.overview({sync: {ready: false, kindsTotal: 61, kindsSynced: 12, errors: []}});

  view.renderHeader(header({overview}));

  assert.match($('#sync').textContent, /syncing 12\/61/);
  assert.ok($('#sync').classList.contains('pending'));
  assert.ok(!$('#sync').classList.contains('ok'));
});

test('the header warns about kinds that failed to sync, with their messages', () => {
  const {view, $, $$} = mount();
  const overview = fx.overview({sync: {ready: true, kindsTotal: 61, kindsSynced: 59, errors: [
    {kindId: 'example.io/Widget', message: 'forbidden'},
    {kindId: 'example.io/Gadget', message: 'the server could not find the requested resource'},
  ]}});

  view.renderHeader(header({overview}));

  assert.match($('#sync .sync-errors summary').textContent, /2/);
  assert.deepEqual($$('#sync .sync-errors li').map((li) => li.textContent), [
    'example.io/Widget: forbidden',
    'example.io/Gadget: the server could not find the requested resource',
  ]);

  view.renderHeader(header());
  assert.equal($('#sync .sync-errors'), null, 'the warning goes away with the errors');
});

test('the header says reconnecting while the stream is down', () => {
  const {view, $} = mount();

  view.renderHeader(header({stream: 'reconnecting'}));
  assert.equal($('#stream').textContent, 'reconnecting…');

  view.renderHeader(header({stream: 'open'}));
  assert.equal($('#stream').textContent, '');
});

test('three health pills show the cluster totals', () => {
  const {view, $$} = mount();

  view.renderHeader(header());

  const pills = $$('#pills .pill');
  assert.deepEqual(pills.map((p) => p.dataset.health), ['green', 'yellow', 'red']);
  assert.deepEqual(pills.map((p) => p.querySelector('.pill-count').textContent), ['310', '4', '1']);
  for (const pill of pills) {
    assert.ok(pill.classList.contains(`health-${pill.dataset.health}`));
    assert.match(pill.getAttribute('aria-label'), new RegExp(pill.dataset.health));
  }
});

test('pills reflect the health filter and toggle it when clicked', () => {
  const {view, $$, calls} = mount();
  const noRed = filters.toggleHealth(filters.defaultFilters(), 'red');

  view.renderHeader(header({filters: noRed}));

  assert.deepEqual($$('#pills .pill').map((p) => p.getAttribute('aria-pressed')), ['true', 'true', 'false']);

  $$('#pills .pill')[2].click();
  assert.deepEqual(calls, [['onHealthToggle', 'red']]);
});

test('typing in the search box reports the text', () => {
  const {view, $, calls} = mount();
  view.renderHeader(header());

  type($('#search'), 'CHECK');

  assert.deepEqual(calls, [['onSearch', 'CHECK']]);
});

test('the search box shows the saved search text', () => {
  const {view, $} = mount();

  view.renderHeader(header({filters: filters.setQuery(filters.defaultFilters(), 'web')}));

  assert.equal($('#search').value, 'web');
});

test('a refresh does not overwrite what the user is typing in the search box', () => {
  const {view, $} = mount();
  view.renderHeader(header());
  $('#search').focus();
  $('#search').value = 'half-typed';

  view.renderHeader(header({filters: filters.setQuery(filters.defaultFilters(), 'half')}));

  assert.equal($('#search').value, 'half-typed');
});

// --- Sidebar -----------------------------------------------------------------

test('the health checkboxes reflect the filter and toggle it', () => {
  const {view, $$, calls} = mount();
  const noGreen = filters.toggleHealth(filters.defaultFilters(), 'green');

  view.renderSidebar(sidebar({filters: noGreen}));

  const boxes = $$('#health-filter input');
  assert.deepEqual(boxes.map((b) => [b.dataset.health, b.checked]),
      [['green', false], ['yellow', true], ['red', true]]);

  boxes[1].click();
  assert.deepEqual(calls, [['onHealthToggle', 'yellow']]);
});

test('the connection mode reflects the filter and reports a change', () => {
  const {view, $$, calls} = mount();

  view.renderSidebar(sidebar({filters: filters.setConnections(filters.defaultFilters(), 'selected')}));

  const radios = $$('#connections-filter input');
  assert.deepEqual(radios.map((r) => [r.value, r.checked]), [['all', false], ['selected', true], ['off', false]]);

  radios[2].click();
  assert.deepEqual(calls, [['onConnections', 'off']]);
});

test('a note next to the connection modes says when too many arrows forced selected-only', () => {
  const {view, $} = mount();

  view.renderSidebar(sidebar({arrowsCapped: true}));
  assert.equal($('#connections-note').hidden, false);
  assert.match($('#connections-note').textContent, /more than 300/i);
  assert.match($('#connections-note').textContent, /selected/i);

  view.renderSidebar(sidebar({arrowsCapped: false}));
  assert.equal($('#connections-note').hidden, true);
});

test('resource types are listed in overview order with kind, group and count', () => {
  const {view, $$} = mount();

  view.renderSidebar(sidebar());

  const rows = $$('#kind-list li').map((li) => [
    li.querySelector('.kind-name').textContent,
    li.querySelector('.kind-group').textContent,
    li.querySelector('.count').textContent,
  ]);
  assert.deepEqual(rows, [
    ['Gateway', 'gateway.networking.k8s.io', '1'],
    ['Service', 'core', '9'],
    ['Deployment', 'apps', '12'],
    ['ReplicaSet', 'apps', '14'],
    ['Pod', 'core', '42'],
    ['Secret', 'core', '12'],
  ]);
  assert.ok($$('#kind-list li').every((li) => li.querySelector('label input[type="checkbox"]')),
      'every type has a labelled checkbox');
});

test('hidden resource types are unchecked', () => {
  const {view, $$} = mount();
  const hidden = filters.setKindHidden(filters.defaultFilters(), 'core/Secret', true);

  view.renderSidebar(sidebar({filters: hidden}));

  const state = Object.fromEntries($$('#kind-list input').map((i) => [i.dataset.kindId, i.checked]));
  assert.equal(state['core/Secret'], false);
  assert.equal(state['core/Pod'], true);
});

test('unchecking a resource type hides it, checking shows it again', () => {
  const {view, $$, calls} = mount();
  view.renderSidebar(sidebar({filters: filters.setKindHidden(filters.defaultFilters(), 'core/Secret', true)}));
  const box = (kindId) => $$('#kind-list input').find((i) => i.dataset.kindId === kindId);

  box('core/Pod').click();
  box('core/Secret').click();

  assert.deepEqual(calls, [['onKindHidden', 'core/Pod', true], ['onKindHidden', 'core/Secret', false]]);
});

test('All and None flip every resource type', () => {
  const {view, $, calls} = mount();
  view.renderSidebar(sidebar());

  $('#kinds-none').click();
  $('#kinds-all').click();

  assert.deepEqual(calls, [['onAllKindsHidden', true], ['onAllKindsHidden', false]]);
});

test('the text box narrows the resource type list', () => {
  const {view, $, $$} = mount();
  view.renderSidebar(sidebar());
  const kinds = () => $$('#kind-list .kind-name').map((e) => e.textContent);

  type($('#kind-search'), 'apps');
  assert.deepEqual(kinds(), ['Deployment', 'ReplicaSet']);

  view.renderSidebar(sidebar());
  assert.deepEqual(kinds(), ['Deployment', 'ReplicaSet'], 'a refresh keeps the narrowing');

  type($('#kind-search'), '');
  assert.equal(kinds().length, 6);
});

test('a refresh keeps the focus on the resource type checkbox being used', () => {
  const {view, document, $$} = mount();
  view.renderSidebar(sidebar());
  $$('#kind-list input').find((i) => i.dataset.kindId === 'core/Secret').focus();

  view.renderSidebar(sidebar({overview: fx.overview({revision: 2000})}));

  assert.equal(document.activeElement.dataset.kindId, 'core/Secret');
  assert.ok(document.activeElement.isConnected);
});

// --- Application error -------------------------------------------------------

test('an application error is announced and can be cleared', () => {
  const {view, $} = mount();

  view.renderError('Cannot reach kvleva: backend unavailable');
  assert.equal($('#app-error').hidden, false);
  assert.equal($('#app-error').textContent, 'Cannot reach kvleva: backend unavailable');
  assert.equal($('#app-error').getAttribute('role'), 'alert');

  view.renderError(null);
  assert.equal($('#app-error').hidden, true);
  assert.equal($('#app-error').textContent, '');
});
