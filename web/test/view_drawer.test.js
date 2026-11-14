import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import * as fx from './fixtures.js';
import {assertNoPageErrors, flush, loadShell, recorder} from './helpers.js';

afterEach(assertNoPageErrors);

function mount(results = {}) {
  const {document, window} = loadShell();
  const {handlers, calls} = recorder(results);
  const view = viewModule.createView(document, handlers);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  return {document, window, view, calls, $, $$};
}

const ready = (detail = fx.detail(), selection = {uid: detail.summary.uid}) => ({state: 'ready', selection, detail});
const readyContainer = (detail = fx.containerDetail()) =>
    ({state: 'ready', selection: {uid: detail.pod.uid, container: detail.container.name}, detail});
const texts = (elements) => elements.map((e) => e.textContent);
const rows = (table) => [...table.querySelectorAll('tbody tr')].map((tr) => texts([...tr.cells]));
const headers = (table) => texts([...table.querySelectorAll('thead th')]);

// --- Opening and closing -----------------------------------------------------

test('the drawer is closed until something is selected', () => {
  const {view, $} = mount();

  view.renderDrawer({state: 'closed'});
  assert.equal($('#drawer').hidden, true);

  view.renderDrawer(ready());
  assert.equal($('#drawer').hidden, false);

  view.renderDrawer({state: 'closed'});
  assert.equal($('#drawer').hidden, true);
  assert.equal($('#drawer-body').childNodes.length, 0, 'a closed drawer keeps no content');
});

test('the close button asks to close the drawer', () => {
  const {view, $, calls} = mount();
  view.renderDrawer(ready());

  $('#drawer-close').click();

  assert.deepEqual(calls, [['onCloseDrawer']]);
});

test('the drawer says when details are loading', () => {
  const {view, $} = mount();

  view.renderDrawer({state: 'loading', selection: {uid: 'dep-1'}});

  assert.equal($('#drawer').hidden, false);
  assert.equal($('#drawer-body').textContent, 'Loading…');
});

test('a deleted resource shows that it no longer exists', () => {
  const {view, $} = mount();

  view.renderDrawer({state: 'gone', selection: {uid: 'dep-1'}});

  assert.equal($('#drawer').hidden, false);
  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
});

test('a failed load shows the error', () => {
  const {view, $} = mount();

  view.renderDrawer({state: 'error', selection: {uid: 'dep-1'}, message: 'request failed with status 500'});

  assert.match($('#drawer-body').textContent, /request failed with status 500/);
  assert.ok($('#drawer-body .note.error'));
});

// --- Resource details --------------------------------------------------------

test('the drawer header shows kind, namespace/name, the health badge and the reason', () => {
  const {view, $} = mount();

  view.renderDrawer(ready());

  assert.equal($('.drawer-head .drawer-kind').textContent, 'Deployment');
  assert.equal($('.drawer-head .drawer-name').textContent, 'default/web');
  assert.equal($('.drawer-head .badge').textContent, '▲ yellow');
  assert.ok($('.drawer-head').classList.contains('health-yellow'));
  assert.equal($('.drawer-head .drawer-reason').textContent, 'Progressing');
});

test('a cluster-scoped resource is named without a namespace', () => {
  const {view, $} = mount();

  view.renderDrawer(ready(fx.detail({summary: fx.node()})));

  assert.equal($('.drawer-head .drawer-name').textContent, 'kvleva-control-plane');
  assert.equal($('.drawer-head .badge').textContent, '● green');
});

test('sections come in the order Configuration, Status, Events, Connections', () => {
  const {view, $$} = mount();

  view.renderDrawer(ready());

  assert.deepEqual(texts($$('#drawer-body .section-title')), ['Configuration', 'Status', 'Events', 'Connections']);
  assert.deepEqual($$('#drawer-body > *').map((e) => e.className.split(' ').at(-1)),
      ['health-yellow', 'configuration', 'status', 'events', 'connections'],
      'the header comes first and the status after the configuration');
});

test('the configuration is the YAML, character for character', () => {
  const {view, $} = mount();
  const detail = fx.detail();

  view.renderDrawer(ready(detail));

  assert.equal($('.configuration .yaml').textContent + '\n', detail.yaml);
  assert.equal($('.configuration .yaml').localName, 'pre');
});

test('the YAML is lightly colored: keys, strings, numbers and comments', () => {
  const {view, $$} = mount();
  const detail = fx.detail({yaml: '# managed\nname: "web"\nreplicas: 3\nimage: nginx\n'});

  view.renderDrawer(ready(detail));

  const colored = $$('.configuration .yaml span').map((s) => [s.className, s.textContent]);
  assert.deepEqual(colored, [
    ['tok-comment', '# managed'],
    ['tok-key', 'name'], ['tok-punct', ':'], ['tok-string', '"web"'],
    ['tok-key', 'replicas'], ['tok-punct', ':'], ['tok-number', '3'],
    ['tok-key', 'image'], ['tok-punct', ':'],
  ]);
});

test('Copy hands the exact YAML to the clipboard handler and confirms', async () => {
  const {view, $, calls} = mount({onCopy: Promise.resolve(true)});
  const detail = fx.detail();
  view.renderDrawer(ready(detail));
  const button = $('.configuration .copy');
  assert.equal(button.textContent, 'Copy');

  button.click();
  await flush();

  assert.deepEqual(calls, [['onCopy', detail.yaml]]);
  assert.equal(button.textContent, 'Copied');
});

test('Copy says so when the clipboard is not available', async () => {
  const {view, $} = mount({onCopy: Promise.resolve(false)});
  view.renderDrawer(ready());

  $('.configuration .copy').click();
  await flush();

  assert.equal($('.configuration .copy').textContent, 'Copy failed');
});

test('the status lists conditions in the delivered order, then the status YAML', () => {
  const {view, $} = mount();
  const detail = fx.detail();

  view.renderDrawer(ready(detail));

  const table = $('.status table');
  assert.deepEqual(headers(table), ['Type', 'Status', 'Reason', 'Message', 'Last transition', 'Source']);
  assert.deepEqual(rows(table), [
    ['Progressing', 'True', 'ReplicaSetUpdated', 'rolling out', '2026-11-14T17:00:05Z', ''],
    ['Available', 'True', 'MinimumReplicasAvailable', '', '2026-11-14T16:00:00Z', ''],
  ]);
  const yaml = $('.status .yaml');
  assert.equal(yaml.textContent + '\n', detail.statusYaml);
  assert.ok(table.compareDocumentPosition(yaml) & 4, 'the status YAML follows the conditions');
});

test('conditions reported per parent name their source', () => {
  const {view, $} = mount();
  const detail = fx.detail({conditions: [
    {type: 'Accepted', status: 'False', reason: 'NotAllowedByListeners', message: 'no',
     lastTransitionTime: '2026-11-14T17:00:05Z', source: 'parents[0]'},
  ]});

  view.renderDrawer(ready(detail));

  assert.deepEqual(rows($('.status table'))[0].at(-1), 'parents[0]');
});

test('a resource without conditions and status says so', () => {
  const {view, $} = mount();

  view.renderDrawer(ready(fx.detail({conditions: [], statusYaml: ''})));

  assert.equal($('.status table'), null);
  assert.equal($('.status .yaml'), null);
  assert.equal($('.status .note').textContent, 'No status.');
});

test('events are listed with type, reason, message, count, time and source; warnings are marked', () => {
  const {view, $, $$} = mount();

  view.renderDrawer(ready());

  const table = $('.events table');
  assert.deepEqual(headers(table), ['Type', 'Reason', 'Message', 'Count', 'Last seen', 'Source']);
  assert.deepEqual(rows(table), [
    ['Warning', 'BackOff', 'Back-off restarting failed container', '7', '2026-11-14T17:05:00Z', 'kubelet'],
    ['Normal', 'ScalingReplicaSet', 'Scaled up replica set web-7d4b9c to 3', '1', '2026-11-14T16:59:00Z',
     'deployment-controller'],
  ]);
  assert.deepEqual($$('.events tbody tr').map((tr) => tr.classList.contains('warning')), [true, false]);
});

test('no events is stated explicitly', () => {
  const {view, $} = mount();

  view.renderDrawer(ready(fx.detail({events: []})));

  assert.equal($('.events table'), null);
  assert.equal($('.events .note').textContent, 'No events');
});

test('details still show when events could not be loaded, with a note', () => {
  const {view, $, $$} = mount();

  view.renderDrawer(ready(fx.detail({events: [], eventsError: 'events is forbidden'})));

  assert.match($('.events .note.error').textContent, /events is forbidden/);
  assert.equal(texts($$('.events .note')).includes('No events'), false, 'unknown is not the same as none');
  assert.ok($('.configuration .yaml'), 'the rest of the details is still there');
});

test('connections list owners, outgoing, incoming and missing references', () => {
  const {view, $$} = mount();
  const detail = fx.detail({
    owners: [fx.link({uid: 'own-1', kindId: 'example.io/App', kind: 'App', name: 'shop', relation: undefined})],
  });

  view.renderDrawer(ready(detail));

  const groups = $$('.connections .link-group').map((g) => [
    g.querySelector('.subsection-title').textContent,
    [...g.querySelectorAll('li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  ]);
  assert.deepEqual(groups, [
    ['Owned by', ['● App default/shop']],
    ['Refers to', ['● ConfigMap default/web-config volumes']],
    ['Referred to by', ['● Service default/web selector']],
    ['Missing references', ['⚠ Secret default/does-not-exist envFrom']],
  ]);
});

test('resolved connections are links that reveal the resource', () => {
  const {view, $$, calls} = mount();
  const detail = fx.detail();
  view.renderDrawer(ready(detail));

  const links = $$('.connections button.link');
  assert.deepEqual(texts(links), ['ConfigMap default/web-config', 'Service default/web']);
  links[1].click();

  assert.deepEqual(calls, [['onReveal', detail.incoming[0]]]);
});

test('missing references are flagged and are not links', () => {
  const {view, $} = mount();

  view.renderDrawer(ready());

  const missing = $('.connections .link-group.missing');
  assert.equal(missing.querySelector('.subsection-title').textContent, 'Missing references');
  assert.equal(missing.querySelector('button'), null);
  assert.equal(missing.querySelector('.missing-name').textContent, 'Secret default/does-not-exist');
});

test('empty connection groups are left out and no connections is stated', () => {
  const {view, $, $$} = mount();

  view.renderDrawer(ready(fx.detail({outgoing: [], missing: []})));
  assert.deepEqual(texts($$('.connections .subsection-title')), ['Referred to by']);

  view.renderDrawer(ready(fx.detail({outgoing: [], incoming: [], missing: []})));
  assert.equal($('.connections .note').textContent, 'No connections.');
});

// --- Container details -------------------------------------------------------

test('a selected container shows its header, configuration, status and events', () => {
  const {view, $, $$} = mount();
  const detail = fx.containerDetail();

  view.renderDrawer(readyContainer(detail));

  assert.equal($('.drawer-head .drawer-kind').textContent, 'Container');
  assert.equal($('.drawer-head .drawer-name').textContent, 'app');
  assert.equal($('.drawer-head .badge').textContent, '▲ yellow');
  assert.equal($('.drawer-head .drawer-reason').textContent, 'ContainerCreating');
  assert.deepEqual(texts($$('#drawer-body .section-title')), ['Configuration', 'Status', 'Events']);
  assert.equal($('.configuration .yaml').textContent + '\n', detail.yaml);
  assert.equal($('.status .yaml').textContent + '\n', detail.statusYaml);
  assert.deepEqual(rows($('.events table')).map((r) => r[1]), ['Pulling']);
});

test('the container header shows image, state, readiness and restarts', () => {
  const {view, $$} = mount();

  view.renderDrawer(readyContainer());

  const facts = Object.fromEntries($$('.drawer-head .facts dt').map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
  assert.deepEqual(facts, {Image: 'nginx:1.27', State: 'waiting', Ready: 'no', Restarts: '0'});
});

test('an init container is labelled as such', () => {
  const {view, $} = mount();
  const detail = fx.containerDetail();
  detail.container = detail.pod.containers[0];

  view.renderDrawer(readyContainer(detail));

  assert.equal($('.drawer-head .drawer-kind').textContent, 'Init container');
});

test('the container drawer links back to its pod', () => {
  const {view, $, calls} = mount();
  const detail = fx.containerDetail();
  view.renderDrawer(readyContainer(detail));

  const back = $('.drawer-head button.link');
  assert.equal(back.textContent, 'Pod default/web-7d4b9c-abcde');
  back.click();

  assert.deepEqual(calls, [['onReveal', detail.pod]]);
});

// --- Live refresh ------------------------------------------------------------

/** Emulates a browser that loses the scroll offset while content is swapped. */
function loseScrollOnReplace(scroller, body) {
  const realReplace = body.replaceChildren.bind(body);
  body.replaceChildren = (...nodes) => {
    scroller.scrollTop = 0;
    realReplace(...nodes);
  };
}

test('refreshing the details of the same resource keeps the drawer scroll position', () => {
  const {view, $} = mount();
  view.renderDrawer(ready());
  $('#drawer').scrollTop = 300;
  loseScrollOnReplace($('#drawer'), $('#drawer-body'));

  view.renderDrawer(ready(fx.detail({statusYaml: 'replicas: 3\nreadyReplicas: 3\n'})));

  assert.equal($('#drawer').scrollTop, 300);
});

test('selecting another resource starts the drawer at the top', () => {
  const {view, $} = mount();
  view.renderDrawer(ready());
  $('#drawer').scrollTop = 300;

  view.renderDrawer(ready(fx.detail({summary: fx.configMap()})));

  assert.equal($('#drawer').scrollTop, 0);
});

test('switching from a pod to one of its containers starts the drawer at the top', () => {
  const {view, $} = mount();
  view.renderDrawer(ready(fx.detail({summary: fx.pod()})));
  $('#drawer').scrollTop = 300;

  view.renderDrawer(readyContainer());

  assert.equal($('#drawer').scrollTop, 0);
});

test('refreshing the details keeps the focus inside the drawer', () => {
  const {view, document, $, $$} = mount();
  view.renderDrawer(ready());
  $$('.connections button.link')[1].focus();

  view.renderDrawer(ready());

  assert.equal(document.activeElement.textContent, 'Service default/web');
  assert.ok(document.activeElement.isConnected);
});
