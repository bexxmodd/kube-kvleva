import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as main from '../static/js/main.js';
import * as filters from '../static/js/filters.js';
import * as fx from './fixtures.js';
import {
  assertNoPageErrors, deferred, fakeBackend, fakeClock, FakeEventSource, fire, flush, loadShell, memoryStorage, type,
} from './helpers.js';

afterEach(assertNoPageErrors);

const gatewayClass = () => fx.summary({
  uid: fx.UID.gatewayClass, kindId: 'gateway.networking.k8s.io/GatewayClass',
  group: 'gateway.networking.k8s.io', kind: 'GatewayClass', namespace: '', name: 'kvleva', path: ['cluster'],
});

/** Backend data for a cluster small enough to start expanded. */
function smallCluster() {
  return {
    overview: fx.overview({health: fx.rollup(9, 1, 0)}),
    lists: {
      'nodes=true': [fx.node()],
      'cluster=true': [gatewayClass()],
      'namespace=default': [fx.gateway(), fx.route(), fx.service(), fx.deployment(), fx.configMap()],
      'namespace=shop': [],
      'parent=dep-1': [fx.replicaSet()],
      'parent=rs-1': [fx.pod()],
      'node=kvleva-control-plane': [fx.pod()],
    },
    details: {
      'dep-1': fx.detail(),
      'pod-1': fx.detail({summary: fx.pod(), outgoing: [], incoming: [], missing: []}),
      'svc-1': fx.detail({summary: fx.service(), outgoing: [], incoming: [], missing: []}),
      'cm-1': fx.detail({summary: fx.configMap(), outgoing: [], incoming: [], missing: []}),
      [fx.UID.nsShop]: fx.detail({
        summary: fx.summary({uid: fx.UID.nsShop, kindId: 'core/Namespace', kind: 'Namespace',
                             namespace: '', name: 'shop', path: ['cluster']}),
        outgoing: [], incoming: [], missing: [],
      }),
    },
    containers: {'pod-1/app': fx.containerDetail()},
  };
}

/** Backend data for a cluster too large to start expanded. */
function largeCluster() {
  return {...smallCluster(), overview: fx.overview({health: fx.rollup(50000, 3, 1)})};
}

/** Starts the app against a fake backend inside a fresh copy of the shell. */
function boot({backend = fakeBackend(smallCluster()), storage = memoryStorage(), clipboard, windowWidth} = {}) {
  FakeEventSource.instances.length = 0;
  const {document, window} = loadShell();
  if (windowWidth !== undefined) window.innerWidth = windowWidth;
  const clock = fakeClock();
  const frames = [];
  const app = main.startApp({
    document, window, storage, clipboard,
    fetch: backend.fetch,
    EventSource: FakeEventSource,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    requestAnimationFrame: (fn) => frames.push(fn),
  });
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  return {
    app, document, window, backend, clock, storage, frames, $, $$,
    byDataId: (id) => $$('[data-id]').find((e) => e.dataset.id === id),
    widgetIds: () => $$('.widget').map((w) => w.dataset.id),
    /** The change stream. */
    stream: () => FakeEventSource.instances.find((source) => source.url === '/api/stream'),
    /** Every log stream opened so far, in order. */
    logStreams: () => FakeEventSource.instances.filter((source) => source.url.endsWith('/logs')),
  };
}

/** The scope parameter of a list request, as "name=value". */
function scopeOf(params) {
  const name = ['namespace', 'cluster', 'nodes', 'parent', 'node'].find((n) => n in params);
  return name ? `${name}=${params[name]}` : 'all';
}

const scopes = (backend) => backend.listRequests().map(scopeOf);

// --- Loading -----------------------------------------------------------------

test('on load the app shows the cluster, its resource types and its areas', async () => {
  const {$, $$} = boot();
  await flush();

  assert.equal($('#cluster-name').textContent, 'kind-kvleva');
  assert.equal($('#cluster-version').textContent, 'v1.35.0');
  assert.deepEqual($$('#pills .pill-count').map((p) => p.textContent), ['9', '1', '0']);
  assert.deepEqual($$('#kind-list .kind-group-name').map((g) => g.textContent),
      ['core', 'apps', 'gateway.networking.k8s.io']);
  assert.equal($$('#kind-list .kind-row').length, 0, 'API groups start collapsed: their types are not listed yet');
  assert.deepEqual($$('#areas > .area').map((a) => a.dataset.id), ['nodes', 'cluster', 'ns:default', 'ns:shop']);
  assert.equal($('#app-error').hidden, true);
});

test('a small cluster starts with nodes and namespaces open and small child lists two levels deep', async () => {
  const {backend, byDataId, widgetIds} = boot();
  await flush();

  assert.deepEqual(scopes(backend).sort(),
      ['namespace=default', 'namespace=shop', 'nodes=true', 'parent=dep-1', 'parent=rs-1']);
  for (const params of backend.listRequests()) {
    assert.equal(params.limit, '100');
    assert.equal(params.offset, '0');
  }
  assert.deepEqual(widgetIds().sort(),
      ['cm-1', 'dep-1', 'gw-1', 'node-1', 'pod-1', 'route-1', 'rs-1', 'svc-1']);
  assert.equal(byDataId('pod-1').parentElement.closest('.widget').dataset.id, 'rs-1');
  assert.equal(byDataId('rs-1').parentElement.closest('.widget').dataset.id, 'dep-1');
  assert.equal(byDataId('cluster').querySelector('.list'), null, 'the cluster-wide area starts closed');
  assert.equal(byDataId('node-1').querySelector('.children'), null, 'nodes start closed');
});

test('child lists with more than ten items are not opened on load', async () => {
  const data = smallCluster();
  data.lists['namespace=default'] = [{...fx.deployment(), childCount: 11}];
  const {backend, widgetIds} = boot({backend: fakeBackend(data)});
  await flush();

  assert.equal(scopes(backend).includes('parent=dep-1'), false);
  assert.deepEqual(widgetIds().sort(), ['dep-1', 'node-1']);
});

test('a large cluster starts closed and loads no lists', async () => {
  const {backend, widgetIds, $$} = boot({backend: fakeBackend(largeCluster())});
  await flush();

  assert.deepEqual(backend.urls(), ['/api/overview']);
  assert.deepEqual(widgetIds(), []);
  assert.equal($$('#areas > .area').length, 4, 'the areas themselves are shown, closed');
});

test('the change stream is opened exactly once', async () => {
  const {stream} = boot();
  await flush();

  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(stream().url, '/api/stream');
});

test('saved filters are restored and applied from the first request on', async () => {
  let saved = filters.defaultFilters();
  saved = filters.setKindHidden(saved, 'core/Secret', true);
  saved = filters.toggleHealth(saved, 'green');
  saved = filters.setQuery(saved, 'web');
  const storage = memoryStorage({'kvleva.filters': filters.serialize(saved)});

  const {backend, $, $$} = boot({storage});
  await flush();

  assert.ok(backend.listRequests().length > 0);
  for (const params of backend.listRequests()) {
    assert.equal(params.hideKinds, 'core/Secret');
    assert.equal(params.health, 'red,yellow');
    assert.equal(params.q, 'web');
  }
  assert.equal($('#search').value, 'web');
  assert.equal(kindBox($$, 'core/Secret').checked, false);
  assert.equal($('#health-filter input[data-health="green"]').checked, false);
});

test('when the backend is unreachable the app says so and recovers on its own', async () => {
  const backend = fakeBackend(smallCluster());
  backend.failWith = 503;
  const {$, clock, widgetIds} = boot({backend});
  await flush();

  assert.equal($('#app-error').hidden, false);
  assert.match($('#app-error').textContent, /backend unavailable/);
  assert.deepEqual(widgetIds(), []);

  backend.failWith = null;
  clock.advance(3000);
  await flush();

  assert.equal($('#app-error').hidden, true);
  assert.equal($('#cluster-name').textContent, 'kind-kvleva');
  assert.ok(widgetIds().includes('pod-1'));
});

// --- Opening, closing, paging ------------------------------------------------

test('opening an area loads and shows its first page; closing it removes it without a request', async () => {
  const {backend, byDataId, widgetIds} = boot();
  await flush();
  backend.forget();

  byDataId('cluster').querySelector('.area-head .toggle').click();
  assert.equal(byDataId('cluster').querySelector('.note').textContent, 'Loading…');
  await flush();

  assert.deepEqual(backend.listRequests(), [{cluster: 'true', limit: '100', offset: '0'}]);
  assert.ok(widgetIds().includes('gc-1'));

  backend.forget();
  byDataId('cluster').querySelector('.area-head .toggle').click();
  await flush();

  assert.equal(widgetIds().includes('gc-1'), false);
  assert.deepEqual(backend.urls(), [], 'closing needs no request');
});

test('opening a node lists the pods scheduled on it', async () => {
  const {backend, byDataId} = boot();
  await flush();
  backend.forget();

  byDataId('node-1').querySelector('.toggle').click();
  await flush();

  assert.deepEqual(backend.listRequests(), [{node: 'kvleva-control-plane', limit: '100', offset: '0'}]);
  const pod = byDataId('node-1').querySelector('.children .widget');
  assert.equal(pod.dataset.id, 'pod-1');
  assert.equal(pod.querySelectorAll('.container').length, 2);
});

test('closing a resource closes what was opened inside it', async () => {
  const {backend, byDataId, widgetIds} = boot();
  await flush();

  byDataId('dep-1').querySelector('.toggle').click();
  await flush();
  assert.equal(widgetIds().includes('rs-1'), false);
  assert.equal(widgetIds().includes('pod-1'), false);

  backend.forget();
  byDataId('dep-1').querySelector('.toggle').click();
  await flush();
  assert.deepEqual(scopes(backend), ['parent=dep-1'], 'reopening loads the children only, not what was nested');
  assert.equal(byDataId('rs-1').querySelector('.toggle').getAttribute('aria-expanded'), 'false');
});

test('Show more appends the next page until the list is complete', async () => {
  const data = smallCluster();
  data.lists['namespace=shop'] = Array.from({length: 250}, (_, i) => fx.summary({uid: `s-${i}`, name: `s-${i}`, namespace: 'shop', path: ['ns:shop']}));
  const {backend, byDataId} = boot({backend: fakeBackend(data)});
  await flush();
  const shop = () => byDataId('ns:shop');

  assert.equal(shop().querySelectorAll('.widget').length, 100);
  assert.equal(shop().querySelector('.more').textContent, 'Show more (150 remaining)');

  backend.forget();
  shop().querySelector('.more').click();
  await flush();
  assert.deepEqual(backend.listRequests(), [{namespace: 'shop', limit: '100', offset: '100'}]);
  assert.equal(shop().querySelectorAll('.widget').length, 200);
  assert.equal(shop().querySelector('.more').textContent, 'Show more (50 remaining)');

  shop().querySelector('.more').click();
  await flush();
  assert.equal(shop().querySelectorAll('.widget').length, 250);
  assert.equal(shop().querySelector('.more'), null);
  assert.equal(shop().querySelectorAll('.widget')[249].dataset.id, 's-249');
});

test('clicking Show more twice while the page loads requests it once', async () => {
  const data = smallCluster();
  data.lists['namespace=shop'] = Array.from({length: 250}, (_, i) => fx.summary({uid: `s-${i}`, name: `s-${i}`}));
  const backend = fakeBackend(data);
  const {byDataId} = boot({backend});
  await flush();
  backend.forget();
  const hold = deferred();
  backend.gate = () => hold.promise;

  byDataId('ns:shop').querySelector('.more').click();
  byDataId('ns:shop').querySelector('.more').click();
  hold.resolve();
  await flush();

  assert.equal(backend.listRequests().length, 1);
  assert.equal(byDataId('ns:shop').querySelectorAll('.widget').length, 200);
});

test('a list that fails to load shows the error while the rest keeps working', async () => {
  const backend = fakeBackend(smallCluster());
  const {byDataId, widgetIds} = boot({backend});
  await flush();

  backend.failWith = 500;
  byDataId('cluster').querySelector('.area-head .toggle').click();
  await flush();
  assert.match(byDataId('cluster').querySelector('.note.error').textContent, /backend unavailable/);
  assert.ok(widgetIds().includes('pod-1'), 'what was loaded stays');

  backend.failWith = null;
  byDataId('cluster').querySelector('.area-head .toggle').click();
  byDataId('cluster').querySelector('.area-head .toggle').click();
  await flush();
  assert.ok(widgetIds().includes('gc-1'), 'closing and reopening retries');
});

test('Expand all opens every area and nothing nested; Collapse all closes everything', async () => {
  const {backend, $, widgetIds} = boot({backend: fakeBackend(largeCluster())});
  await flush();
  backend.forget();

  $('#expand-all').click();
  await flush();
  assert.deepEqual(scopes(backend).sort(), ['cluster=true', 'namespace=default', 'namespace=shop', 'nodes=true']);
  assert.deepEqual(widgetIds().sort(), ['cm-1', 'dep-1', 'gc-1', 'gw-1', 'node-1', 'route-1', 'svc-1']);

  backend.forget();
  $('#collapse-all').click();
  await flush();
  assert.deepEqual(widgetIds(), []);
  assert.deepEqual(backend.urls(), []);
});

// --- Filters -----------------------------------------------------------------

const OPEN_ON_LOAD = ['namespace=default', 'namespace=shop', 'nodes=true', 'parent=dep-1', 'parent=rs-1'];
const groupToggle = ($$, group) => $$('#kind-list button').find((b) => b.dataset.groupToggle === group);
const listedKinds = ($$) => $$('#kind-list .kind-name').map((k) => k.textContent);

/** The checkbox of a resource type. API groups start collapsed, so the group of the type is expanded first. */
function kindBox($$, kindId) {
  const find = () => $$('#kind-list input').find((i) => i.dataset.kindId === kindId);
  if (!find()) groupToggle($$, kindId.split('/')[0]).click();
  return find();
}

test('hiding a resource type refetches every open list with hideKinds and saves the filter', async () => {
  const {backend, storage, $$} = boot();
  await flush();
  backend.forget();

  kindBox($$, 'core/Secret').click();
  await flush();

  assert.deepEqual(scopes(backend).sort(), OPEN_ON_LOAD, 'open lists only: the cluster-wide area is closed');
  for (const params of backend.listRequests()) {
    assert.equal(params.hideKinds, 'core/Secret');
    assert.equal(params.offset, '0');
  }
  assert.deepEqual(filters.loadFilters(storage).hiddenKinds, ['core/Secret']);
  assert.equal(kindBox($$, 'core/Secret').checked, false);
});

test('hiding a whole API group refetches every open list once, without any of its types', async () => {
  const {backend, storage, $$} = boot();
  await flush();
  backend.forget();

  $$('#kind-list input').find((i) => i.dataset.group === 'core').click();
  await flush();

  assert.deepEqual(scopes(backend).sort(), OPEN_ON_LOAD, 'one reload, not one per type');
  for (const params of backend.listRequests()) {
    assert.equal(params.hideKinds, 'core/Pod,core/Secret,core/Service');
  }
  assert.deepEqual(filters.loadFilters(storage).hiddenKinds, ['core/Pod', 'core/Secret', 'core/Service']);
  for (const kindId of ['core/Pod', 'core/Secret', 'core/Service']) assert.equal(kindBox($$, kindId).checked, false);
  assert.equal(kindBox($$, 'apps/Deployment').checked, true);
});

test('after a filter change the canvas shows what the backend returns for it', async () => {
  const data = smallCluster();
  const everything = data.lists['namespace=default'];
  data.lists['namespace=default'] = (params) =>
      (params.hideKinds === 'apps/Deployment' ? everything.filter((i) => i.kind !== 'Deployment') : everything);
  const {$$, widgetIds} = boot({backend: fakeBackend(data)});
  await flush();
  assert.ok(widgetIds().includes('pod-1'));

  kindBox($$, 'apps/Deployment').click();
  await flush();

  assert.deepEqual(widgetIds().sort(), ['cm-1', 'gw-1', 'node-1', 'route-1', 'svc-1'],
      'the deployment is gone and so is what was open inside it');
});

test('clicking a health pill filters every open list by health', async () => {
  const {backend, storage, $, $$} = boot();
  await flush();
  backend.forget();

  $$('#pills .pill')[2].click();
  await flush();

  assert.deepEqual(scopes(backend).sort(), OPEN_ON_LOAD);
  for (const params of backend.listRequests()) assert.equal(params.health, 'yellow,green');
  assert.equal($$('#pills .pill')[2].getAttribute('aria-pressed'), 'false');
  assert.equal($('#health-filter input[data-health="red"]').checked, false);
  assert.deepEqual(filters.loadFilters(storage).health, {green: true, yellow: true, red: false});
});

test('None hides every resource type and All shows them again', async () => {
  const {backend, $, $$} = boot();
  await flush();

  backend.forget();
  $('#kinds-none').click();
  await flush();
  for (const params of backend.listRequests()) {
    assert.equal(params.hideKinds,
        'apps/Deployment,apps/ReplicaSet,core/Pod,core/Secret,core/Service,gateway.networking.k8s.io/Gateway');
  }
  assert.ok($$('#kind-list input').every((i) => !i.checked));

  backend.forget();
  $('#kinds-all').click();
  await flush();
  assert.ok(backend.listRequests().length > 0);
  for (const params of backend.listRequests()) assert.equal('hideKinds' in params, false);
  assert.ok($$('#kind-list input').every((i) => i.checked));
});

test('searching reloads once, 250 ms after the last keystroke', async () => {
  const {backend, clock, storage, $} = boot();
  await flush();
  backend.forget();

  type($('#search'), 'c');
  clock.advance(100);
  type($('#search'), 'ch');
  clock.advance(100);
  type($('#search'), 'CHECK');
  clock.advance(249);
  await flush();
  assert.deepEqual(backend.urls(), [], 'still waiting for the user to stop typing');

  clock.advance(1);
  await flush();
  assert.deepEqual(scopes(backend).sort(), OPEN_ON_LOAD);
  for (const params of backend.listRequests()) assert.equal(params.q, 'CHECK');
  assert.equal(filters.loadFilters(storage).q, 'CHECK');
});

test('a newer filter wins over responses for an older one that arrive late', async () => {
  const data = smallCluster();
  data.lists['namespace=shop'] = (params) => {
    if (params.q === 'old') return [fx.summary({uid: 'old-match', name: 'old'})];
    if (params.q === 'new') return [fx.summary({uid: 'new-match', name: 'new'})];
    return [];
  };
  const backend = fakeBackend(data);
  const {clock, $, byDataId} = boot({backend});
  await flush();
  const slow = deferred();
  backend.gate = (request) => (request.params.q === 'old' ? slow.promise : undefined);

  type($('#search'), 'old');
  clock.advance(250);
  await flush();
  type($('#search'), 'new');
  clock.advance(250);
  await flush();
  slow.resolve();
  await flush();

  assert.deepEqual([...byDataId('ns:shop').querySelectorAll('.widget')].map((w) => w.dataset.id), ['new-match']);
});

// --- Selection and the drawer ------------------------------------------------

test('clicking a widget opens the drawer with its details and highlights the widget', async () => {
  const {backend, $, byDataId} = boot();
  await flush();
  backend.forget();

  byDataId('dep-1').querySelector('.widget-head .name').click();
  assert.equal($('#drawer').hidden, false, 'the drawer opens at once');
  assert.equal($('#drawer-body').textContent, 'Loading…');
  await flush();

  assert.deepEqual(backend.urls(), ['/api/resources/dep-1']);
  assert.equal($('.drawer-name').textContent, 'default/web');
  assert.deepEqual([...$('#drawer-body').querySelectorAll('.section-title')].map((t) => t.textContent),
      ['Configuration', 'Status', 'Events', 'Connections']);
  assert.ok(byDataId('dep-1').classList.contains('selected'));
});

test('clicking a container shows the details of that container', async () => {
  const {backend, $, byDataId} = boot();
  await flush();
  backend.forget();

  byDataId('pod-1').querySelectorAll('.container')[1].click();
  await flush();

  assert.deepEqual(backend.urls(), ['/api/resources/pod-1/containers/app']);
  assert.equal($('.drawer-kind').textContent, 'Container');
  assert.equal($('.drawer-name').textContent, 'app');
  assert.ok(byDataId('pod-1').querySelectorAll('.container')[1].classList.contains('selected'));
  assert.ok(!byDataId('pod-1').classList.contains('selected'));
});

test('clicking a namespace header shows the Namespace object', async () => {
  const {backend, $, byDataId} = boot();
  await flush();
  backend.forget();

  byDataId('ns:shop').querySelector('.area-title').click();
  await flush();

  assert.deepEqual(backend.urls(), [`/api/resources/${fx.UID.nsShop}`]);
  assert.equal($('.drawer-kind').textContent, 'Namespace');
  assert.ok(byDataId('ns:shop').querySelector('.area-title').classList.contains('selected'));
});

test('selecting a resource that no longer exists says so', async () => {
  const backend = fakeBackend(smallCluster());
  delete backend.details['cm-1'];
  const {$, byDataId} = boot({backend});
  await flush();

  byDataId('cm-1').click();
  await flush();

  assert.equal($('#drawer').hidden, false);
  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
});

test('a failed details request shows the error in the drawer', async () => {
  const backend = fakeBackend(smallCluster());
  const {$, byDataId} = boot({backend});
  await flush();
  backend.failWith = 500;

  byDataId('cm-1').click();
  await flush();

  assert.match($('#drawer-body .note.error').textContent, /backend unavailable/);
});

test('the drawer shows the latest selection even when an earlier response arrives late', async () => {
  const backend = fakeBackend(smallCluster());
  const {$, byDataId} = boot({backend});
  await flush();
  const slow = deferred();
  backend.gate = (request) => (request.path === '/api/resources/svc-1' ? slow.promise : undefined);

  byDataId('svc-1').click();
  byDataId('cm-1').click();
  await flush();
  assert.equal($('.drawer-name').textContent, 'default/web-config');

  slow.resolve();
  await flush();
  assert.equal($('.drawer-name').textContent, 'default/web-config');
  assert.ok(byDataId('cm-1').classList.contains('selected'));
  assert.ok(!byDataId('svc-1').classList.contains('selected'));
});

test('Escape and the close button close the drawer and clear the highlight', async () => {
  const {document, $, $$, byDataId} = boot();
  await flush();

  byDataId('cm-1').click();
  await flush();
  fire(document.body, 'keydown', {key: 'Escape'});
  assert.equal($('#drawer').hidden, true);
  assert.equal($$('.selected').length, 0);

  byDataId('cm-1').click();
  await flush();
  $('#drawer-close').click();
  assert.equal($('#drawer').hidden, true);
  assert.equal($$('.selected').length, 0);
});

test('a details response that arrives after the drawer was closed does not reopen it', async () => {
  const backend = fakeBackend(smallCluster());
  const {$, byDataId} = boot({backend});
  await flush();
  const slow = deferred();
  backend.gate = (request) => (request.path === '/api/resources/svc-1' ? slow.promise : undefined);

  byDataId('svc-1').click();
  $('#drawer-close').click();
  slow.resolve();
  await flush();

  assert.equal($('#drawer').hidden, true);
});

test('Copy writes the exact YAML to the clipboard', async () => {
  const written = [];
  const clipboard = {writeText: async (text) => void written.push(text)};
  const {$, byDataId} = boot({clipboard});
  await flush();
  byDataId('dep-1').querySelector('.widget-head .name').click();
  await flush();

  $('.configuration .copy').click();
  await flush();

  assert.deepEqual(written, [fx.detail().yaml]);
  assert.equal($('.configuration .copy').textContent, 'Copied');
});

test('Copy reports failure when the clipboard is unavailable or refuses', async () => {
  for (const clipboard of [undefined, {writeText: async () => { throw new Error('denied'); }}]) {
    const {$, byDataId} = boot({clipboard});
    await flush();
    byDataId('cm-1').click();
    await flush();

    $('.configuration .copy').click();
    await flush();

    assert.equal($('.configuration .copy').textContent, 'Copy failed');
  }
});

// --- Revealing a connected resource ------------------------------------------

const podLink = () => fx.link({
  uid: 'pod-1', kindId: 'core/Pod', kind: 'Pod', name: 'web-7d4b9c-abcde', relation: 'selector',
  health: 'yellow', path: ['ns:default', 'dep-1', 'rs-1'],
});

/** Makes Element.scrollIntoView available (jsdom lacks it) and records its calls. */
function recordScrolls(window) {
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function() {
    scrolled.push(this.dataset.id);
  };
  return scrolled;
}

test('a connection link selects the resource and reveals it by opening the containers on its path', async () => {
  const data = largeCluster();
  data.details['svc-1'] = fx.detail({summary: fx.service(), outgoing: [podLink()], incoming: [], missing: []});
  const backend = fakeBackend(data);
  const {window, $, byDataId, widgetIds} = boot({backend});
  const scrolled = recordScrolls(window);
  await flush();
  byDataId('ns:default').querySelector('.area-head .toggle').click();
  await flush();
  byDataId('svc-1').click();
  await flush();
  assert.equal(widgetIds().includes('pod-1'), false, 'the pod is folded away inside the deployment');
  backend.forget();

  $('.connections button.link').click();
  await flush();

  assert.deepEqual(backend.urls().sort(), [
    '/api/resources/pod-1',
    '/api/resources?parent=dep-1&limit=100&offset=0',
    '/api/resources?parent=rs-1&limit=100&offset=0',
  ]);
  assert.equal(byDataId('pod-1').parentElement.closest('.widget').dataset.id, 'rs-1');
  assert.ok(byDataId('pod-1').classList.contains('selected'));
  assert.ok(byDataId('pod-1').classList.contains('flash'));
  assert.deepEqual(scrolled, ['pod-1']);
  assert.equal($('.drawer-name').textContent, 'default/web-7d4b9c-abcde');
});

test('revealing a resource in a closed namespace opens that namespace', async () => {
  const data = largeCluster();
  data.details['gc-1'] = fx.detail({
    summary: gatewayClass(), outgoing: [], missing: [],
    incoming: [fx.link({uid: 'gw-1', kindId: 'gateway.networking.k8s.io/Gateway', kind: 'Gateway',
                        name: 'gw', relation: 'gatewayClassName', path: ['ns:default']})],
  });
  data.details['gw-1'] = fx.detail({summary: fx.gateway(), outgoing: [], incoming: [], missing: []});
  const backend = fakeBackend(data);
  const {window, $, byDataId} = boot({backend});
  recordScrolls(window);
  await flush();
  byDataId('cluster').querySelector('.area-head .toggle').click();
  await flush();
  byDataId('gc-1').click();
  await flush();
  backend.forget();

  $('.connections button.link').click();
  await flush();

  assert.deepEqual(scopes(backend), ['namespace=default']);
  assert.ok(byDataId('gw-1').classList.contains('flash'));
  assert.ok(byDataId('gw-1').classList.contains('selected'));
});

test('revealing a Node opens the Nodes area, not the cluster-wide area', async () => {
  const data = largeCluster();
  data.lists['namespace=default'] = [fx.pod()];
  data.details['pod-1'] = fx.detail({
    summary: fx.pod(), incoming: [], missing: [],
    outgoing: [fx.link({uid: 'node-1', kindId: 'core/Node', kind: 'Node', namespace: '',
                        name: 'kvleva-control-plane', relation: 'nodeName', path: ['cluster']})],
  });
  data.details['node-1'] = fx.detail({summary: fx.node(), outgoing: [], incoming: [], missing: []});
  const backend = fakeBackend(data);
  const {window, $, byDataId} = boot({backend});
  recordScrolls(window);
  await flush();
  byDataId('ns:default').querySelector('.area-head .toggle').click();
  await flush();
  byDataId('pod-1').querySelector('.widget-head .name').click();
  await flush();
  backend.forget();

  $('.connections button.link').click();
  await flush();

  assert.deepEqual(scopes(backend), ['nodes=true']);
  assert.ok(byDataId('node-1').classList.contains('flash'));
});

test('revealing loads further pages of a list until the resource is found', async () => {
  const data = largeCluster();
  const many = Array.from({length: 250}, (_, i) => fx.summary({uid: `cm-${i}`, name: `cm-${i}`}));
  data.lists['namespace=default'] = [fx.service(), ...many];
  data.details['svc-1'] = fx.detail({
    summary: fx.service(), incoming: [], missing: [],
    outgoing: [fx.link({uid: 'cm-180', name: 'cm-180', relation: 'ref'})],
  });
  data.details['cm-180'] = fx.detail({summary: many[180], outgoing: [], incoming: [], missing: []});
  const backend = fakeBackend(data);
  const {window, $, byDataId} = boot({backend});
  recordScrolls(window);
  await flush();
  byDataId('ns:default').querySelector('.area-head .toggle').click();
  await flush();
  byDataId('svc-1').click();
  await flush();
  backend.forget();

  $('.connections button.link').click();
  await flush();

  assert.deepEqual(backend.listRequests().map((p) => p.offset), ['100'], 'one more page was enough');
  assert.ok(byDataId('cm-180').classList.contains('flash'));
  assert.equal(byDataId('ns:default').querySelector('.more').textContent, 'Show more (51 remaining)');
});

test('revealing something the filters hide falls back to its nearest shown ancestor', async () => {
  const data = largeCluster();
  data.details['svc-1'] = fx.detail({
    summary: fx.service(), incoming: [], missing: [],
    outgoing: [fx.link({uid: 'ghost', name: 'ghost', namespace: 'shop', relation: 'ref', path: ['ns:shop']})],
  });
  const backend = fakeBackend(data);
  const {window, $, byDataId} = boot({backend});
  const scrolled = recordScrolls(window);
  await flush();
  byDataId('ns:default').querySelector('.area-head .toggle').click();
  await flush();
  byDataId('svc-1').click();
  await flush();

  $('.connections button.link').click();
  await flush();

  assert.ok(byDataId('ns:shop').classList.contains('flash'));
  assert.deepEqual(scrolled, ['ns:shop']);
  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
});

test('the container drawer links back to its pod', async () => {
  const {window, backend, $, byDataId} = boot();
  recordScrolls(window);
  await flush();
  byDataId('pod-1').querySelectorAll('.container')[1].click();
  await flush();
  backend.forget();

  $('.drawer-head button.link').click();
  await flush();

  assert.deepEqual(backend.urls(), ['/api/resources/pod-1']);
  assert.equal($('.drawer-kind').textContent, 'Pod');
  assert.ok(byDataId('pod-1').classList.contains('selected'));
  assert.ok(byDataId('pod-1').classList.contains('flash'));
});

// --- Live updates ------------------------------------------------------------

const overviewRequests = (backend) => backend.urls().filter((u) => u === '/api/overview').length;

test('a change event refreshes the overview and every open list 500 ms later', async () => {
  const {backend, clock, stream, $$, byDataId} = boot();
  await flush();
  backend.forget();
  backend.overview = fx.overview({health: fx.rollup(8, 1, 1), revision: 1043});
  backend.lists['parent=rs-1'] = [{...fx.pod(), health: 'red', reason: 'CrashLoopBackOff'}];

  stream().change(fx.change({changed: ['pod-1']}));
  clock.advance(499);
  await flush();
  assert.deepEqual(backend.urls(), [], 'debounced');
  clock.advance(1);
  await flush();

  assert.equal(overviewRequests(backend), 1);
  assert.deepEqual(scopes(backend).sort(), OPEN_ON_LOAD, 'only open lists; the cluster-wide area is closed');
  for (const params of backend.listRequests()) {
    assert.deepEqual([params.limit, params.offset], ['100', '0']);
  }
  assert.deepEqual($$('#pills .pill-count').map((p) => p.textContent), ['8', '1', '1']);
  assert.ok(byDataId('pod-1').classList.contains('health-red'));
  assert.equal(byDataId('pod-1').querySelector('.reason').textContent, 'CrashLoopBackOff');
});

test('a refresh keeps what is open, how much is loaded, the selection and the drawer', async () => {
  const data = smallCluster();
  data.lists['namespace=shop'] = Array.from({length: 250}, (_, i) => fx.summary({uid: `s-${i}`, name: `s-${i}`}));
  const backend = fakeBackend(data);
  const {clock, stream, $, byDataId, widgetIds} = boot({backend});
  await flush();
  byDataId('ns:shop').querySelector('.more').click();
  await flush();
  byDataId('cm-1').click();
  await flush();
  backend.forget();

  stream().change(fx.change({changed: ['something-else']}));
  clock.advance(500);
  await flush();

  const shop = backend.listRequests().filter((p) => p.namespace === 'shop');
  assert.deepEqual(shop, [{namespace: 'shop', limit: '200', offset: '0'}], 'the two loaded pages are re-requested');
  assert.equal(byDataId('ns:shop').querySelectorAll('.widget').length, 200);
  assert.equal(byDataId('ns:shop').querySelector('.more').textContent, 'Show more (50 remaining)');
  assert.ok(widgetIds().includes('pod-1'), 'the rollout is still open');
  assert.equal(byDataId('cluster').querySelector('.list'), null, 'the closed area is still closed');
  assert.ok(byDataId('cm-1').classList.contains('selected'));
  assert.equal($('.drawer-name').textContent, 'default/web-config');
  assert.equal(backend.urls().includes('/api/resources/cm-1'), false, 'the drawer resource did not change');
});

test('a refresh keeps the keyboard focus and the scroll position', async () => {
  const {backend, clock, stream, document, $, byDataId} = boot();
  await flush();
  byDataId('pod-1').querySelectorAll('.container')[1].focus();
  $('#canvas').scrollTop = 240;
  // Emulate a browser that loses the offset while the content is swapped.
  const areas = $('#areas');
  const realReplace = areas.replaceChildren.bind(areas);
  areas.replaceChildren = (...nodes) => {
    $('#canvas').scrollTop = 0;
    realReplace(...nodes);
  };
  backend.lists['parent=rs-1'] = [{...fx.pod(), health: 'red', reason: 'CrashLoopBackOff'}];

  stream().change(fx.change({changed: ['pod-1']}));
  clock.advance(500);
  await flush();

  assert.ok(byDataId('pod-1').classList.contains('health-red'), 'the refresh happened and rebuilt the pod');
  assert.equal(document.activeElement.dataset.container, 'app');
  assert.ok(document.activeElement.isConnected);
  assert.equal($('#canvas').scrollTop, 240);
});

test('the drawer is refetched when its resource changed', async () => {
  const {backend, clock, stream, $, byDataId} = boot();
  await flush();
  byDataId('dep-1').querySelector('.widget-head .name').click();
  await flush();
  backend.forget();
  backend.details['dep-1'] = fx.detail({summary: {...fx.deployment(), health: 'green', reason: 'Available'}});

  stream().change(fx.change({changed: ['pod-1', 'dep-1']}));
  clock.advance(500);
  await flush();

  assert.equal(backend.urls().filter((u) => u === '/api/resources/dep-1').length, 1);
  assert.equal($('.drawer-head .badge').textContent, '● Healthy');
  assert.equal($('.drawer-head .drawer-reason').textContent, 'Available');
});

test('the drawer is refetched when too much changed to list', async () => {
  const {backend, clock, stream, byDataId} = boot();
  await flush();
  byDataId('dep-1').querySelector('.widget-head .name').click();
  await flush();
  backend.forget();

  stream().change(fx.change({overflow: true}));
  clock.advance(500);
  await flush();

  assert.equal(backend.urls().filter((u) => u === '/api/resources/dep-1').length, 1);
  assert.equal(overviewRequests(backend), 1);
});

test('a selected container is refetched when its pod changed', async () => {
  const {backend, clock, stream, $, byDataId} = boot();
  await flush();
  byDataId('pod-1').querySelectorAll('.container')[1].click();
  await flush();
  backend.forget();
  const running = fx.containerDetail();
  running.container = {...running.container, health: 'green', state: 'running', reason: ''};
  backend.containers['pod-1/app'] = running;

  stream().change(fx.change({changed: ['pod-1']}));
  clock.advance(500);
  await flush();

  assert.equal(backend.urls().filter((u) => u === '/api/resources/pod-1/containers/app').length, 1);
  assert.equal($('.drawer-head .badge').textContent, '● Healthy');
});

test('the drawer says so when its resource was deleted', async () => {
  const {backend, clock, stream, $, byDataId} = boot();
  await flush();
  byDataId('cm-1').click();
  await flush();
  backend.forget();
  backend.lists['namespace=default'] = backend.lists['namespace=default'].filter((i) => i.uid !== 'cm-1');

  stream().change(fx.change({deleted: ['cm-1']}));
  clock.advance(500);
  await flush();

  assert.equal($('#drawer').hidden, false);
  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
  assert.equal(backend.urls().includes('/api/resources/cm-1'), false);
  assert.equal(byDataId('cm-1'), undefined, 'and its widget is gone');
});

test('a burst of change events causes one refresh, and refreshes start at least 2 s apart', async () => {
  const {backend, clock, stream} = boot();
  await flush();
  backend.forget();

  stream().change(fx.change({revision: 1043, changed: ['a']}));
  clock.advance(200);
  stream().change(fx.change({revision: 1044, changed: ['b']}));
  clock.advance(500);
  await flush();
  assert.equal(overviewRequests(backend), 1);

  stream().change(fx.change({revision: 1045, changed: ['c']}));
  clock.advance(1999);
  await flush();
  assert.equal(overviewRequests(backend), 1, 'less than 2 s after the previous refresh started');
  clock.advance(1);
  await flush();
  assert.equal(overviewRequests(backend), 2);
});

test('the change event sent right after connecting carries nothing new and refetches nothing', async () => {
  const {backend, clock, stream} = boot();
  await flush();
  backend.forget();

  stream().change({revision: 1042, changed: [], deleted: [], overflow: false});
  clock.advance(10000);
  await flush();

  assert.deepEqual(backend.urls(), []);
});

test('a refresh closes lists whose container disappeared and stops refetching them', async () => {
  const {backend, clock, stream, widgetIds} = boot();
  await flush();
  backend.lists['namespace=default'] = [fx.configMap()];

  stream().change(fx.change({revision: 1043, deleted: ['dep-1', 'rs-1', 'pod-1']}));
  clock.advance(500);
  await flush();
  assert.deepEqual(widgetIds().sort(), ['cm-1', 'node-1']);

  backend.forget();
  stream().change(fx.change({revision: 1044, changed: ['cm-1']}));
  clock.advance(2000);
  await flush();
  assert.deepEqual(scopes(backend).sort(), ['namespace=default', 'namespace=shop', 'nodes=true']);
});

test('a deleted namespace disappears together with its list', async () => {
  const {backend, clock, stream, $$} = boot();
  await flush();
  const overview = fx.overview({health: fx.rollup(2, 0, 0), revision: 1043});
  overview.namespaces = overview.namespaces.filter((ns) => ns.name === 'shop');
  backend.overview = overview;

  stream().change(fx.change({revision: 1043, deleted: [fx.UID.nsDefault]}));
  clock.advance(500);
  await flush();
  assert.deepEqual($$('#areas > .area').map((a) => a.dataset.id), ['nodes', 'cluster', 'ns:shop']);

  backend.forget();
  stream().change(fx.change({revision: 1044, changed: ['x']}));
  clock.advance(2000);
  await flush();
  assert.deepEqual(scopes(backend).sort(), ['namespace=shop', 'nodes=true']);
});

test('the header says reconnecting while the stream is down and the app catches up when it is back', async () => {
  const {backend, clock, stream, $, byDataId} = boot();
  await flush();
  byDataId('cm-1').click();
  await flush();

  stream().emit('error');
  assert.equal($('#stream').textContent, 'reconnecting…');
  assert.equal(FakeEventSource.instances.length, 1, 'EventSource retries by itself; no second stream is opened');

  backend.forget();
  stream().emit('open');
  assert.equal($('#stream').textContent, '');
  clock.advance(500);
  await flush();

  assert.equal(overviewRequests(backend), 1, 'changes may have been missed: refetch what is shown');
  assert.deepEqual(scopes(backend).sort(), OPEN_ON_LOAD);
  assert.equal(backend.urls().filter((u) => u === '/api/resources/cm-1').length, 1, 'including the drawer');
});

test('connecting for the first time does not trigger a catch-up refresh', async () => {
  const {backend, clock, stream} = boot();
  await flush();
  backend.forget();

  stream().emit('open');
  clock.advance(10000);
  await flush();

  assert.deepEqual(backend.urls(), []);
});

test('a failed refresh keeps what is shown and the next change tries again', async () => {
  const {backend, clock, stream, $$, byDataId, widgetIds} = boot();
  await flush();
  const before = widgetIds();
  backend.failWith = 503;

  stream().change(fx.change({revision: 1043, changed: ['pod-1']}));
  clock.advance(500);
  await flush();
  assert.deepEqual(widgetIds(), before, 'nothing is thrown away');
  assert.deepEqual($$('#pills .pill-count').map((p) => p.textContent), ['9', '1', '0']);
  assert.ok($$('.list .note.error').length > 0, 'the lists say that they could not be refreshed');

  backend.failWith = null;
  backend.lists['parent=rs-1'] = [{...fx.pod(), health: 'green', reason: 'Running'}];
  stream().change(fx.change({revision: 1044, changed: ['pod-1']}));
  clock.advance(2000);
  await flush();
  assert.ok(byDataId('pod-1').classList.contains('health-green'));
  assert.equal($$('.list .note.error').length, 0);
});

// --- Live logs -----------------------------------------------------------------

const selectDeployment = ({byDataId}) => byDataId('dep-1').querySelector('.widget-head .name').click();
const selectPod = ({byDataId}) => byDataId('pod-1').click();
const selectContainer = ({byDataId}) => byDataId('pod-1').querySelectorAll('.container')[1].click();

/** Starts the app, selects something (the Deployment unless told otherwise) and switches to its live logs. */
async function viewingLogs(select = selectDeployment, options = {}) {
  const ctx = boot(options);
  await flush();
  select(ctx);
  await flush();
  ctx.backend.forget();
  ctx.$('#drawer-body .view-logs').click();
  return ctx;
}

const shown = (element) => element.closest('[hidden]') === null;
const logTexts = ($$) => $$('#logs-lines .log-text').map((e) => e.textContent);
const logSources = ($$) => $$('#logs-lines > *').map((e) => e.querySelector('.log-source')?.textContent ?? null);
const openLogStreams = (logStreams) => logStreams().filter((source) => !source.closed);

test('View Live Logs opens one log stream for the selected resource and fetches nothing', async () => {
  const {backend, logStreams, $, $$} = await viewingLogs();
  await flush();

  assert.deepEqual(logStreams().map((source) => source.url), ['/api/resources/dep-1/logs']);
  assert.equal(logStreams()[0].closed, false);
  assert.equal(FakeEventSource.instances.length, 2, 'the change stream and the one log stream');
  assert.deepEqual(backend.urls(), [], 'no list, no overview and no details are fetched for it');
  assert.equal(shown($('#logs')), true);
  assert.equal($('#logs-status').textContent, 'Connecting…');
  assert.equal($('#logs-empty').textContent, 'No log lines yet.');
  assert.equal(shown($('#logs-empty')), true);
  assert.equal($('.drawer-name').textContent, 'default/web', 'the header stays');
  assert.equal($$('#drawer-body .section').length, 0, 'the sections make room');
});

test('View Live Logs on a container opens the log stream of that container', async () => {
  const {backend, logStreams, $} = await viewingLogs(selectContainer);

  assert.deepEqual(logStreams().map((source) => source.url), ['/api/resources/pod-1/containers/app/logs']);
  assert.deepEqual(backend.urls(), []);
  assert.equal($('.drawer-kind').textContent, 'Container');
  assert.equal(shown($('#logs')), true);
});

test('lines appear as the log stream delivers them, and the logs are live from the first event on', async () => {
  const {backend, logStreams, $, $$} = await viewingLogs();
  const [source] = logStreams();

  source.logs(fx.logBatch([fx.logLine({text: 'one'})]));
  assert.equal($('#logs-status').textContent, 'Live');
  assert.deepEqual(logTexts($$), ['one']);
  assert.equal(shown($('#logs-empty')), false);

  source.logs(fx.logBatch(
      [fx.logLine({pod: 'web-7d4b9c-fghij', container: 'sidecar', text: 'two'})],
      [fx.logNotice({message: 'is waiting to start: ContainerCreating'})]));
  assert.deepEqual(logTexts($$), ['one', 'two', 'is waiting to start: ContainerCreating']);
  assert.deepEqual(logSources($$), ['web-7d4b9c-abcde/app', 'web-7d4b9c-fghij/sidecar', 'web-7d4b9c-abcde/sidecar'],
      'the lines of a deployment say which pod and container wrote them');
  assert.deepEqual(backend.urls(), [], 'lines arrive on the stream; nothing is fetched');
  assert.equal(logStreams().length, 1);
});

test('the logs of a pod name the container of every line, the logs of a container name nothing', async () => {
  const pod = await viewingLogs(selectPod);
  assert.deepEqual(pod.logStreams().map((source) => source.url), ['/api/resources/pod-1/logs']);
  pod.logStreams()[0].logs(fx.logBatch([fx.logLine({container: 'app'}), fx.logLine({container: 'migrate'})]));
  assert.deepEqual(logSources(pod.$$), ['app', 'migrate']);

  const container = await viewingLogs(selectContainer);
  container.logStreams()[0].logs(fx.logBatch([fx.logLine({container: 'app'})]));
  assert.deepEqual(logSources(container.$$), [null]);
});

test('a log stream that is open but has nothing to deliver yet is live, with no lines', async () => {
  const {logStreams, $} = await viewingLogs();

  logStreams()[0].emit('open');

  assert.equal($('#logs-status').textContent, 'Live');
  assert.equal(shown($('#logs-empty')), true);
});

test('a log event that is not the documented JSON is ignored and the logs go on', async () => {
  const {logStreams, $, $$} = await viewingLogs();
  const [source] = logStreams();

  source.emit('logs', {data: '{not json'});
  assert.equal($('#logs-status').textContent, 'Connecting…');
  source.logs(fx.logBatch([fx.logLine({text: 'still here'})]));

  assert.deepEqual(logTexts($$), ['still here']);
  assert.equal(source.closed, false);
});

test('Details returns to the details and closes the log stream, without fetching anything', async () => {
  const {backend, logStreams, $, $$} = await viewingLogs();
  logStreams()[0].logs(fx.logBatch());

  $('#logs-back').click();
  await flush();

  assert.equal(logStreams()[0].closed, true);
  assert.equal(shown($('#logs')), false);
  assert.deepEqual($$('#drawer-body .section-title').map((t) => t.textContent),
      ['Configuration', 'Status', 'Events', 'Connections']);
  assert.equal($('#drawer-body .view-logs').textContent, 'View Live Logs');
  assert.deepEqual(backend.urls(), [], 'the details were still there');
  assert.equal(logStreams().length, 1);
});

for (const [what, act] of [
  ['selecting another resource', ({byDataId}) => byDataId('cm-1').click()],
  ['selecting a container', selectContainer],
  ['selecting the same resource again', selectDeployment],
  ['following a connection', ({$$}) => $$('#drawer-body button.link')[0]?.click()],
  ['the close button of the details panel', ({$}) => $('#drawer-close').click()],
  ['Escape', ({document}) => fire(document.body, 'keydown', {key: 'Escape'})],
  ['stopping the app', ({app}) => app.stop()],
]) {
  test(`${what} closes the log stream`, async () => {
    // A container links back to its pod even while its logs are shown.
    const ctx = await viewingLogs(what === 'following a connection' ? selectContainer : selectDeployment);
    const [source] = ctx.logStreams();
    assert.equal(source.closed, false);

    act(ctx);
    await flush();

    assert.equal(source.closed, true, 'no more log lines are requested from the cluster');
    assert.equal(ctx.logStreams().length, 1, 'and no other log stream is opened');
    if (what !== 'stopping the app') assert.equal(shown(ctx.$('#logs')), false);
  });
}

test('when the resource is deleted the log stream is closed and what was logged stays readable', async () => {
  const {backend, clock, stream, logStreams, $, $$} = await viewingLogs();
  logStreams()[0].logs(fx.logBatch([fx.logLine({text: 'last words'})]));
  backend.lists['namespace=default'] = backend.lists['namespace=default'].filter((i) => i.uid !== 'dep-1');

  stream().change(fx.change({deleted: ['dep-1']}));
  clock.advance(500);
  await flush();

  assert.equal(logStreams()[0].closed, true);
  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
  assert.equal(shown($('#logs')), true);
  assert.deepEqual(logTexts($$), ['last words']);
  assert.equal($('#logs-status').textContent, 'The log stream ended.');
  assert.equal(shown($('#logs-restart')), false, 'there is nothing left to follow');
  assert.equal(logStreams().length, 1);

  $('#logs-back').click();
  assert.equal(shown($('#logs')), false);
  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
});

test('when a refresh finds the resource gone the log stream is closed as well', async () => {
  const {backend, clock, stream, logStreams, $} = await viewingLogs();
  delete backend.details['dep-1'];

  stream().change(fx.change({changed: ['dep-1']}));
  clock.advance(500);
  await flush();

  assert.equal($('#drawer-body').textContent, 'This resource no longer exists.');
  assert.equal(logStreams()[0].closed, true);
  assert.equal($('#logs-status').textContent, 'The log stream ended.');
  assert.equal(shown($('#logs-restart')), false);
});

test('a log stream that fails is closed and said to have ended; View Live Logs starts a new one', async () => {
  const {backend, logStreams, $, $$} = await viewingLogs();
  const [first] = logStreams();
  first.logs(fx.logBatch([fx.logLine({text: 'before the break'})]));

  first.emit('error');

  assert.equal(first.closed, true, 'it must not reconnect by itself: that would repeat lines');
  assert.equal($('#logs-status').textContent, 'The log stream ended.');
  assert.equal(shown($('#logs-restart')), true);
  assert.deepEqual(logTexts($$), ['before the break'], 'what was logged stays');
  assert.equal(logStreams().length, 1);

  $('#logs-restart').click();

  assert.deepEqual(logStreams().map((source) => [source.url, source.closed]),
      [['/api/resources/dep-1/logs', true], ['/api/resources/dep-1/logs', false]]);
  assert.equal($('#logs-status').textContent, 'Connecting…');
  assert.deepEqual(logTexts($$), [], 'the new stream sends the recent lines again');
  assert.equal(shown($('#logs-restart')), false);

  logStreams()[1].logs(fx.logBatch([fx.logLine({text: 'before the break'}), fx.logLine({text: 'after it'})]));
  assert.deepEqual(logTexts($$), ['before the break', 'after it']);
  assert.deepEqual(backend.urls(), []);
});

test('there is never more than one open log stream', async () => {
  const ctx = await viewingLogs();
  const {logStreams, $} = ctx;
  assert.equal(openLogStreams(logStreams).length, 1);

  selectPod(ctx);
  await flush();
  assert.equal(openLogStreams(logStreams).length, 0);
  $('#drawer-body .view-logs').click();
  assert.deepEqual(openLogStreams(logStreams).map((source) => source.url), ['/api/resources/pod-1/logs']);

  selectContainer(ctx);
  await flush();
  $('#drawer-body .view-logs').click();
  assert.deepEqual(openLogStreams(logStreams).map((source) => source.url),
      ['/api/resources/pod-1/containers/app/logs']);
  assert.equal(logStreams().length, 3);
});

test('starting the logs again while their stream is still open replaces that stream', async () => {
  const {logStreams, $, $$} = await viewingLogs();
  logStreams()[0].logs(fx.logBatch([fx.logLine({text: 'one'})]));

  // The control is hidden while the logs are live; one stream at a time must
  // hold even if it is activated all the same.
  $('#logs-restart').click();

  assert.deepEqual(logStreams().map((source) => source.closed), [true, false]);
  assert.deepEqual(logTexts($$), []);
  assert.equal($('#logs-status').textContent, 'Connecting…');
});

test('what a closed log stream still delivers is not shown in the next log', async () => {
  const ctx = await viewingLogs();
  const {logStreams, $, $$} = ctx;
  const [old] = logStreams();
  selectPod(ctx);
  await flush();
  $('#drawer-body .view-logs').click();

  old.logs(fx.logBatch([fx.logLine({text: 'from the deployment'})]));
  old.emit('error');

  assert.deepEqual(logTexts($$), []);
  assert.equal($('#logs-status').textContent, 'Connecting…');
  assert.equal(logStreams()[1].closed, false);
});

test('a refresh of the details keeps the log lines, the logs view and the open log stream', async () => {
  const {backend, clock, stream, logStreams, $, $$} = await viewingLogs();
  logStreams()[0].logs(fx.logBatch([fx.logLine({text: 'one'}), fx.logLine({text: 'two'})], [fx.logNotice()]));
  const before = $$('#logs-lines > *');
  backend.details['dep-1'] = fx.detail({summary: {...fx.deployment(), health: 'green', reason: 'Available'}});

  stream().change(fx.change({changed: ['dep-1']}));
  clock.advance(500);
  await flush();

  assert.equal(backend.urls().filter((u) => u === '/api/resources/dep-1').length, 1, 'the details were refetched');
  assert.equal($('.drawer-head .badge').textContent, '● Healthy', 'and the header shows the new health');
  assert.equal($('.drawer-head .drawer-reason').textContent, 'Available');
  assert.equal(shown($('#logs')), true, 'the logs stay open');
  assert.equal($$('#drawer-body .section').length, 0);
  assert.deepEqual($$('#logs-lines > *'), before, 'the very same lines are still shown');
  assert.equal($('#logs-status').textContent, 'Live');
  assert.equal(logStreams().length, 1, 'the stream was not started again');
  assert.equal(logStreams()[0].closed, false);

  logStreams()[0].logs(fx.logBatch([fx.logLine({text: 'three'})]));
  assert.deepEqual(logTexts($$).slice(-2), [fx.logNotice().message, 'three'], 'and the stream keeps adding to them');
});

test('when a refresh says logs are no longer available, the log stays and the server ends its stream', async () => {
  const {backend, clock, stream, logStreams, $, $$} = await viewingLogs();
  logStreams()[0].logs(fx.logBatch([fx.logLine({text: 'one'})]));
  backend.details['dep-1'] = fx.detail({logs: fx.logs(0)});

  stream().change(fx.change({changed: ['dep-1']}));
  clock.advance(500);
  await flush();

  assert.equal(shown($('#logs')), true);
  assert.deepEqual(logTexts($$), ['one']);
  assert.equal(logStreams()[0].closed, false, 'the server ends the stream when the resource is gone');
  assert.equal(logStreams().length, 1);

  logStreams()[0].emit('error');
  assert.equal($('#logs-status').textContent, 'The log stream ended.');
  assert.equal(shown($('#logs-restart')), false, 'logs that are not available cannot be started again');
});

test('a details refresh that fails leaves the logs and their stream alone', async () => {
  const {backend, clock, stream, logStreams, $, $$} = await viewingLogs();
  logStreams()[0].logs(fx.logBatch([fx.logLine({text: 'one'})]));
  backend.failWith = 500;

  stream().change(fx.change({changed: ['dep-1']}));
  clock.advance(500);
  await flush();

  assert.match($('#drawer-body .note.error').textContent, /backend unavailable/);
  assert.equal(shown($('#logs')), true);
  assert.deepEqual(logTexts($$), ['one']);
  assert.equal(logStreams()[0].closed, false);
});

test('a large workload says how many of its pods the logs follow', async () => {
  const data = smallCluster();
  data.details['dep-1'] = fx.detail({logs: fx.logs(10, 23)});
  const {$} = await viewingLogs(selectDeployment, {backend: fakeBackend(data)});

  assert.equal(shown($('#logs-pods')), true);
  assert.equal($('#logs-pods').textContent, 'Logs of 10 of 23 pods');
});

test('a resource without logs offers no View Live Logs, and the logs view controls open nothing for it', async () => {
  const {document, logStreams, $, $$, byDataId} = boot();
  await flush();

  // Nothing is selected yet: the controls exist in the page, hidden.
  $('#logs-restart').click();
  $('#logs-back').click();
  byDataId('cm-1').click();
  await flush();
  assert.equal($$('#drawer .view-logs').filter(shown).length, 0, 'a ConfigMap has no logs');
  $('#logs-restart').click();
  $('#logs-back').click();
  fire(document.body, 'keydown', {key: 'Escape'});

  assert.equal(logStreams().length, 0);
  assert.equal(FakeEventSource.instances.length, 1, 'only the change stream');
  assert.equal(shown($('#logs')), false);
});

test('View Live Logs is offered again after the logs of a resource were closed with the panel', async () => {
  const ctx = await viewingLogs();
  const {logStreams, $, $$} = ctx;
  logStreams()[0].logs(fx.logBatch([fx.logLine({text: 'one'})]));
  $('#drawer-close').click();

  selectDeployment(ctx);
  await flush();

  assert.equal(shown($('#logs')), false, 'the details come first again');
  assert.deepEqual(logTexts($$), []);
  assert.equal($('#drawer-body .view-logs').textContent, 'View Live Logs');
  assert.equal(logStreams().length, 1);
});

// --- Live logs: the filter -----------------------------------------------------

const WRITTEN = ['GET /healthz 200', 'ERROR disk full', 'error: retrying a.b', 'saved axb'];
const shownLogLines = ($$) =>
    $$('#logs-lines > .log-line').filter(shown).map((line) => line.querySelector('.log-text').textContent);

/** The live logs of the pod, after it wrote the four lines of the feature file. */
async function filteringLogs() {
  const ctx = await viewingLogs(selectPod);
  ctx.logStreams()[0].logs(fx.logBatch(WRITTEN.map((text) => fx.logLine({text}))));
  ctx.backend.forget();
  return ctx;
}

test('filtering the log asks the cluster for nothing, saves nothing and leaves the log stream as it is', async () => {
  const {backend, clock, storage, logStreams, $, $$} = await filteringLogs();
  const saved = new Map(storage.data);

  type($('#logs-filter'), 'error');
  type($('#logs-filter'), '/^ERROR|200$/');
  type($('#logs-filter'), '/(/');
  type($('#logs-filter'), 'error');
  clock.advance(5000);
  await flush();

  assert.deepEqual(shownLogLines($$), ['ERROR disk full', 'error: retrying a.b']);
  assert.equal($('#logs-filter-status').textContent, 'Showing 2 of 4 lines');
  assert.deepEqual(backend.urls(), [], 'the filter narrows what the page already holds');
  assert.deepEqual(FakeEventSource.instances.map((source) => source.url), ['/api/stream', '/api/resources/pod-1/logs']);
  assert.equal(logStreams()[0].closed, false);
  assert.equal($('#logs-status').textContent, 'Live');
  assert.deepEqual(new Map(storage.data), saved, 'the filter is not remembered');
});

test('lines that the log stream delivers after a filter was entered are filtered too', async () => {
  const {logStreams, $, $$} = await filteringLogs();
  type($('#logs-filter'), 'error');

  logStreams()[0].logs(fx.logBatch([fx.logLine({text: '200 OK'}), fx.logLine({text: 'fatal error'})],
      [fx.logNotice({message: 'is waiting to start'})]));

  assert.deepEqual(shownLogLines($$), ['ERROR disk full', 'error: retrying a.b', 'fatal error']);
  assert.equal($('#logs-filter-status').textContent, 'Showing 3 of 6 lines');
  assert.equal(shown($('#logs-lines > .log-notice')), true, 'what the app reports is never filtered away');
});

test('the filter belongs to one look at the logs: after Details the logs start unfiltered', async () => {
  const {logStreams, $, $$} = await filteringLogs();
  type($('#logs-filter'), 'error');

  $('#logs-back').click();
  $('#drawer-body .view-logs').click();

  assert.equal($('#logs-filter').value, '');
  logStreams()[1].logs(fx.logBatch(WRITTEN.map((text) => fx.logLine({text}))));
  assert.deepEqual(shownLogLines($$), WRITTEN);
  assert.equal($('#logs-filter-status').textContent, '');
});

test('the filter is gone when the logs of another resource are viewed', async () => {
  const ctx = await filteringLogs();
  const {$} = ctx;
  type($('#logs-filter'), 'error');

  selectDeployment(ctx);
  await flush();
  $('#drawer-body .view-logs').click();

  assert.equal($('#logs-filter').value, '');
  assert.equal($('#logs-filter-status').textContent, '');
});

test('the filter stays through a refresh of the details and through a restart of the stream', async () => {
  const {clock, stream, logStreams, $, $$} = await filteringLogs();
  type($('#logs-filter'), 'error');

  stream().change(fx.change({changed: ['pod-1']}));
  clock.advance(500);
  await flush();
  assert.equal($('#logs-filter').value, 'error');
  assert.deepEqual(shownLogLines($$), ['ERROR disk full', 'error: retrying a.b']);

  logStreams()[0].emit('error');
  $('#logs-restart').click();
  assert.equal($('#logs-filter').value, 'error');
  logStreams()[1].logs(fx.logBatch(WRITTEN.map((text) => fx.logLine({text}))));
  assert.deepEqual(shownLogLines($$), ['ERROR disk full', 'error: retrying a.b']);
});

test('Escape in the filter field clears the filter first; only then does it close the panel and the stream', async () => {
  const {backend, logStreams, $, $$} = await filteringLogs();
  type($('#logs-filter'), 'error');

  fire($('#logs-filter'), 'keydown', {key: 'Escape'});

  assert.equal($('#drawer').hidden, false);
  assert.equal(logStreams()[0].closed, false, 'the log is still followed');
  assert.equal($('#logs-filter').value, '');
  assert.deepEqual(shownLogLines($$), WRITTEN);

  fire($('#logs-filter'), 'keydown', {key: 'Escape'});

  assert.equal($('#drawer').hidden, true);
  assert.equal(logStreams()[0].closed, true);
  assert.deepEqual(backend.urls(), []);
});

// --- System resources switch ---------------------------------------------------

/**
 * A backend whose answers depend on the switch: with system resources on, the
 * overview also lists the kube-system namespace.
 */
function clusterWithSystemNamespace() {
  const data = smallCluster();
  const user = fx.overview({health: fx.rollup(9, 1, 0), systemResources: 80});
  const everything = {
    ...user,
    health: fx.rollup(89, 1, 0),
    // Sorted by name, as the backend sends them.
    namespaces: [
      user.namespaces[0],
      {name: 'kube-system', uid: 'ns-kube-system-uid', health: 'green', reason: 'Active', count: 80,
       rollup: fx.rollup(80, 0, 0)},
      user.namespaces[1],
    ],
  };
  data.overview = (params) => (params.system === 'true' ? everything : user);
  data.lists['namespace=kube-system'] = [fx.summary({uid: 'dns-1', name: 'coredns', namespace: 'kube-system',
                                                     path: ['ns:kube-system']})];
  return data;
}

const areaIds = ($$) => $$('#areas > .area').map((a) => a.dataset.id);

test('system resources are off by default: nothing asks the backend for them', async () => {
  const {backend, $, $$} = boot({backend: fakeBackend(clusterWithSystemNamespace())});
  await flush();

  assert.equal($('#system-toggle').checked, false);
  assert.equal($('#system-count').textContent, '80 hidden');
  assert.ok(backend.urls().includes('/api/overview'), 'the overview is requested without the system parameter');
  for (const params of backend.listRequests()) assert.equal('system' in params, false);
  assert.deepEqual(areaIds($$), ['nodes', 'cluster', 'ns:default', 'ns:shop']);
});

test('switching system resources on refetches the overview and every open list with them, and is saved', async () => {
  const {backend, storage, $, $$} = boot({backend: fakeBackend(clusterWithSystemNamespace())});
  await flush();
  backend.forget();

  $('#system-toggle').click();
  await flush();

  assert.equal(backend.urls().filter((u) => u.startsWith('/api/overview')).join(), '/api/overview?system=true');
  assert.deepEqual(scopes(backend).sort(), OPEN_ON_LOAD);
  for (const params of backend.listRequests()) assert.equal(params.system, 'true');
  assert.deepEqual(areaIds($$), ['nodes', 'cluster', 'ns:default', 'ns:kube-system', 'ns:shop'],
      'the system namespace appears');
  assert.deepEqual($$('#pills .pill-count').map((p) => p.textContent), ['89', '1', '0'], 'totals include them');
  assert.equal($('#system-toggle').checked, true);
  assert.equal($('#system-count').textContent, '80 shown');
  assert.equal(filters.loadFilters(storage).system, true);
});

test('switching system resources off again removes the system namespaces and what was open in them', async () => {
  const {backend, $, $$, byDataId, widgetIds} = boot({backend: fakeBackend(clusterWithSystemNamespace())});
  await flush();
  $('#system-toggle').click();
  await flush();
  byDataId('ns:kube-system').querySelector('.area-head .toggle').click();
  await flush();
  assert.ok(widgetIds().includes('dns-1'));
  backend.forget();

  $('#system-toggle').click();
  await flush();

  assert.deepEqual(areaIds($$), ['nodes', 'cluster', 'ns:default', 'ns:shop']);
  assert.equal(widgetIds().includes('dns-1'), false);
  assert.equal(scopes(backend).includes('namespace=kube-system'), false, 'the hidden namespace is not refetched');
  assert.equal(backend.urls().filter((u) => u.startsWith('/api/overview')).join(), '/api/overview');
});

test('a saved "system resources on" is restored and used from the first request', async () => {
  const saved = filters.setSystem(filters.defaultFilters(), true);
  const storage = memoryStorage({'kvleva.filters': filters.serialize(saved)});

  const {backend, $, $$} = boot({backend: fakeBackend(clusterWithSystemNamespace()), storage});
  await flush();

  assert.equal(backend.urls()[0], '/api/overview?system=true');
  for (const params of backend.listRequests()) assert.equal(params.system, 'true');
  assert.equal($('#system-toggle').checked, true);
  assert.ok(areaIds($$).includes('ns:kube-system'));
});

test('live refreshes keep asking for system resources while the switch is on', async () => {
  const {backend, clock, stream, $} = boot({backend: fakeBackend(clusterWithSystemNamespace())});
  await flush();
  $('#system-toggle').click();
  await flush();
  backend.forget();

  stream().change(fx.change({revision: 1043, changed: ['pod-1']}));
  clock.advance(500);
  await flush();

  assert.equal(backend.urls().filter((u) => u.startsWith('/api/overview')).join(), '/api/overview?system=true');
  for (const params of backend.listRequests()) assert.equal(params.system, 'true');
});

// --- Filters panel width -------------------------------------------------------

test('the filters panel starts at its default width when none was chosen', async () => {
  const {$} = boot();
  await flush();

  assert.equal($('#sidebar').style.width, '');
});

test('a chosen filters panel width is saved and restored the next time the page opens', async () => {
  const storage = memoryStorage();
  const first = boot({storage});
  await flush();

  fire(first.$('#sidebar-resizer'), 'mousedown', {clientX: 260, button: 0});
  fire(first.document.body, 'mousemove', {clientX: 318});
  fire(first.document.body, 'mouseup', {clientX: 318});
  assert.equal(first.$('#sidebar').style.width, '318px');
  first.app.stop();

  const second = boot({storage});
  await flush();
  assert.equal(second.$('#sidebar').style.width, '318px');
});

test('resizing the filters panel requests nothing from the backend', async () => {
  const {backend, document, $} = boot();
  await flush();
  backend.forget();

  fire($('#sidebar-resizer'), 'mousedown', {clientX: 260, button: 0});
  fire(document.body, 'mousemove', {clientX: 300});
  fire(document.body, 'mouseup', {clientX: 300});
  await flush();

  assert.deepEqual(backend.urls(), []);
});

test('hiding the filters panel is remembered the next time the page opens', async () => {
  const storage = memoryStorage();
  const first = boot({storage});
  await flush();
  assert.equal(first.$('#sidebar').hidden, false);

  first.$('#sidebar-toggle').click();
  assert.equal(first.$('#sidebar').hidden, true);
  first.app.stop();

  const second = boot({storage});
  await flush();
  assert.equal(second.$('#sidebar').hidden, true);
  assert.equal(second.$('#sidebar-toggle').getAttribute('aria-expanded'), 'false');

  second.$('#sidebar-toggle').click();
  second.app.stop();
  const third = boot({storage});
  await flush();
  assert.equal(third.$('#sidebar').hidden, false, 'and so is showing it again');
});

test('filters keep applying while the filters panel is hidden, and hiding requests nothing', async () => {
  const {backend, clock, stream, $, $$} = boot();
  await flush();
  kindBox($$, 'core/Secret').click();
  await flush();
  backend.forget();

  $('#sidebar-toggle').click();
  await flush();
  assert.deepEqual(backend.urls(), [], 'hiding the panel is not a filter change');

  stream().change(fx.change({revision: 1043, changed: ['pod-1']}));
  clock.advance(500);
  await flush();
  assert.ok(backend.listRequests().length > 0);
  for (const params of backend.listRequests()) assert.equal(params.hideKinds, 'core/Secret');
});

test('expanding an API group requests nothing and filters nothing', async () => {
  const {backend, storage, clock, stream, widgetIds, $$} = boot();
  await flush();
  backend.forget();
  const shown = widgetIds();
  assert.deepEqual(listedKinds($$), [], 'every group starts collapsed');

  groupToggle($$, 'apps').click();
  await flush();

  assert.deepEqual(listedKinds($$), ['Deployment', 'ReplicaSet']);
  assert.deepEqual(backend.urls(), [], 'expanding is not a filter change');
  assert.deepEqual(widgetIds(), shown, 'the cluster picture is the same, collapsed or expanded');
  assert.equal(storage.data.has('kvleva.filters'), false);

  stream().change(fx.change({revision: 1043, changed: ['pod-1']}));
  clock.advance(500);
  await flush();
  assert.ok(backend.listRequests().length > 0);
  for (const params of backend.listRequests()) assert.equal(params.hideKinds, undefined);
  assert.deepEqual(listedKinds($$), ['Deployment', 'ReplicaSet'], 'a live refresh keeps it expanded');
});

test('expanded API groups are remembered the next time the page opens', async () => {
  const storage = memoryStorage();
  const first = boot({storage});
  await flush();

  groupToggle(first.$$, 'apps').click();
  first.app.stop();

  const second = boot({storage});
  await flush();
  assert.deepEqual(listedKinds(second.$$), ['Deployment', 'ReplicaSet'], 'the other groups are still collapsed');
  assert.equal(groupToggle(second.$$, 'apps').getAttribute('aria-expanded'), 'true');

  groupToggle(second.$$, 'apps').click();
  second.app.stop();
  const third = boot({storage});
  await flush();
  assert.deepEqual(listedKinds(third.$$), [], 'and so is collapsing it again');
});

test('a chosen details panel width is saved and restored the next time the page opens', async () => {
  const storage = memoryStorage();
  const first = boot({storage, windowWidth: 1500});
  await flush();
  first.byDataId('cm-1').click();
  await flush();

  fire(first.$('#drawer-resizer'), 'mousedown', {clientX: 1020, button: 0});
  fire(first.document.body, 'mousemove', {clientX: 1090});
  fire(first.document.body, 'mouseup', {clientX: 1090});
  assert.equal(first.$('#drawer').style.width, '410px');
  first.app.stop();

  const second = boot({storage, windowWidth: 1500});
  await flush();
  second.byDataId('cm-1').click();
  await flush();
  assert.equal(second.$('#drawer').style.width, '410px');
  assert.equal(second.$('#sidebar').style.width, '', 'the filters panel keeps its own width');
});

// --- Theme ---------------------------------------------------------------------

test('the app starts in the night theme', async () => {
  const {document, $} = boot();
  await flush();

  assert.equal(document.documentElement.dataset.theme, 'night');
  assert.match($('#theme-toggle').textContent, /day/i);
});

test('a remembered day theme is shown at once, even while the backend cannot be reached', async () => {
  const backend = fakeBackend(smallCluster());
  backend.failWith = 503;

  const {document, $} = boot({backend, storage: memoryStorage({'kvleva.theme': 'day'})});

  assert.equal(document.documentElement.dataset.theme, 'day', 'before the first answer of the backend');
  assert.match($('#theme-toggle').textContent, /night/i);
  await flush();
  assert.equal(document.documentElement.dataset.theme, 'day');
});

test('switching the theme is remembered, requests nothing and leaves the cluster picture as it is', async () => {
  const storage = memoryStorage();
  const first = boot({storage});
  await flush();
  first.backend.forget();
  const shown = first.widgetIds();

  first.$('#theme-toggle').click();
  await flush();

  assert.equal(first.document.documentElement.dataset.theme, 'day');
  assert.deepEqual(first.backend.urls(), [], 'the theme is not a filter');
  assert.deepEqual(first.widgetIds(), shown);
  assert.equal(storage.data.has('kvleva.filters'), false);
  first.app.stop();

  const second = boot({storage});
  await flush();
  assert.equal(second.document.documentElement.dataset.theme, 'day');

  second.$('#theme-toggle').click();
  second.app.stop();
  const third = boot({storage});
  await flush();
  assert.equal(third.document.documentElement.dataset.theme, 'night', 'and so is switching back');
});

// --- No arrows -----------------------------------------------------------------

test('references are not drawn on the canvas, whatever the user does', async () => {
  const {frames, window, $$, byDataId} = boot();
  await flush();

  fire(byDataId('svc-1'), 'mouseover');
  fire(window, 'resize');
  byDataId('cm-1').click();
  await flush();
  byDataId('dep-1').querySelector('.toggle').click();
  await flush();

  assert.equal($$('svg, path').length, 0, 'references are listed in the details, not drawn');
  assert.equal(frames.length, 0, 'with nothing to draw, no animation frame is ever requested');
});

// --- Read-only ---------------------------------------------------------------

test('a whole session issues nothing but GET requests', async () => {
  const {backend, clock, stream, logStreams, window, $, $$, byDataId} =
      boot({clipboard: {writeText: async () => {}}});
  recordScrolls(window);
  await flush();

  byDataId('cluster').querySelector('.area-head .toggle').click();
  byDataId('node-1').querySelector('.toggle').click();
  await flush();
  byDataId('dep-1').querySelector('.widget-head .name').click();
  await flush();
  $('.configuration .copy').click();
  $$('.connections button.link')[0].click();
  await flush();
  // Live logs: of a resource, ended and started again, then of a container.
  byDataId('dep-1').querySelector('.widget-head .name').click();
  await flush();
  $('#drawer-body .view-logs').click();
  logStreams()[0].logs(fx.logBatch());
  logStreams()[0].emit('error');
  $('#logs-restart').click();
  $('#logs-back').click();
  byDataId('pod-1').querySelectorAll('.container')[1].click();
  await flush();
  $('#drawer-body .view-logs').click();
  kindBox($$, 'core/Secret').click();
  $$('#pills .pill')[0].click();
  type($('#search'), 'web');
  clock.advance(250);
  await flush();
  $('#expand-all').click();
  await flush();
  stream().change(fx.change({overflow: true}));
  clock.advance(2000);
  await flush();
  $('#collapse-all').click();
  fire(window.document.body, 'keydown', {key: 'Escape'});
  await flush();

  assert.ok(backend.requests.length > 20, 'the session exercised the API');
  for (const request of backend.requests) {
    assert.equal(request.method, 'GET', request.url);
    assert.equal(request.body, undefined, request.url);
    assert.match(request.url, /^\/api\//, 'only same-origin API paths');
  }
  // An EventSource can only read: it always issues a GET and carries no body.
  assert.deepEqual(FakeEventSource.instances.map((source) => source.url), [
    '/api/stream',
    '/api/resources/dep-1/logs',
    '/api/resources/dep-1/logs',
    '/api/resources/pod-1/containers/app/logs',
  ]);
  assert.deepEqual(backend.urls().filter((url) => url.includes('/logs')), [], 'logs are only ever streamed');
});

// --- Entry point -------------------------------------------------------------

test('loading main.js in a browser starts the app with the browser facilities', async () => {
  FakeEventSource.instances.length = 0;
  const {window, document} = loadShell();
  const backend = fakeBackend(smallCluster());
  window.fetch = backend.fetch;
  window.EventSource = FakeEventSource;
  window.localStorage.setItem('kvleva.filters',
      filters.serialize(filters.setQuery(filters.defaultFilters(), 'from-storage')));
  globalThis.window = window;
  globalThis.document = document;
  try {
    await import('../static/js/main.js?entry');
    await flush();
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }

  assert.equal(document.getElementById('cluster-name').textContent, 'kind-kvleva');
  assert.equal(FakeEventSource.instances.length, 1);
  assert.ok(backend.listRequests().length > 0);
  for (const params of backend.listRequests()) assert.equal(params.q, 'from-storage');
  window.close();
});

// --- Controls used before the cluster has loaded -----------------------------

test('filters changed before the cluster has loaded are kept and applied to the first requests', async () => {
  const backend = fakeBackend(smallCluster());
  backend.failWith = 503;
  const {clock, storage, $} = boot({backend});
  await flush();

  $('#health-filter input[data-health="red"]').click();
  $('#kinds-none').click();
  type($('#search'), 'web');
  clock.advance(250);
  await flush();
  assert.deepEqual(filters.loadFilters(storage).health, {green: true, yellow: true, red: false});

  backend.failWith = null;
  backend.forget();
  clock.advance(3000);
  await flush();

  assert.ok(backend.listRequests().length > 0);
  for (const params of backend.listRequests()) {
    assert.equal(params.health, 'yellow,green');
    assert.equal(params.q, 'web');
    assert.equal('hideKinds' in params, false, 'None had no resource types to hide yet');
  }
  assert.equal($('#health-filter input[data-health="red"]').checked, false);
});

test('canvas and drawer controls are harmless before the cluster has loaded', async () => {
  const backend = fakeBackend(smallCluster());
  backend.failWith = 503;
  const {clock, document, stream, window, $, widgetIds} = boot({backend});
  await flush();
  backend.forget();

  $('#expand-all').click();
  $('#collapse-all').click();
  $('#drawer-close').click();
  fire(document.body, 'keydown', {key: 'Escape'});
  fire(window, 'resize');
  stream().emit('error');
  stream().emit('open');
  stream().change(fx.change({overflow: true}));
  await flush();

  assert.deepEqual(backend.urls(), [], 'nothing is requested for a cluster that is not known yet');
  assert.equal($('#app-error').hidden, false);

  backend.failWith = null;
  clock.advance(3000);
  await flush();
  assert.ok(widgetIds().includes('pod-1'), 'and the app still loads afterwards');
});
