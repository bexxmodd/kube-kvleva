import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import * as filters from '../static/js/filters.js';
import * as fx from './fixtures.js';
import {assertNoPageErrors, loadShell, recorder, type} from './helpers.js';

afterEach(assertNoPageErrors);

/** The API groups of the fixture overview, in the order they are listed. */
const GROUP_NAMES = ['core', 'apps', 'gateway.networking.k8s.io'];

/**
 * @param {{expandGroups?: boolean}=} options API groups start collapsed; tests
 *     about the resource types listed under them expand all of them first.
 */
function mount({expandGroups = false} = {}) {
  const {document, window} = loadShell();
  const {handlers, calls} = recorder();
  const view = viewModule.createView(document, handlers);
  if (expandGroups) view.setExpandedGroups(GROUP_NAMES);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  return {document, window, view, calls, $, $$};
}

const header = (overrides = {}) => ({
  overview: fx.overview(), filters: filters.defaultFilters(), stream: 'open', ...overrides,
});

const sidebar = (overrides = {}) => ({
  overview: fx.overview(), filters: filters.defaultFilters(), ...overrides,
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

test('the system resources switch is off by default and says how many are hidden', () => {
  const {view, $} = mount();

  view.renderHeader(header());

  assert.equal($('#system-toggle').checked, false);
  assert.equal($('#system-count').textContent, '287 hidden');
});

test('the system resources switch reflects the filter when on', () => {
  const {view, $} = mount();

  view.renderHeader(header({filters: filters.setSystem(filters.defaultFilters(), true)}));

  assert.equal($('#system-toggle').checked, true);
  assert.equal($('#system-count').textContent, '287 shown');
});

test('the system resources switch says nothing about a cluster without system resources', () => {
  const {view, $} = mount();

  view.renderHeader(header({overview: fx.overview({systemResources: 0})}));

  assert.equal($('#system-count').textContent, '');
});

test('flipping the system resources switch reports the new state', () => {
  const {view, $, calls} = mount();
  view.renderHeader(header());

  $('#system-toggle').click();
  $('#system-toggle').click();

  assert.deepEqual(calls, [['onSystemToggle', true], ['onSystemToggle', false]]);
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

/** The resource type list as [group, total, [[kind, count], ...]] entries. */
const kindGroups = ($$) => $$('#kind-list > .kind-group').map((group) => [
  group.querySelector('.kind-group-name').textContent,
  group.querySelector('.kind-group-head .count').textContent,
  [...group.querySelectorAll('.kind-row')].map((row) => [
    row.querySelector('.kind-name').textContent,
    row.querySelector('.count').textContent,
  ]),
]);

const groupBox = ($$, group) => $$('#kind-list input').find((i) => i.dataset.group === group);

test('resource types are grouped by API group, core first, each with its count', () => {
  const {view, $$} = mount({expandGroups: true});

  view.renderSidebar(sidebar());

  assert.deepEqual(kindGroups($$), [
    ['core', '63', [['Service', '9'], ['Pod', '42'], ['Secret', '12']]],
    ['apps', '26', [['Deployment', '12'], ['ReplicaSet', '14']]],
    ['gateway.networking.k8s.io', '1', [['Gateway', '1']]],
  ]);
  assert.ok($$('#kind-list .kind-row').every((row) => row.querySelector('label input[type="checkbox"]')),
      'every type has a labelled checkbox');
  assert.ok($$('#kind-list .kind-group').every((g) => g.querySelector('label.kind-group-head input[type="checkbox"]')),
      'and so has every group');
  assert.equal($$('#kind-list .kind-row').some((row) => row.textContent.includes('apps')), false,
      'the group is named once, in the heading, not on every type');
});

test('the checkbox of a group shows whether its types are all shown, all hidden, or mixed', () => {
  const {view, $$} = mount();
  let f = filters.setKindHidden(filters.defaultFilters(), 'core/Secret', true);
  f = filters.setKindsHidden(f, ['apps/Deployment', 'apps/ReplicaSet'], true);

  view.renderSidebar(sidebar({filters: f}));

  const state = (group) => [groupBox($$, group).checked, groupBox($$, group).indeterminate];
  assert.deepEqual(state('core'), [false, true], 'one of three hidden: mixed');
  assert.deepEqual(state('apps'), [false, false], 'all hidden');
  assert.deepEqual(state('gateway.networking.k8s.io'), [true, false], 'all shown');
});

test('the checkbox of a group hides or shows all of its types at once', () => {
  const {view, $$, calls} = mount();
  view.renderSidebar(sidebar({filters: filters.setKindHidden(filters.defaultFilters(), 'core/Secret', true)}));

  groupBox($$, 'apps').click();
  groupBox($$, 'core').click();

  assert.deepEqual(calls, [
    ['onKindsHidden', ['apps/Deployment', 'apps/ReplicaSet'], true],
    ['onKindsHidden', ['core/Service', 'core/Pod', 'core/Secret'], false],
  ], 'a mixed group is shown completely');
});

test('narrowing the list keeps only groups with matching types, and a group then acts on what it shows', () => {
  const {view, $, $$, calls} = mount();
  view.renderSidebar(sidebar());

  type($('#kind-search'), 'se');

  assert.deepEqual(kindGroups($$), [
    ['core', '21', [['Service', '9'], ['Secret', '12']]],
    ['apps', '14', [['ReplicaSet', '14']]],
  ]);

  groupBox($$, 'core').click();
  assert.deepEqual(calls, [['onKindsHidden', ['core/Service', 'core/Secret'], true]]);
});

test('a refresh keeps the focus on the group checkbox being used', () => {
  const {view, document, $$} = mount();
  view.renderSidebar(sidebar());
  groupBox($$, 'apps').focus();

  view.renderSidebar(sidebar({overview: fx.overview({revision: 2000})}));

  assert.equal(document.activeElement.dataset.group, 'apps');
  assert.ok(document.activeElement.isConnected);
});

/** The button that expands or collapses the types listed under a group. */
const groupToggle = ($$, group) => $$('#kind-list button').find((b) => b.dataset.groupToggle === group);

const ALL_GROUPS = [
  ['core', '63', [['Service', '9'], ['Pod', '42'], ['Secret', '12']]],
  ['apps', '26', [['Deployment', '12'], ['ReplicaSet', '14']]],
  ['gateway.networking.k8s.io', '1', [['Gateway', '1']]],
];

/** ALL_GROUPS with only the types of the named groups listed. */
const expandedOnly = (...expanded) =>
    ALL_GROUPS.map(([group, count, kinds]) => [group, count, expanded.includes(group) ? kinds : []]);

test('every API group starts collapsed, with a button to expand it next to its checkbox', () => {
  const {view, $$} = mount();

  view.renderSidebar(sidebar());

  assert.deepEqual(kindGroups($$), expandedOnly(), 'only the headings, with name and count');
  for (const group of GROUP_NAMES) {
    const toggle = groupToggle($$, group);
    assert.ok(toggle, `${group} has a button`);
    assert.equal(toggle.getAttribute('type'), 'button');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-label'), `Expand the resource types of ${group}`);
    assert.equal(toggle.closest('label'), null, 'outside the label, so using it never ticks the checkbox');
    assert.equal(toggle.closest('.kind-group').dataset.group, group);
  }
});

test('expanding an API group lists the types under it', () => {
  const {view, $$, calls} = mount();
  view.renderSidebar(sidebar());

  groupToggle($$, 'apps').click();

  assert.deepEqual(kindGroups($$), expandedOnly('apps'), 'the other groups stay collapsed');
  const toggle = groupToggle($$, 'apps');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse the resource types of apps');
  assert.notEqual(toggle.textContent, groupToggle($$, 'core').textContent, 'the button shows which way it is');
  assert.deepEqual(calls, [['onGroupsExpanded', ['apps']]], 'reported to be remembered; no filter is touched');
});

test('collapsing an expanded API group hides its types again', () => {
  const {view, $$, calls} = mount();
  view.renderSidebar(sidebar());
  groupToggle($$, 'apps').click();
  groupToggle($$, 'core').click();

  groupToggle($$, 'apps').click();

  assert.deepEqual(kindGroups($$), expandedOnly('core'));
  assert.equal(groupToggle($$, 'apps').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(calls, [
    ['onGroupsExpanded', ['apps']], ['onGroupsExpanded', ['apps', 'core']], ['onGroupsExpanded', ['core']],
  ]);
});

test('remembered expanded groups can be given before or after the list is shown', () => {
  const {view, $$, calls} = mount();

  view.setExpandedGroups(['apps', 'no.longer.installed']);
  view.renderSidebar(sidebar());
  assert.deepEqual(kindGroups($$), expandedOnly('apps'));

  view.setExpandedGroups(['core']);
  assert.deepEqual(kindGroups($$), expandedOnly('core'));
  assert.deepEqual(calls, [], 'restoring is not reported back');
});

test('a refresh keeps groups as they are, and the checkbox of a collapsed group acts on all of its types', () => {
  const {view, $$, calls} = mount();
  view.setExpandedGroups(['core']);
  view.renderSidebar(sidebar({filters: filters.setKindHidden(filters.defaultFilters(), 'apps/ReplicaSet', true)}));

  view.renderSidebar(sidebar({
    overview: fx.overview({revision: 2000}),
    filters: filters.setKindHidden(filters.defaultFilters(), 'apps/ReplicaSet', true),
  }));

  assert.deepEqual(kindGroups($$), expandedOnly('core'));
  assert.equal(groupBox($$, 'apps').indeterminate, true, 'the heading still tells that only some are hidden');
  groupBox($$, 'apps').click();
  assert.deepEqual(calls, [['onKindsHidden', ['apps/Deployment', 'apps/ReplicaSet'], false]]);
});

test('narrowing the list shows the matching types of collapsed groups until the text is cleared', () => {
  const {view, $, $$, calls} = mount();
  view.renderSidebar(sidebar());

  type($('#kind-search'), 'deploy');

  assert.deepEqual(kindGroups($$), [['apps', '12', [['Deployment', '12']]]]);
  assert.equal(groupToggle($$, 'apps').getAttribute('aria-expanded'), 'true');
  assert.equal(groupToggle($$, 'apps').disabled, true, 'while narrowing, everything that matches is listed');

  type($('#kind-search'), '');

  assert.deepEqual(kindGroups($$), expandedOnly(), 'the group is collapsed again');
  assert.equal(groupToggle($$, 'apps').disabled, false);
  assert.deepEqual(calls, [], 'narrowing does not change what is remembered');
});

test('using the button of a group keeps the keyboard focus on it', () => {
  const {view, document, $$} = mount();
  view.renderSidebar(sidebar());
  groupToggle($$, 'apps').focus();

  groupToggle($$, 'apps').click();

  assert.equal(document.activeElement, groupToggle($$, 'apps'));
  assert.ok(document.activeElement.isConnected);
});

test('a group whose name is not a plain word can be expanded like any other', () => {
  const {view, $$} = mount();
  const group = 'a"] [b=\'c\'] > *';
  const kinds = [{kindId: `${group}/Widget`, group, version: 'v1', kind: 'Widget', namespaced: true, count: 3,
                  rollup: fx.rollup(3, 0, 0)}];
  view.renderSidebar(sidebar({overview: fx.overview({kinds})}));
  assert.deepEqual(kindGroups($$), [[group, '3', []]]);

  groupToggle($$, group).click();

  assert.deepEqual(kindGroups($$), [[group, '3', [['Widget', '3']]]]);
});

test('hidden resource types are unchecked', () => {
  const {view, $$} = mount({expandGroups: true});
  const hidden = filters.setKindHidden(filters.defaultFilters(), 'core/Secret', true);

  view.renderSidebar(sidebar({filters: hidden}));

  const state = Object.fromEntries($$('#kind-list input').map((i) => [i.dataset.kindId, i.checked]));
  assert.equal(state['core/Secret'], false);
  assert.equal(state['core/Pod'], true);
});

test('unchecking a resource type hides it, checking shows it again', () => {
  const {view, $$, calls} = mount({expandGroups: true});
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
  const {view, $, $$} = mount({expandGroups: true});
  view.renderSidebar(sidebar());
  const kinds = () => $$('#kind-list .kind-name').map((e) => e.textContent);

  type($('#kind-search'), 'apps');
  assert.deepEqual(kinds(), ['Deployment', 'ReplicaSet']);

  view.renderSidebar(sidebar());
  assert.deepEqual(kinds(), ['Deployment', 'ReplicaSet'], 'a refresh keeps the narrowing');

  type($('#kind-search'), '');
  assert.deepEqual(kinds(), ['Service', 'Pod', 'Secret', 'Deployment', 'ReplicaSet', 'Gateway']);
});

test('a refresh keeps the focus on the resource type checkbox being used', () => {
  const {view, document, $$} = mount({expandGroups: true});
  view.renderSidebar(sidebar());
  $$('#kind-list input').find((i) => i.dataset.kindId === 'core/Secret').focus();

  view.renderSidebar(sidebar({overview: fx.overview({revision: 2000})}));

  assert.equal(document.activeElement.dataset.kindId, 'core/Secret');
  assert.ok(document.activeElement.isConnected);
});

// --- Theme ---------------------------------------------------------------------

test('the page starts in the night theme and the theme button offers the day theme', () => {
  const {document, $} = mount();

  assert.notEqual(document.documentElement.dataset.theme, 'day');
  assert.match($('#theme-toggle').textContent, /day/i);
  assert.equal($('#theme-toggle').getAttribute('aria-label'), 'Switch to the day theme');
});

test('setting a theme marks the page with it and turns the button into the way back', () => {
  const {document, view, $, calls} = mount();

  view.setTheme('day');
  assert.equal(document.documentElement.dataset.theme, 'day');
  assert.match($('#theme-toggle').textContent, /night/i);
  assert.doesNotMatch($('#theme-toggle').textContent, /day/i);
  assert.equal($('#theme-toggle').getAttribute('aria-label'), 'Switch to the night theme');
  assert.equal($('#theme-toggle').title, 'Switch to the night theme');

  view.setTheme('night');
  assert.equal(document.documentElement.dataset.theme, 'night');
  assert.match($('#theme-toggle').textContent, /day/i);
  assert.equal($('#theme-toggle').getAttribute('aria-label'), 'Switch to the day theme');
  assert.deepEqual(calls, [], 'restoring a theme is not reported back');
});

test('the theme button switches the theme and reports the choice', () => {
  const {document, $, calls} = mount();

  $('#theme-toggle').click();
  assert.equal(document.documentElement.dataset.theme, 'day');

  $('#theme-toggle').click();
  assert.equal(document.documentElement.dataset.theme, 'night');
  assert.deepEqual(calls, [['onTheme', 'day'], ['onTheme', 'night']]);
});

test('the theme button follows a day theme that was applied before the app started', () => {
  const {document} = loadShell();
  // What js/theme-boot.js does for a remembered day theme.
  document.documentElement.dataset.theme = 'day';
  const {handlers, calls} = recorder();
  viewModule.createView(document, handlers);

  document.getElementById('theme-toggle').click();

  assert.equal(document.documentElement.dataset.theme, 'night');
  assert.deepEqual(calls, [['onTheme', 'night']]);
});

test('a theme the app does not know is shown as night', () => {
  const {document, view, $} = mount();

  view.setTheme('pink"><img src=x>');

  assert.equal(document.documentElement.dataset.theme, 'night');
  assert.match($('#theme-toggle').textContent, /day/i);
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
