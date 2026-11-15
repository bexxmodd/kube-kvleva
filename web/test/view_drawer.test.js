import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import * as fx from './fixtures.js';
import {assertNoPageErrors, fire, flush, loadShell, recorder, type} from './helpers.js';

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
  assert.equal($('.drawer-head .badge').textContent, '▲ In-Progress');
  assert.ok($('.drawer-head').classList.contains('health-yellow'));
  assert.equal($('.drawer-head .drawer-reason').textContent, 'Progressing');
});

test('a cluster-scoped resource is named without a namespace', () => {
  const {view, $} = mount();

  view.renderDrawer(ready(fx.detail({summary: fx.node()})));

  assert.equal($('.drawer-head .drawer-name').textContent, 'kvleva-control-plane');
  assert.equal($('.drawer-head .badge').textContent, '● Healthy');
});

test('the health badge names a failed resource Failed and an unjudged one Unknown', () => {
  const {view, $} = mount();

  view.renderDrawer(ready(fx.detail({summary: fx.summary({health: 'red', reason: 'CrashLoopBackOff'})})));
  assert.equal($('.drawer-head .badge').textContent, '■ Failed');

  view.renderDrawer(ready(fx.detail({summary: fx.summary({health: 'purple', reason: ''})})));
  assert.equal($('.drawer-head .badge').textContent, '? Unknown');
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
  assert.equal($('.drawer-head .badge').textContent, '▲ In-Progress');
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

// --- Live logs: the button ---------------------------------------------------

const logsButton = ($) => $('#drawer-body .drawer-head button.view-logs');
const visible = (element) => element !== null && element.closest('[hidden]') === null;

test('View Live Logs is offered in the header of a resource whose logs are available', () => {
  const {view, $} = mount();

  view.renderDrawer(ready(fx.detail({logs: fx.logs(3)})));

  const button = logsButton($);
  assert.ok(button, 'the header has no View Live Logs button');
  assert.equal(button.textContent, 'View Live Logs');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.disabled, false);
  assert.ok(button.tabIndex >= 0, 'reachable by keyboard');
});

test('View Live Logs is offered in the header of a container whose logs are available', () => {
  const {view, $} = mount();

  view.renderDrawer(readyContainer(fx.containerDetail({logs: fx.logs(1)})));

  assert.equal(logsButton($)?.textContent, 'View Live Logs');
  assert.equal(logsButton($).getAttribute('type'), 'button');
});

test('View Live Logs is not offered when logs are not available', () => {
  const {view, $, $$} = mount();

  view.renderDrawer(ready(fx.detail({summary: fx.configMap(), logs: fx.logs(0)})));
  assert.equal($$('#drawer-body .view-logs').length, 0, 'a resource without pods');

  view.renderDrawer(readyContainer(fx.containerDetail({logs: fx.logs(0)})));
  assert.equal($$('#drawer-body .view-logs').length, 0, 'a container while logs are switched off');
});

test('View Live Logs is not offered when the backend does not say whether logs are available', () => {
  const {view, $$} = mount();
  const resource = fx.detail();
  delete resource.logs;
  const container = fx.containerDetail();
  delete container.logs;

  view.renderDrawer(ready(resource));
  assert.equal($$('#drawer-body .view-logs').length, 0);

  view.renderDrawer(readyContainer(container));
  assert.equal($$('#drawer-body .view-logs').length, 0);

  view.renderDrawer(ready(fx.detail({logs: {available: 'yes', pods: 3, totalPods: 3}})));
  assert.equal($$('#drawer-body .view-logs').length, 0, 'only a plain true offers logs');
});

test('View Live Logs asks to view the logs', () => {
  const {view, $, calls} = mount();
  view.renderDrawer(ready());

  logsButton($).click();

  assert.deepEqual(calls, [['onViewLogs']]);
});

test('refreshing the details keeps the focus on View Live Logs', () => {
  const {view, document, $} = mount();
  view.renderDrawer(ready());
  const before = logsButton($);
  before.focus();

  view.renderDrawer(ready(fx.detail({statusYaml: 'replicas: 3\nreadyReplicas: 3\n'})));

  assert.notEqual(logsButton($), before, 'the details were rebuilt');
  assert.equal(document.activeElement, logsButton($));
});

// --- Live logs: the logs view ------------------------------------------------

/** Shows the details of a resource and switches to its logs. */
function viewingLogs(drawer = ready()) {
  const mounted = mount();
  mounted.view.renderDrawer(drawer);
  mounted.view.openLogs();
  mounted.calls.length = 0;
  return mounted;
}

const podDetail = () => fx.detail({summary: fx.pod(), outgoing: [], incoming: [], missing: []});

/** What each entry of the log shows: [class, time, source, text]. */
const entries = ($$) => $$('#logs-lines > *').map((entry) => [
  entry.className,
  entry.querySelector('.log-time')?.textContent ?? null,
  entry.querySelector('.log-source')?.textContent ?? null,
  entry.querySelector('.log-text').textContent,
]);

/**
 * Gives the log area a size, which jsdom does not compute: every entry that is
 * shown is 20px high, a hidden one takes no room.
 */
function layOut(list, clientHeight = 100) {
  Object.defineProperty(list, 'clientHeight', {configurable: true, get: () => clientHeight});
  Object.defineProperty(list, 'scrollHeight', {
    configurable: true,
    get: () => 20 * [...list.children].filter((entry) => !entry.hidden).length,
  });
}

const numbered = (from, count) =>
    Array.from({length: count}, (_, i) => fx.logLine({text: `line ${from + i}`}));

test('the logs view is hidden while the details are shown', () => {
  const {view, $} = mount();

  view.renderDrawer(ready());

  assert.equal(visible($('#logs')), false);
  assert.equal($('#drawer').classList.contains('showing-logs'), false);
});

test('viewing the logs shows them in place of the detail sections and keeps the header', () => {
  const {view, $, $$} = mount();
  view.renderDrawer(ready());

  view.openLogs();

  assert.equal(visible($('#logs')), true);
  assert.ok($('#drawer').contains($('#logs')), 'the logs are shown in the details panel');
  assert.ok($('#drawer').classList.contains('showing-logs'));
  assert.equal($$('#drawer-body .section').length, 0, 'the sections make room for the logs');
  assert.equal($('.drawer-head .drawer-kind').textContent, 'Deployment');
  assert.equal($('.drawer-head .drawer-name').textContent, 'default/web');
  assert.equal($('.drawer-head .badge').textContent, '▲ In-Progress');
  assert.equal($$('#drawer-body .view-logs').length, 0, 'the logs are already shown');
  assert.equal($('#logs-lines').getAttribute('role'), 'log');
});

test('the header of a container stays above its logs', () => {
  const {$, $$} = viewingLogs(readyContainer());

  assert.equal($('.drawer-head .drawer-kind').textContent, 'Container');
  assert.equal($('.drawer-head .drawer-name').textContent, 'app');
  assert.equal($('.drawer-head button.link').textContent, 'Pod default/web-7d4b9c-abcde');
  assert.equal($$('#drawer-body .section').length, 0);
});

test('until a line arrives the logs view says that there are no log lines yet', () => {
  const {view, $, $$} = viewingLogs();

  assert.equal(visible($('#logs-empty')), true);
  assert.equal($('#logs-empty').textContent, 'No log lines yet.');
  assert.equal($$('#logs-lines > *').length, 0);

  view.appendLogs(fx.logBatch());

  assert.equal(visible($('#logs-empty')), false);
});

test('a notice alone also ends the empty state', () => {
  const {view, $} = viewingLogs();

  view.appendLogs(fx.logBatch([], [fx.logNotice()]));

  assert.equal(visible($('#logs-empty')), false);
});

test('the lines of a container show their time and text, and not where they come from', () => {
  const {view, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch([
    fx.logLine({time: '2026-11-15T18:00:00.123456789Z', text: 'listening on :80'}),
    fx.logLine({time: '2026-11-15T18:00:01.5Z', text: 'GET /healthz 200'}),
  ]));

  assert.deepEqual(entries($$), [
    ['log-line', '18:00:00', null, 'listening on :80'],
    ['log-line', '18:00:01', null, 'GET /healthz 200'],
  ]);
  assert.equal($$('#logs-lines > *')[0].textContent, '18:00:00 listening on :80');
});

test('the lines of a pod say which container wrote them', () => {
  const {view, $$} = viewingLogs(ready(podDetail()));

  view.appendLogs(fx.logBatch([
    fx.logLine({container: 'app', text: 'listening on :80'}),
    fx.logLine({container: 'sidecar', text: 'proxy ready'}),
  ]));

  assert.deepEqual(entries($$), [
    ['log-line', '18:00:00', 'app', 'listening on :80'],
    ['log-line', '18:00:00', 'sidecar', 'proxy ready'],
  ]);
  assert.equal($$('#logs-lines > *')[1].textContent, '18:00:00 sidecar proxy ready');
});

test('the lines of anything else say which pod and container wrote them', () => {
  const {view, $$} = viewingLogs(ready(fx.detail()));

  view.appendLogs(fx.logBatch([
    fx.logLine({pod: 'web-7d4b9c-abcde', container: 'app', text: 'one'}),
    fx.logLine({pod: 'web-7d4b9c-fghij', container: 'sidecar', text: 'two'}),
  ]));

  assert.deepEqual(entries($$), [
    ['log-line', '18:00:00', 'web-7d4b9c-abcde/app', 'one'],
    ['log-line', '18:00:00', 'web-7d4b9c-fghij/sidecar', 'two'],
  ]);
});

test('lines are listed oldest first, and later events add below them', () => {
  const {view, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch(numbered(1, 2)));
  view.appendLogs(fx.logBatch(numbered(3, 1)));

  assert.deepEqual(texts($$('#logs-lines .log-text')), ['line 1', 'line 2', 'line 3']);
});

test('the time of a line is its UTC time of day; the whole timestamp is its tooltip', () => {
  const {view, $} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch([fx.logLine({time: '2026-11-15T23:59:07.000000001Z'})]));

  assert.equal($('.log-time').textContent, '23:59:07');
  assert.equal($('.log-time').getAttribute('title'), '2026-11-15T23:59:07.000000001Z');
});

test('a line without a timestamp shows no time', () => {
  const {view, $, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch([fx.logLine({time: '', text: 'no time'})]));

  assert.equal($('.log-time'), null);
  assert.equal($$('#logs-lines > *')[0].textContent, 'no time');
});

test('log text is shown character for character, with its spaces', () => {
  const {view, $} = viewingLogs(readyContainer());
  const text = '  at main.go:42\t  {"level": "error",   "msg": "a  b"}  ';

  view.appendLogs(fx.logBatch([fx.logLine({text})]));

  assert.equal($('.log-text').textContent, text);
  assert.equal($('.log-text').children.length, 0);
});

test('an empty log line is still a line', () => {
  const {view, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch([fx.logLine({text: 'before'}), fx.logLine({text: ''}), fx.logLine({text: 'after'})]));

  assert.deepEqual(texts($$('#logs-lines .log-text')), ['before', '', 'after']);
});

test('a notice is shown among the lines, marked as a notice, with its container and its message', () => {
  const {view, $, $$} = viewingLogs(ready(podDetail()));
  const message = 'container "sidecar" in pod "web-7d4b9c-abcde" is waiting to start: ContainerCreating';

  view.appendLogs(fx.logBatch(
      [fx.logLine({text: 'listening on :80'})], [fx.logNotice({container: 'sidecar', message})]));
  view.appendLogs(fx.logBatch([fx.logLine({container: 'sidecar', text: 'proxy ready'})]));

  assert.deepEqual(entries($$), [
    ['log-line', '18:00:00', 'app', 'listening on :80'],
    ['log-notice', null, 'sidecar', message],
    ['log-line', '18:00:00', 'sidecar', 'proxy ready'],
  ]);
  assert.ok($('.log-notice .log-mark'), 'a notice starts with a mark that tells it from a log line');
  assert.equal($('.log-line .log-mark'), null);
});

test('a notice names the pod and the container when several pods are followed', () => {
  const {view, $$} = viewingLogs(ready(fx.detail()));

  view.appendLogs(fx.logBatch([], [
    fx.logNotice({pod: 'web-7d4b9c-fghij', container: 'app', message: 'the cluster refused: forbidden'}),
    fx.logNotice({pod: 'web-7d4b9c-klmno', container: '', message: 'the pod is not scheduled yet'}),
  ]));

  assert.deepEqual(entries($$), [
    ['log-notice', null, 'web-7d4b9c-fghij/app', 'the cluster refused: forbidden'],
    ['log-notice', null, 'web-7d4b9c-klmno', 'the pod is not scheduled yet'],
  ]);
});

test('a notice about the selected container does not repeat its name', () => {
  const {view, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch([], [fx.logNotice({container: 'app', message: 'is waiting to start'})]));

  assert.deepEqual(entries($$), [['log-notice', null, null, 'is waiting to start']]);
});

test('when only some pods are followed the logs view says how many of how many', () => {
  const {$} = viewingLogs(ready(fx.detail({logs: fx.logs(10, 23)})));

  assert.equal(visible($('#logs-pods')), true);
  assert.equal($('#logs-pods').textContent, 'Logs of 10 of 23 pods');
});

test('when every pod is followed nothing is said about pods', () => {
  for (const drawer of [ready(fx.detail({logs: fx.logs(3)})), ready(podDetail()), readyContainer()]) {
    const {$} = viewingLogs(drawer);

    assert.equal(visible($('#logs-pods')), false);
    assert.equal($('#logs-pods').textContent, '');
  }
});

test('the logs view says whether it is connecting, live, or ended', () => {
  const {view, $} = viewingLogs();
  const status = $('#logs-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.ok($('#logs').contains(status));

  assert.equal(status.textContent, 'Connecting…');

  view.setLogsStatus('live');
  assert.equal(status.textContent, 'Live');

  view.setLogsStatus('ended');
  assert.equal(status.textContent, 'The log stream ended.');
});

test('a log stream that ended can be started again with View Live Logs', () => {
  const {view, $, calls} = viewingLogs();
  const restart = $('#logs-restart');
  assert.equal(restart.textContent, 'View Live Logs');
  assert.equal(visible(restart), false, 'nothing to start again while connecting');

  view.setLogsStatus('live');
  assert.equal(visible(restart), false, 'nor while the logs are live');

  view.setLogsStatus('ended');
  assert.equal(visible(restart), true);
  restart.click();

  assert.deepEqual(calls, [['onViewLogs']]);
});

test('viewing the logs again starts with an empty log', () => {
  const {view, $, $$} = viewingLogs();
  view.appendLogs(fx.logBatch(numbered(1, 3), [fx.logNotice()]));
  view.setLogsStatus('ended');

  view.openLogs();

  assert.equal($$('#logs-lines > *').length, 0, 'the server sends the recent lines again');
  assert.equal(visible($('#logs-empty')), true);
  assert.equal($('#logs-status').textContent, 'Connecting…');
  assert.equal(visible($('#logs-restart')), false);
  assert.equal(visible($('#logs')), true);
});

// --- Live logs: scale --------------------------------------------------------

test('each event adds its lines to the log without rebuilding the lines already there', () => {
  const {view, $$} = viewingLogs(readyContainer());
  view.appendLogs(fx.logBatch(numbered(1, 3)));
  const before = $$('#logs-lines > *');

  view.appendLogs(fx.logBatch(numbered(4, 2)));

  const after = $$('#logs-lines > *');
  assert.equal(after.length, 5);
  before.forEach((element, i) => assert.equal(after[i], element, `line ${i + 1} was replaced`));
});

test('the log keeps at most 2000 lines: the oldest are dropped, and it says so once', () => {
  const {view, $, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch(numbered(1, 1500)));
  view.appendLogs(fx.logBatch(numbered(1501, 500)));
  assert.equal($$('#logs-lines > *').length, 2000);
  assert.equal(visible($('#logs-dropped')), false, 'nothing was dropped yet');

  view.appendLogs(fx.logBatch(numbered(2001, 3)));
  assert.equal($$('#logs-lines > *').length, 2000);
  assert.equal($('#logs-lines').firstElementChild.querySelector('.log-text').textContent, 'line 4');
  assert.equal($('#logs-lines').lastElementChild.querySelector('.log-text').textContent, 'line 2003');
  assert.equal(visible($('#logs-dropped')), true);
  assert.equal($('#logs-dropped').textContent, 'Older lines were dropped.');
  assert.ok($('#logs-dropped').compareDocumentPosition($('#logs-lines')) & 4, 'stated above the lines');

  view.appendLogs(fx.logBatch(numbered(2004, 700)));
  assert.equal($$('#logs-lines > *').length, 2000);
  assert.equal($('#logs-lines').firstElementChild.querySelector('.log-text').textContent, 'line 704');
  assert.equal($$('#logs-dropped').length, 1, 'stated once, however often lines are dropped');
  assert.equal($('#logs').textContent.split('Older lines were dropped.').length - 1, 1);
});

test('one event with more lines than the log keeps shows the newest 2000', () => {
  const {view, $, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch(numbered(1, 2500)));

  assert.equal($$('#logs-lines > *').length, 2000);
  assert.equal($('#logs-lines').firstElementChild.querySelector('.log-text').textContent, 'line 501');
  assert.equal(visible($('#logs-dropped')), true);
});

test('notices count towards the 2000 entries the log keeps', () => {
  const {view, $$} = viewingLogs(readyContainer());

  view.appendLogs(fx.logBatch(numbered(1, 1999), [fx.logNotice(), fx.logNotice()]));

  assert.equal($$('#logs-lines > *').length, 2000);
  assert.equal($$('#logs-lines > .log-notice').length, 2);
});

test('viewing the logs again no longer says that lines were dropped', () => {
  const {view, $} = viewingLogs(readyContainer());
  view.appendLogs(fx.logBatch(numbered(1, 2001)));

  view.openLogs();

  assert.equal(visible($('#logs-dropped')), false);
});

// --- Live logs: following ----------------------------------------------------

test('a log that is scrolled to the bottom stays at the bottom when lines arrive', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);

  view.appendLogs(fx.logBatch(numbered(1, 50)));
  assert.ok(list.scrollTop >= 1000 - 100, `the first lines end at the bottom; scrollTop is ${list.scrollTop}`);

  // A browser clamps the offset to the end of the content.
  list.scrollTop = 900;
  view.appendLogs(fx.logBatch(numbered(51, 10)));
  assert.ok(list.scrollTop >= 1200 - 100, `new lines are followed; scrollTop is ${list.scrollTop}`);
});

test('a log that is within a few pixels of the bottom counts as at the bottom', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));

  list.scrollTop = 897;
  view.appendLogs(fx.logBatch(numbered(51, 1)));

  assert.ok(list.scrollTop >= 1020 - 100, `scrollTop is ${list.scrollTop}`);
});

test('a log the user scrolled up in does not move when lines arrive', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));

  list.scrollTop = 400;
  view.appendLogs(fx.logBatch(numbered(51, 10)));
  view.appendLogs(fx.logBatch([], [fx.logNotice()]));

  assert.equal(list.scrollTop, 400);
});

test('scrolling back to the bottom follows new lines again', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));
  list.scrollTop = 400;
  view.appendLogs(fx.logBatch(numbered(51, 10)));

  list.scrollTop = 1100;
  view.appendLogs(fx.logBatch(numbered(61, 10)));

  assert.ok(list.scrollTop >= 1400 - 100, `scrollTop is ${list.scrollTop}`);
});

test('dropping the oldest lines does not move what a user who scrolled up is reading', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 2000)));
  // Line 1001 is at the top of the visible part.
  list.scrollTop = 20000;

  view.appendLogs(fx.logBatch(numbered(2001, 10)));

  assert.equal(list.firstElementChild.querySelector('.log-text').textContent, 'line 11');
  assert.equal(list.scrollTop, 20000 - 10 * 20, 'line 1001 is still at the top of the visible part');
});

test('a new log starts at its top, whatever the previous one was scrolled to', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));
  list.scrollTop = 400;

  view.openLogs();

  assert.equal(list.scrollTop, 0);
});

// --- Live logs: going back, and what a refresh keeps ---------------------------

test('Details asks to return to the details', () => {
  const {$, calls} = viewingLogs();
  const back = $('#logs-back');
  assert.equal(back.textContent.replace('←', '').trim(), 'Details');

  back.click();

  assert.deepEqual(calls, [['onCloseLogs']]);
});

test('returning to the details shows the sections and View Live Logs again and empties the log', () => {
  const {view, $, $$} = viewingLogs();
  view.appendLogs(fx.logBatch(numbered(1, 3)));

  view.closeLogs();

  assert.equal(visible($('#logs')), false);
  assert.equal($('#drawer').classList.contains('showing-logs'), false);
  assert.deepEqual(texts($$('#drawer-body .section-title')), ['Configuration', 'Status', 'Events', 'Connections']);
  assert.equal(logsButton($).textContent, 'View Live Logs');
  assert.equal($$('#logs-lines > *').length, 0, 'a hidden log keeps no lines');
});

test('lines that arrive while the details are shown are not kept', () => {
  const {view, $$} = mount();
  view.renderDrawer(ready());

  view.appendLogs(fx.logBatch(numbered(1, 3)));

  assert.equal($$('#logs-lines > *').length, 0);
});

test('refreshing the details while the logs are shown keeps the lines and updates the header', () => {
  const {view, $, $$} = viewingLogs();
  view.appendLogs(fx.logBatch(numbered(1, 3), [fx.logNotice()]));
  view.setLogsStatus('live');
  const before = $$('#logs-lines > *');
  const failed = {...fx.deployment(), health: 'red', reason: 'ProgressDeadlineExceeded'};

  view.renderDrawer(ready(fx.detail({summary: failed})));

  assert.equal(visible($('#logs')), true, 'the logs stay open');
  assert.deepEqual($$('#logs-lines > *'), before, 'the very same lines');
  assert.equal($('#logs-status').textContent, 'Live');
  assert.equal($('.drawer-head .badge').textContent, '■ Failed');
  assert.equal($('.drawer-head .drawer-reason').textContent, 'ProgressDeadlineExceeded');
  assert.equal($$('#drawer-body .section').length, 0);
  assert.equal($$('#drawer-body .view-logs').length, 0);
});

test('refreshing the details while the logs are shown keeps the log where it was scrolled to', () => {
  const {view, $} = viewingLogs();
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));
  list.scrollTop = 400;

  view.renderDrawer(ready());

  assert.equal(list.scrollTop, 400);
});

test('a refresh updates how many pods are followed', () => {
  const {view, $} = viewingLogs(ready(fx.detail({logs: fx.logs(3)})));

  view.renderDrawer(ready(fx.detail({logs: fx.logs(10, 12)})));

  assert.equal(visible($('#logs-pods')), true);
  assert.equal($('#logs-pods').textContent, 'Logs of 10 of 12 pods');
});

test('when a refresh says logs are no longer available, what the log shows stays', () => {
  const {view, $, $$} = viewingLogs(ready(fx.detail({logs: fx.logs(10, 23)})));
  view.appendLogs(fx.logBatch(numbered(1, 3)));
  view.setLogsStatus('ended');
  assert.equal(visible($('#logs-restart')), true);

  view.renderDrawer(ready(fx.detail({logs: fx.logs(0)})));

  assert.equal(visible($('#logs')), true);
  assert.equal($$('#logs-lines > *').length, 3);
  assert.equal($('#logs-status').textContent, 'The log stream ended.');
  assert.equal(visible($('#logs-restart')), false, 'there are no logs to start again');
  assert.equal(visible($('#logs-pods')), false);
});

test('the log of a resource that was deleted stays readable, but cannot be started again', () => {
  const {view, $, $$} = viewingLogs();
  view.appendLogs(fx.logBatch(numbered(1, 3)));
  view.setLogsStatus('ended');

  view.renderDrawer({state: 'gone', selection: {uid: fx.UID.deployment}});

  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
  assert.equal(visible($('#logs')), true);
  assert.equal($$('#logs-lines > *').length, 3);
  assert.equal(visible($('#logs-restart')), false);
  assert.equal(visible($('#logs-back')), true);
});

test('selecting something else leaves the logs view', () => {
  const {view, $, $$} = viewingLogs();
  view.appendLogs(fx.logBatch(numbered(1, 3)));

  view.renderDrawer({state: 'loading', selection: {uid: fx.UID.configMap}});

  assert.equal(visible($('#logs')), false);
  assert.equal($$('#logs-lines > *').length, 0);
  assert.equal($('#drawer-body').textContent, 'Loading…');

  view.renderDrawer(ready(fx.detail({summary: fx.pod()})));
  assert.equal(visible($('#logs')), false, 'the logs of one resource are never shown under another');
  assert.ok(logsButton($));
});

test('switching from a pod to one of its containers leaves the logs view', () => {
  const {view, $} = viewingLogs(ready(podDetail(), {uid: fx.UID.pod}));

  view.renderDrawer(readyContainer());

  assert.equal(visible($('#logs')), false);
});

test('closing the drawer leaves the logs view', () => {
  const {view, $, $$} = viewingLogs();
  view.appendLogs(fx.logBatch(numbered(1, 3)));

  view.renderDrawer({state: 'closed'});
  assert.equal($$('#logs-lines > *').length, 0);

  view.renderDrawer(ready());
  assert.equal(visible($('#logs')), false);
  assert.equal($('#drawer').classList.contains('showing-logs'), false);
});

test('viewing the logs moves the keyboard focus to Details, and going back returns it to View Live Logs', () => {
  const {view, document, $} = mount();
  view.renderDrawer(ready());
  logsButton($).focus();

  view.openLogs();
  assert.equal(document.activeElement, $('#logs-back'), 'the button that had the focus is gone');

  view.closeLogs();
  assert.equal(document.activeElement, logsButton($));
});

test('starting an ended log again from the keyboard keeps the focus in the logs view', () => {
  const {view, document, $} = viewingLogs();
  view.setLogsStatus('ended');
  $('#logs-restart').focus();

  view.openLogs();

  assert.equal(document.activeElement, $('#logs-back'), 'the button that had the focus is hidden');
});

test('viewing the logs does not take the focus away from somewhere else', () => {
  const {view, document, $} = mount();
  view.renderDrawer(ready());
  $('#search').focus();

  view.openLogs();

  assert.equal(document.activeElement, $('#search'));
});

// --- Live logs: the filter ---------------------------------------------------
// features/live_logs.feature, rule "The lines that are shown can be filtered".

const WRITTEN = ['GET /healthz 200', 'ERROR disk full', 'error: retrying a.b', 'saved axb'];

/** The live logs of a pod that wrote the four lines of the feature file. */
function filteringLogs(drawer = ready(podDetail())) {
  const mounted = viewingLogs(drawer);
  mounted.view.appendLogs(fx.logBatch(WRITTEN.map((text) => fx.logLine({text}))));
  return mounted;
}

/** The text of the log lines that are shown, in order. */
const shownLines = ($$) =>
    $$('#logs-lines > .log-line').filter(visible).map((line) => line.querySelector('.log-text').textContent);
const filterStatus = ($) => $('#logs-filter-status').textContent;

test('without a filter every line is shown and nothing is said about filtering', () => {
  const {$, $$} = filteringLogs();

  assert.equal($('#logs-filter').value, '');
  assert.equal(visible($('#logs-filter')), true);
  assert.deepEqual(shownLines($$), WRITTEN);
  assert.equal(filterStatus($), '');
  assert.equal($('#logs-filter').hasAttribute('aria-invalid'), false);
});

test('a keyword in the filter field shows only the lines that contain it, and says how many', () => {
  const {$, $$} = filteringLogs();

  type($('#logs-filter'), 'error');

  assert.deepEqual(shownLines($$), ['ERROR disk full', 'error: retrying a.b']);
  assert.equal(filterStatus($), 'Showing 2 of 4 lines');
  assert.equal($('#logs-filter-status').getAttribute('role'), 'status');
  assert.deepEqual(texts($$('#logs-lines > .log-line .log-text')), WRITTEN,
      'the other lines are hidden, not removed: the filter narrows what the page holds');
});

test('a keyword is taken literally', () => {
  const {$, $$} = filteringLogs();

  type($('#logs-filter'), 'a.b');

  assert.deepEqual(shownLines($$), ['error: retrying a.b']);
  assert.equal(filterStatus($), 'Showing 1 of 4 lines');
});

test('text between slashes filters by a regular expression', () => {
  const {$, $$} = filteringLogs();

  type($('#logs-filter'), '/^ERROR|200$/');

  assert.deepEqual(shownLines($$), ['GET /healthz 200', 'ERROR disk full']);
  assert.equal(filterStatus($), 'Showing 2 of 4 lines');
});

test('a regular expression tells upper from lower case unless it ends in /i', () => {
  const {$, $$} = filteringLogs();

  type($('#logs-filter'), '/error/');
  assert.deepEqual(shownLines($$), ['error: retrying a.b']);

  type($('#logs-filter'), '/error/i');
  assert.deepEqual(shownLines($$), ['ERROR disk full', 'error: retrying a.b']);
});

test('an invalid regular expression is reported, marks the field, and hides nothing', () => {
  const {$, $$} = filteringLogs();
  type($('#logs-filter'), 'error');

  type($('#logs-filter'), '/(/');

  assert.equal(filterStatus($), 'Not a valid regular expression.');
  assert.equal($('#logs-filter').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(shownLines($$), WRITTEN, 'an invalid filter filters nothing');

  type($('#logs-filter'), '/(error)/');
  assert.equal($('#logs-filter').hasAttribute('aria-invalid'), false, 'corrected');
  assert.deepEqual(shownLines($$), ['error: retrying a.b']);
  assert.equal(filterStatus($), 'Showing 1 of 4 lines');
});

test('a regular expression with a flag other than i is reported as invalid', () => {
  const {$, $$} = filteringLogs();

  type($('#logs-filter'), '/error/g');

  assert.equal(filterStatus($), 'Not a valid regular expression.');
  assert.equal($('#logs-filter').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(shownLines($$), WRITTEN);
});

test('lines that arrive later are filtered too', () => {
  const {view, $, $$} = filteringLogs();
  type($('#logs-filter'), 'error');

  view.appendLogs(fx.logBatch([fx.logLine({text: '200 OK'}), fx.logLine({text: 'fatal error'})]));

  assert.deepEqual(shownLines($$), ['ERROR disk full', 'error: retrying a.b', 'fatal error']);
  assert.equal(filterStatus($), 'Showing 3 of 6 lines');
  assert.equal($$('#logs-lines > .log-line').length, 6, 'the line that is not shown is kept');
});

test('lines that arrive while the filter is invalid are all shown', () => {
  const {view, $, $$} = filteringLogs();
  type($('#logs-filter'), '/[/');

  view.appendLogs(fx.logBatch([fx.logLine({text: '200 OK'})]));

  assert.deepEqual(shownLines($$), [...WRITTEN, '200 OK']);
  assert.equal(filterStatus($), 'Not a valid regular expression.');
});

test('when no line matches the filter, that is stated', () => {
  const {$, $$} = filteringLogs();

  type($('#logs-filter'), 'no such text');

  assert.deepEqual(shownLines($$), []);
  assert.equal(filterStatus($), 'No line matches the filter.');
  assert.equal(visible($('#logs-empty')), false, 'lines did arrive: "No log lines yet." would be wrong');
});

test('clearing the filter field shows every line again', () => {
  const {$, $$} = filteringLogs();
  type($('#logs-filter'), 'error');

  type($('#logs-filter'), '');

  assert.deepEqual(shownLines($$), WRITTEN);
  assert.equal(filterStatus($), '');
});

test('a filter field that holds only spaces filters nothing', () => {
  const {$, $$} = filteringLogs();

  type($('#logs-filter'), '   ');

  assert.deepEqual(shownLines($$), WRITTEN);
  assert.equal(filterStatus($), '');
});

test('notices are never filtered away, and are not counted as lines', () => {
  const {view, $, $$} = filteringLogs();
  view.appendLogs(fx.logBatch([], [fx.logNotice({container: 'sidecar', message: 'is waiting to start'})]));

  type($('#logs-filter'), 'error');

  assert.equal(visible($('#logs-lines > .log-notice')), true);
  assert.equal(filterStatus($), 'Showing 2 of 4 lines');

  view.appendLogs(fx.logBatch([], [fx.logNotice({message: 'the cluster refused'})]));
  assert.deepEqual($$('#logs-lines > .log-notice').map(visible), [true, true], 'nor one that arrives later');

  type($('#logs-filter'), 'no such text');
  assert.deepEqual($$('#logs-lines > .log-notice').map(visible), [true, true]);
  assert.equal(filterStatus($), 'No line matches the filter.');
});

test('the filter looks at the text of a line only, not at its time or at where it comes from', () => {
  const {$, $$} = filteringLogs();
  assert.equal($('#logs-lines .log-time').textContent, '18:00:00');
  assert.equal($('#logs-lines .log-source').textContent, 'app');

  type($('#logs-filter'), '18:00');
  assert.deepEqual(shownLines($$), []);

  type($('#logs-filter'), 'app');
  assert.deepEqual(shownLines($$), []);

  type($('#logs-filter'), '/^GET/');
  assert.deepEqual(shownLines($$), ['GET /healthz 200'], 'the text starts where the text starts');
});

test('a filter entered before any line arrived applies to the lines that come', () => {
  const {view, $, $$} = viewingLogs(ready(podDetail()));

  type($('#logs-filter'), 'error');
  assert.equal(filterStatus($), 'Showing 0 of 0 lines');
  assert.equal(visible($('#logs-empty')), true, 'still nothing arrived');

  view.appendLogs(fx.logBatch(WRITTEN.map((text) => fx.logLine({text}))));
  assert.deepEqual(shownLines($$), ['ERROR disk full', 'error: retrying a.b']);
  assert.equal(filterStatus($), 'Showing 2 of 4 lines');
  assert.equal(visible($('#logs-empty')), false);
});

test('hidden lines count towards the 2000 the log keeps, and the counts follow what is dropped', () => {
  const {view, $, $$} = viewingLogs(readyContainer());
  view.appendLogs(fx.logBatch(numbered(1, 2000)));

  // "line 1" to "line 99".
  type($('#logs-filter'), '/^line \\d{1,2}$/');
  assert.equal(filterStatus($), 'Showing 99 of 2000 lines');

  view.appendLogs(fx.logBatch(numbered(2001, 10)));

  assert.equal($$('#logs-lines > *').length, 2000);
  assert.equal($('#logs-lines').firstElementChild.querySelector('.log-text').textContent, 'line 11');
  assert.equal(filterStatus($), 'Showing 89 of 2000 lines');
  assert.equal(visible($('#logs-dropped')), true);
});

test('what the filter did is only written when it changes', () => {
  const {view, $} = filteringLogs();
  const status = $('#logs-filter-status');

  type($('#logs-filter'), 'no such text');
  const written = status.firstChild;
  view.appendLogs(fx.logBatch([fx.logLine({text: 'another line'})]));
  assert.equal(status.firstChild, written, 'the same statement is not read aloud again');

  type($('#logs-filter'), '/(/');
  const invalid = status.firstChild;
  view.appendLogs(fx.logBatch([fx.logLine({text: 'another line'})]));
  type($('#logs-filter'), '/((/');
  assert.equal(status.firstChild, invalid);

  type($('#logs-filter'), 'another');
  assert.equal(status.textContent, 'Showing 2 of 6 lines');
});

// --- Live logs: how long the filter lasts --------------------------------------

test('the filter stays when the stream is started again', () => {
  const {view, $, $$} = filteringLogs();
  type($('#logs-filter'), 'error');
  view.setLogsStatus('ended');

  view.openLogs();

  assert.equal($('#logs-filter').value, 'error');
  assert.equal(filterStatus($), 'Showing 0 of 0 lines');

  view.appendLogs(fx.logBatch(WRITTEN.map((text) => fx.logLine({text}))));
  assert.deepEqual(shownLines($$), ['ERROR disk full', 'error: retrying a.b']);
  assert.equal(filterStatus($), 'Showing 2 of 4 lines');
});

test('the filter stays when the details are refreshed', () => {
  const {view, $, $$} = filteringLogs();
  type($('#logs-filter'), 'error');

  view.renderDrawer(ready(podDetail()));

  assert.equal($('#logs-filter').value, 'error');
  assert.deepEqual(shownLines($$), ['ERROR disk full', 'error: retrying a.b']);
  assert.equal(filterStatus($), 'Showing 2 of 4 lines');
});

test('an invalid filter stays marked when the stream is started again', () => {
  const {view, $} = filteringLogs();
  type($('#logs-filter'), '/(/');

  view.openLogs();

  assert.equal($('#logs-filter').value, '/(/');
  assert.equal($('#logs-filter').getAttribute('aria-invalid'), 'true');
  assert.equal(filterStatus($), 'Not a valid regular expression.');
});

for (const [how, leave] of [
  ['returning to the details', (view) => view.closeLogs()],
  ['selecting something else', (view) => view.renderDrawer({state: 'loading', selection: {uid: fx.UID.configMap}})],
  ['closing the drawer', (view) => view.renderDrawer({state: 'closed'})],
]) {
  test(`${how} empties the filter field: the next look at the logs starts unfiltered`, () => {
    for (const entered of ['error', '/(/']) {
      const {view, $, $$} = filteringLogs();
      type($('#logs-filter'), entered);

      leave(view);

      assert.equal($('#logs-filter').value, '', entered);
      assert.equal(filterStatus($), '', entered);
      assert.equal($('#logs-filter').hasAttribute('aria-invalid'), false, entered);

      view.renderDrawer(ready(podDetail()));
      view.openLogs();
      view.appendLogs(fx.logBatch(WRITTEN.map((text) => fx.logLine({text}))));
      assert.deepEqual(shownLines($$), WRITTEN, entered);
      assert.equal(filterStatus($), '', entered);
    }
  });
}

// --- Live logs: the filter and the reading position ----------------------------

test('a log that was at its end is at its end after the filter is cleared', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));
  // "line 1" to "line 9": 180px of lines in a 100px high log.
  type($('#logs-filter'), '/^line \\d$/');
  list.scrollTop = 80;

  type($('#logs-filter'), '');

  assert.ok(list.scrollTop >= 1000 - 100, `scrollTop is ${list.scrollTop}`);
});

test('a log that was at its end is at its end after a filter is entered', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));
  list.scrollTop = 900;

  type($('#logs-filter'), '/^line \\d$/');

  // The nine lines that are left are 180px high. A browser would stop at 80.
  assert.ok(list.scrollTop >= 80 && list.scrollTop <= 180, `scrollTop is ${list.scrollTop}`);
});

test('a filter change does not move a log the user scrolled up in to its end', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));
  type($('#logs-filter'), '/^line \\d$/');
  list.scrollTop = 20;

  type($('#logs-filter'), '');

  assert.equal(list.scrollTop, 20);
});

test('a filtered log that is at its end follows the matching lines that arrive', () => {
  const {view, $} = viewingLogs(readyContainer());
  const list = $('#logs-lines');
  layOut(list, 100);
  view.appendLogs(fx.logBatch(numbered(1, 50)));
  // "line 10" to "line 99".
  type($('#logs-filter'), '/^line \\d\\d$/');
  assert.equal(list.scrollHeight, 41 * 20);
  list.scrollTop = 41 * 20 - 100;

  view.appendLogs(fx.logBatch(numbered(51, 10)));

  assert.ok(list.scrollTop >= 51 * 20 - 100, `scrollTop is ${list.scrollTop}`);
});

// --- Live logs: Escape in the filter field -------------------------------------

test('Escape in a filter field that holds text clears the filter and leaves the drawer open', () => {
  const {$, $$, calls} = filteringLogs();
  type($('#logs-filter'), 'error');
  $('#logs-filter').focus();

  const event = fire($('#logs-filter'), 'keydown', {key: 'Escape'});

  assert.deepEqual(calls, [], 'the drawer is not asked to close');
  assert.equal($('#logs-filter').value, '');
  assert.deepEqual(shownLines($$), WRITTEN);
  assert.equal(filterStatus($), '');
  assert.equal(event.defaultPrevented, true, 'the browser has nothing left to clear');
});

test('Escape in a filter field with an invalid pattern clears it as well', () => {
  const {$, calls} = filteringLogs();
  type($('#logs-filter'), '/(/');

  fire($('#logs-filter'), 'keydown', {key: 'Escape'});

  assert.deepEqual(calls, []);
  assert.equal($('#logs-filter').value, '');
  assert.equal($('#logs-filter').hasAttribute('aria-invalid'), false);
  assert.equal(filterStatus($), '');
});

test('Escape in an empty filter field closes the drawer, as everywhere else', () => {
  const {$, calls} = filteringLogs();

  fire($('#logs-filter'), 'keydown', {key: 'Escape'});
  assert.deepEqual(calls, [['onCloseDrawer']]);

  type($('#logs-filter'), 'error');
  fire($('#logs-back'), 'keydown', {key: 'Escape'});
  assert.deepEqual(calls, [['onCloseDrawer'], ['onCloseDrawer']], 'elsewhere a filter does not hold Escape back');
  assert.equal($('#logs-filter').value, 'error', 'whether the filter goes is for the application to decide');
});

test('other keys in the filter field are left alone', () => {
  const {$, calls} = filteringLogs();
  type($('#logs-filter'), 'error');

  const event = fire($('#logs-filter'), 'keydown', {key: 'Enter'});

  assert.deepEqual(calls, []);
  assert.equal(event.defaultPrevented, false);
  assert.equal($('#logs-filter').value, 'error');
});
