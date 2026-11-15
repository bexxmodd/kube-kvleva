import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import * as filters from '../static/js/filters.js';
import * as tree from '../static/js/tree.js';
import * as fx from './fixtures.js';
import {assertNoPageErrors, loadShell, recorder} from './helpers.js';

afterEach(assertNoPageErrors);

// Everything the backend returns comes from the cluster and may be hostile.
// These tests render hostile strings through every part of the view and check
// that none of them is ever interpreted as markup.

const XSS = '<img src=x onerror=alert(1)>';
const PAYLOAD = `${XSS}<script>window.pwned=1</script>"'><svg onload=alert(2)><a href="javascript:alert(3)">x</a>`;

/** Appends the payload to every string found anywhere in `value`. */
function poison(value) {
  if (typeof value === 'string') return value + PAYLOAD;
  if (Array.isArray(value)) return value.map(poison);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, poison(v)]));
  }
  return value;
}

function mount() {
  const {document, window} = loadShell();
  const {handlers} = recorder();
  const view = viewModule.createView(document, handlers);
  return {document, window, view};
}

/** Elements the static shell legitimately contains, by tag name. */
function shellTags() {
  const {document} = loadShell();
  return new Set([...document.querySelectorAll('*')].map((e) => e.localName));
}

/** How many scripts the static shell loads itself (its entry point and the theme boot script). */
function shellScripts() {
  return loadShell().document.querySelectorAll('script').length;
}

/** Asserts that nothing in the document was created from hostile text. */
function assertInert(document, window) {
  const allowed = new Set([...shellTags(),
    // Elements view.js creates on purpose.
    'details', 'summary', 'li', 'label', 'div', 'section', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'h3', 'h4', 'dl', 'dt', 'dd', 'ul', 'p', 'span', 'button', 'input', 'header', 'path']);
  for (const element of document.querySelectorAll('*')) {
    assert.ok(allowed.has(element.localName), `unexpected <${element.localName}> element`);
    for (const attr of element.attributes) {
      assert.doesNotMatch(attr.name, /^on/i, `event handler attribute ${attr.name} on <${element.localName}>`);
      if (attr.name === 'href' || attr.name === 'src') {
        assert.doesNotMatch(attr.value, /^\s*javascript:/i);
      }
    }
  }
  assert.equal(document.querySelectorAll('img, iframe, object, embed, a').length, 0);
  assert.equal(document.querySelectorAll('script').length, shellScripts(), 'no script but those of the shell');
  assert.equal(document.querySelectorAll('svg').length, 0);
  assert.equal(window.pwned, undefined);
}

function load(t, scope, items, parentKey = null) {
  tree.openList(t, scope, parentKey);
  tree.addPage(t, tree.scopeKey(scope), fx.page(items));
}

test('a resource named <img src=x onerror=alert(1)> is shown as text, not as an element', () => {
  const {view, document, window} = mount();
  const t = tree.createTree();
  load(t, {type: 'namespace', name: 'default'}, [fx.summary({uid: 'evil', name: XSS})]);

  view.renderCanvas({overview: fx.overview(), tree: t, selection: null});

  assert.equal(document.querySelector('img'), null, 'no element may be created from the name');
  assert.equal(document.querySelector('[onerror]'), null);
  const name = document.querySelector('.widget .name');
  assert.equal(name.textContent, XSS, 'the name is displayed literally');
  assert.equal(name.children.length, 0);
  assertInert(document, window);
});

test('hostile text in any field of the canvas data stays inert', () => {
  const {view, document, window} = mount();
  const overview = poison(fx.overview());
  const pod = poison(fx.pod());
  const deployment = poison(fx.deployment());
  const node = poison(fx.node());
  const t = tree.createTree();
  load(t, {type: 'namespace', name: overview.namespaces[0].name}, [deployment, pod]);
  load(t, {type: 'parent', uid: deployment.uid}, [pod], tree.scopeKey({type: 'namespace', name: overview.namespaces[0].name}));
  load(t, {type: 'nodes'}, [node]);
  load(t, {type: 'node', name: node.name}, [pod], 'nodes');
  tree.openList(t, {type: 'cluster'});
  tree.setError(t, 'cluster', PAYLOAD);

  view.renderCanvas({overview, tree: t, selection: {uid: pod.uid, container: pod.containers[0].name}});
  view.setSelection({uid: deployment.uid});
  view.reveal(pod.uid);

  assertInert(document, window);
  assert.ok(document.querySelector('.widget .name').textContent.includes(XSS));
  assert.ok(document.querySelector('.container .container-name').textContent.includes(XSS));
  assert.ok(document.querySelector('.area-title').textContent === 'Nodes');
  assert.ok(document.querySelector('.note.error').textContent.includes(XSS));
  assert.equal(view.hasElement(pod.uid), true, 'hostile uids still work as plain identifiers');
});

test('hostile text in the header and sidebar data stays inert', () => {
  const {view, document, window} = mount();
  const overview = poison(fx.overview({sync: {ready: false, kindsTotal: 2, kindsSynced: 1, errors: [
    {kindId: 'example.io/Widget', message: 'forbidden'},
  ]}}));
  const hidden = filters.setKindHidden(filters.setQuery(filters.defaultFilters(), PAYLOAD), overview.kinds[0].kindId, true);

  view.renderHeader({overview, filters: hidden, stream: 'reconnecting'});
  // API groups start collapsed; expanded, their hostile types are listed too.
  view.setExpandedGroups(overview.kinds.map((kind) => kind.group));
  view.renderSidebar({overview, filters: hidden});

  assertInert(document, window);
  assert.ok(document.getElementById('cluster-name').textContent.includes(XSS));
  assert.ok(document.querySelector('.sync-errors li').textContent.includes(XSS));
  assert.ok(document.querySelector('#kind-list .kind-group-name').textContent.includes(XSS));
  assert.ok(document.querySelector('#kind-list .kind-name').textContent.includes(XSS));
  assert.equal(document.getElementById('search').value, PAYLOAD.trim());
});

test('hostile text in resource details stays inert', () => {
  const {view, document, window} = mount();
  const detail = poison(fx.detail({
    owners: [fx.link({uid: 'own-1', kind: 'App', name: 'shop'})],
    eventsError: 'events is forbidden',
  }));

  view.renderDrawer({state: 'ready', selection: {uid: detail.summary.uid}, detail});

  assertInert(document, window);
  assert.ok(document.querySelector('.drawer-name').textContent.includes(XSS));
  assert.ok(document.querySelector('.configuration .yaml').textContent.includes(XSS));
  assert.ok(document.querySelector('.status .yaml').textContent.includes(XSS));
  assert.ok(document.querySelector('.status td').textContent.includes(XSS));
  assert.ok(document.querySelector('.events td').textContent.includes(XSS));
  assert.ok(document.querySelector('.events .note.error').textContent.includes(XSS));
  assert.ok(document.querySelector('.connections .link').textContent.includes(XSS));
  assert.ok(document.querySelector('.connections .missing-name').textContent.includes(XSS));
});

test('hostile text in container details and error states stays inert', () => {
  const {view, document, window} = mount();
  const detail = poison(fx.containerDetail());

  view.renderDrawer({state: 'ready', selection: {uid: detail.pod.uid, container: detail.container.name}, detail});
  assertInert(document, window);
  assert.ok(document.querySelector('.drawer-name').textContent.includes(XSS));
  assert.ok(document.querySelector('.facts dd').textContent.includes(XSS));

  view.renderDrawer({state: 'error', selection: {uid: PAYLOAD}, message: PAYLOAD});
  assertInert(document, window);
  assert.ok(document.querySelector('#drawer-body .note.error').textContent.includes(XSS));
});

test('the colored YAML never turns hostile YAML into markup', () => {
  const {view, document, window} = mount();
  const yaml = [
    `${XSS}: ${XSS}`,
    `key: "${PAYLOAD}"`,
    `# ${PAYLOAD}`,
    'script: |',
    `  ${PAYLOAD}`,
    `- [${PAYLOAD}, {a: ${XSS}}]`,
    '',
  ].join('\n');

  view.renderDrawer({state: 'ready', selection: {uid: 'dep-1'}, detail: fx.detail({yaml, statusYaml: yaml})});

  assertInert(document, window);
  assert.equal(document.querySelector('.configuration .yaml').textContent + '\n', yaml);
  for (const span of document.querySelectorAll('.yaml span')) {
    assert.match(span.className, /^tok-(key|punct|string|number|keyword|comment)$/);
    assert.equal(span.children.length, 0);
  }
});

// --- Live logs ---------------------------------------------------------------
// Log text is whatever a container prints: the least trusted text of all.

/** Shows the logs of a resource and adds one hostile event to them. */
function hostileLogs(drawer) {
  const mounted = mount();
  mounted.view.renderDrawer(drawer);
  mounted.view.openLogs();
  mounted.view.appendLogs(poison(fx.logBatch([fx.logLine()], [fx.logNotice()])));
  return mounted;
}

test('a log line that is markup is shown literally and creates no element', () => {
  const {view, document, window} = mount();
  view.renderDrawer({state: 'ready', selection: {uid: fx.UID.pod, container: 'app'}, detail: fx.containerDetail()});
  view.openLogs();

  view.appendLogs(fx.logBatch([fx.logLine({text: PAYLOAD}), fx.logLine({text: XSS})]));

  const shown = [...document.querySelectorAll('#logs-lines .log-text')];
  assert.deepEqual(shown.map((e) => e.textContent), [PAYLOAD, XSS]);
  for (const element of shown) assert.equal(element.children.length, 0);
  assert.equal(document.querySelectorAll('#logs-lines > *').length, 2, 'two lines, and nothing else');
  assertInert(document, window);
});

test('hostile log text, pod and container names, times and notices stay inert', () => {
  const {document, window} = hostileLogs({state: 'ready', selection: {uid: fx.UID.deployment}, detail: fx.detail()});

  assertInert(document, window);
  assert.ok(document.querySelector('.log-line .log-text').textContent.includes(XSS));
  const source = document.querySelector('.log-line .log-source').textContent;
  assert.equal(source.split(XSS).length - 1, 2, 'the hostile pod name and the hostile container name');
  assert.ok(document.querySelector('.log-line .log-time').getAttribute('title').includes(XSS));
  assert.ok(document.querySelector('.log-notice .log-text').textContent.includes(XSS));
  assert.ok(document.querySelector('.log-notice .log-source').textContent.includes(XSS));
  for (const element of document.querySelectorAll('#logs-lines > * > *')) {
    assert.equal(element.children.length, 0, `.${element.className} holds text only`);
  }
});

test('hostile container names in the logs of a pod stay inert', () => {
  const detail = fx.detail({summary: fx.pod()});

  const {document, window} = hostileLogs({state: 'ready', selection: {uid: fx.UID.pod}, detail});

  assertInert(document, window);
  assert.ok(document.querySelector('.log-line .log-source').textContent.includes(XSS));
});

test('the logs view of a resource whose details are hostile stays inert', () => {
  const detail = poison(fx.detail({logs: fx.logs(10, 23)}));
  // What the backend reports as numbers is shown as text, whatever it is.
  detail.logs = {available: true, pods: PAYLOAD, totalPods: `${PAYLOAD}!`};

  const {view, document, window} = hostileLogs({state: 'ready', selection: {uid: detail.summary.uid}, detail});
  view.setLogsStatus('ended');

  assertInert(document, window);
  assert.ok(document.querySelector('.drawer-name').textContent.includes(XSS));
  assert.ok(document.getElementById('logs-pods').textContent.includes(XSS));
  assert.equal(document.getElementById('logs-pods').children.length, 0);
});

// --- Live logs: the filter ---------------------------------------------------
// The filter text is what the user typed; the lines it is tried on are
// whatever a container printed.

test('hostile text in the filter field is only ever a filter', () => {
  const {view, document, window} = mount();
  view.renderDrawer({state: 'ready', selection: {uid: fx.UID.pod}, detail: fx.detail({summary: fx.pod()})});
  view.openLogs();
  view.appendLogs(fx.logBatch([fx.logLine({text: 'plain'}), fx.logLine({text: PAYLOAD})], [fx.logNotice()]));
  const field = document.getElementById('logs-filter');
  const status = document.getElementById('logs-filter-status');

  for (const entered of [PAYLOAD, XSS, `/${PAYLOAD}/`, `/${XSS}/i`, '/<img[^>]*>/', `/(${XSS}/`]) {
    field.value = entered;
    field.dispatchEvent(new window.Event('input', {bubbles: true}));

    assertInert(document, window);
    assert.equal(field.value, entered, 'what was typed stays in the field, as its value');
    assert.equal(status.children.length, 0, 'what the filter did is stated as text');
    assert.equal(status.textContent.includes('<'), false, 'and never repeats what was typed');
    assert.equal(document.querySelector('#logs-lines .log-text').children.length, 0);
  }
});

test('hostile log text stays inert while a filter shows or hides it', () => {
  const {view, document, window} = mount();
  view.renderDrawer({state: 'ready', selection: {uid: fx.UID.deployment}, detail: fx.detail()});
  view.openLogs();
  const field = document.getElementById('logs-filter');
  const enter = (text) => {
    field.value = text;
    field.dispatchEvent(new window.Event('input', {bubbles: true}));
  };

  // A filter that matches the hostile lines: they arrive and are shown.
  enter('onerror');
  view.appendLogs(poison(fx.logBatch([fx.logLine(), fx.logLine({text: 'second'})], [fx.logNotice()])));
  assertInert(document, window);
  const lines = [...document.querySelectorAll('#logs-lines > .log-line')];
  assert.deepEqual(lines.map((line) => line.hidden), [false, false]);
  assert.ok(lines[0].querySelector('.log-text').textContent.includes(XSS));

  // A filter that hides them, and no filter again.
  for (const text of ['no such text', '/<script>/', '']) {
    enter(text);
    assertInert(document, window);
    for (const part of document.querySelectorAll('#logs-lines > * > *')) assert.equal(part.children.length, 0);
  }
  assert.equal(document.getElementById('logs-filter-status').children.length, 0);
});
