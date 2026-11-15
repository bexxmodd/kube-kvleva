import test from 'node:test';
import assert from 'node:assert/strict';

import * as tree from '../static/js/tree.js';
import * as fx from './fixtures.js';
import {deferred, fakeClock, flush} from './helpers.js';

const NS = {type: 'namespace', name: 'default'};

/** `count` distinct summaries. */
function many(count, prefix = 'u') {
  return Array.from({length: count}, (_, i) => fx.summary({uid: `${prefix}${i}`, name: `${prefix}${i}`}));
}

const uids = (items) => items.map((i) => i.uid);

test('every scope has a distinct key', () => {
  assert.equal(tree.scopeKey({type: 'nodes'}), 'nodes');
  assert.equal(tree.scopeKey({type: 'cluster'}), 'cluster');
  assert.equal(tree.scopeKey({type: 'namespace', name: 'default'}), 'ns:default');
  assert.equal(tree.scopeKey({type: 'parent', uid: 'dep-1'}), 'parent:dep-1');
  assert.equal(tree.scopeKey({type: 'node', name: 'n1'}), 'node:n1');
});

test('an opened list starts empty and not loaded', () => {
  const t = tree.createTree();

  assert.equal(tree.isOpen(t, 'ns:default'), false);
  const list = tree.openList(t, NS);

  assert.equal(tree.isOpen(t, 'ns:default'), true);
  assert.equal(tree.getList(t, 'ns:default'), list);
  assert.deepEqual(list.items, []);
  assert.equal(list.loaded, false);
  assert.deepEqual(list.scope, NS);
});

test('opening an open list again keeps what it loaded', () => {
  const t = tree.createTree();
  tree.openList(t, NS);
  tree.addPage(t, 'ns:default', fx.page([fx.gateway()]));

  const again = tree.openList(t, NS);

  assert.deepEqual(uids(again.items), [fx.UID.gateway]);
});

test('pages accumulate and report what remains', () => {
  const t = tree.createTree();
  const list = tree.openList(t, NS);
  const all = many(250);

  assert.deepEqual(tree.nextPageRequest(list), {offset: 0, limit: 100});

  tree.addPage(t, 'ns:default', fx.page(all.slice(0, 100), {total: 250}));
  assert.equal(list.loaded, true);
  assert.equal(list.items.length, 100);
  assert.equal(list.total, 250);
  assert.equal(tree.remaining(list), 150);
  assert.deepEqual(tree.nextPageRequest(list), {offset: 100, limit: 100});

  tree.addPage(t, 'ns:default', fx.page(all.slice(100, 200), {total: 250, offset: 100}));
  tree.addPage(t, 'ns:default', fx.page(all.slice(200), {total: 250, offset: 200}));
  assert.deepEqual(uids(list.items), uids(all));
  assert.equal(tree.remaining(list), 0);
  assert.equal(tree.nextPageRequest(list), null);
});

test('an item delivered twice by overlapping pages is kept once', () => {
  const t = tree.createTree();
  const list = tree.openList(t, NS);
  const [a, b, c] = many(3);

  tree.addPage(t, 'ns:default', fx.page([a, b], {total: 3}));
  tree.addPage(t, 'ns:default', fx.page([b, c], {total: 3, offset: 1}));

  assert.deepEqual(uids(list.items), ['u0', 'u1', 'u2']);
});

test('a page that arrives after its list was closed is dropped', () => {
  const t = tree.createTree();
  tree.openList(t, NS);
  tree.closeList(t, 'ns:default');

  const applied = tree.addPage(t, 'ns:default', fx.page(many(2)));

  assert.equal(applied, false);
  assert.equal(tree.isOpen(t, 'ns:default'), false);
});

test('closing a list closes everything opened inside it', () => {
  const t = tree.createTree();
  tree.openList(t, NS);
  tree.openList(t, {type: 'parent', uid: 'dep-1'}, 'ns:default');
  tree.openList(t, {type: 'parent', uid: 'rs-1'}, 'parent:dep-1');
  tree.openList(t, {type: 'cluster'});

  tree.closeList(t, 'parent:dep-1');
  assert.deepEqual([...t.lists.keys()].sort(), ['cluster', 'ns:default']);

  tree.openList(t, {type: 'parent', uid: 'dep-1'}, 'ns:default');
  tree.openList(t, {type: 'parent', uid: 'rs-1'}, 'parent:dep-1');
  tree.closeList(t, 'ns:default');
  assert.deepEqual([...t.lists.keys()], ['cluster']);
});

test('a failed load is remembered on the list', () => {
  const t = tree.createTree();
  const list = tree.openList(t, NS);

  tree.setError(t, 'ns:default', 'boom');

  assert.equal(list.error, 'boom');
  tree.addPage(t, 'ns:default', fx.page(many(1)));
  assert.equal(list.error, null, 'a later successful page clears the error');
});

test('consecutive items of the same kind form a lane', () => {
  const second = fx.summary({uid: 'cm-2', name: 'other'});
  const items = [fx.gateway(), fx.route(), fx.service(), fx.deployment(), fx.configMap(), second];

  const got = tree.lanes(items).map((lane) => [lane.kindId, lane.kind, uids(lane.items)]);

  assert.deepEqual(got, [
    ['gateway.networking.k8s.io/Gateway', 'Gateway', ['gw-1']],
    ['gateway.networking.k8s.io/HTTPRoute', 'HTTPRoute', ['route-1']],
    ['core/Service', 'Service', ['svc-1']],
    ['apps/Deployment', 'Deployment', ['dep-1']],
    ['core/ConfigMap', 'ConfigMap', ['cm-1', 'cm-2']],
  ]);
});

test('lanes follow the order of arrival and never reorder items', () => {
  const items = [fx.pod(), fx.configMap(), {...fx.pod(), uid: 'pod-2'}];

  assert.deepEqual(tree.lanes(items).map((lane) => lane.kind), ['Pod', 'ConfigMap', 'Pod']);
  assert.deepEqual(tree.lanes([]), []);
});

test('a resource with children opens the list of its children', () => {
  assert.deepEqual(tree.childScope(fx.deployment(), NS), {type: 'parent', uid: 'dep-1'});
  assert.equal(tree.childScope(fx.configMap(), NS), null);
});

test('a node in the Nodes area opens the pods scheduled on it', () => {
  assert.deepEqual(tree.childScope(fx.node(), {type: 'nodes'}), {type: 'node', name: 'kvleva-control-plane'});
});

test('the flat pod list of a node offers no further nesting', () => {
  const podWithChildren = {...fx.pod(), childCount: 2};

  assert.equal(tree.childScope(podWithChildren, {type: 'node', name: 'n1'}), null);
});

// --- Initial expansion -------------------------------------------------------

test('a small cluster starts with the Nodes area and every namespace open', () => {
  const overview = fx.overview({health: fx.rollup(390, 9, 1)});

  assert.deepEqual(tree.initialScopes(overview), [
    {type: 'nodes'},
    {type: 'namespace', name: 'default'},
    {type: 'namespace', name: 'shop'},
  ]);
});

test('a cluster with more than 400 resources starts closed', () => {
  assert.deepEqual(tree.initialScopes(fx.overview({health: fx.rollup(390, 10, 1)})), []);
  assert.deepEqual(tree.initialScopes(fx.overview({health: fx.rollup(50000, 0, 0)})), []);
});

test('initial expansion opens small child lists two levels deep', () => {
  const t = tree.createTree();
  const big = {...fx.deployment(), uid: 'dep-big', childCount: 11};
  const ten = {...fx.deployment(), uid: 'dep-ten', childCount: 10};
  const area = tree.openList(t, NS);
  tree.addPage(t, 'ns:default', fx.page([fx.service(), fx.deployment(), big, ten]));

  assert.deepEqual(tree.autoOpenScopes(area), [{type: 'parent', uid: 'dep-1'}, {type: 'parent', uid: 'dep-ten'}]);

  const level1 = tree.openList(t, {type: 'parent', uid: 'dep-1'}, 'ns:default');
  tree.addPage(t, 'parent:dep-1', fx.page([fx.replicaSet()]));
  assert.deepEqual(tree.autoOpenScopes(level1), [{type: 'parent', uid: 'rs-1'}]);

  const level2 = tree.openList(t, {type: 'parent', uid: 'rs-1'}, 'parent:dep-1');
  tree.addPage(t, 'parent:rs-1', fx.page([{...fx.pod(), childCount: 1}]));
  assert.deepEqual(tree.autoOpenScopes(level2), [], 'the third level stays closed');
});

test('initial expansion does not open nodes', () => {
  const t = tree.createTree();
  const nodes = tree.openList(t, {type: 'nodes'});
  tree.addPage(t, 'nodes', fx.page([fx.node()]));

  assert.deepEqual(tree.autoOpenScopes(nodes), []);
});

test('Expand all opens the three kinds of areas and nothing nested', () => {
  assert.deepEqual(tree.areaScopes(fx.overview()), [
    {type: 'nodes'},
    {type: 'cluster'},
    {type: 'namespace', name: 'default'},
    {type: 'namespace', name: 'shop'},
  ]);
});

// --- Refresh planning --------------------------------------------------------

test('a refresh re-requests every open list with as many pages as it had loaded', () => {
  const t = tree.createTree();
  tree.openList(t, NS);
  tree.addPage(t, 'ns:default', fx.page(many(100), {total: 950}));
  tree.addPage(t, 'ns:default', fx.page(many(100, 'v'), {total: 950, offset: 100}));
  tree.addPage(t, 'ns:default', fx.page(many(50, 'w'), {total: 950, offset: 200}));
  tree.openList(t, {type: 'parent', uid: 'u0'}, 'ns:default');
  tree.addPage(t, 'parent:u0', fx.page(many(3, 'c')));
  tree.openList(t, {type: 'cluster'});

  assert.deepEqual(tree.refreshRequests(t), [
    {key: 'ns:default', scope: NS, offset: 0, limit: 300},
    {key: 'parent:u0', scope: {type: 'parent', uid: 'u0'}, offset: 0, limit: 100},
    {key: 'cluster', scope: {type: 'cluster'}, offset: 0, limit: 100},
  ]);
});

test('a refresh splits long lists into requests of at most 500 items', () => {
  const t = tree.createTree();
  tree.openList(t, NS);
  for (let p = 0; p < 12; p++) {
    tree.addPage(t, 'ns:default', fx.page(many(100, `p${p}-`), {total: 5000, offset: p * 100}));
  }

  assert.deepEqual(tree.refreshRequests(t).map((r) => [r.offset, r.limit]), [[0, 500], [500, 500], [1000, 200]]);
});

test('refreshed pages replace what a list had loaded', () => {
  const t = tree.createTree();
  const list = tree.openList(t, NS);
  tree.addPage(t, 'ns:default', fx.page(many(3), {total: 3}));
  const changed = {...many(1)[0], health: 'red'};

  const applied = tree.replaceItems(t, 'ns:default', [
    fx.page([changed], {total: 2}),
    fx.page([fx.configMap()], {total: 2, offset: 1}),
  ]);

  assert.equal(applied, true);
  assert.deepEqual(uids(list.items), ['u0', 'cm-1']);
  assert.equal(list.items[0].health, 'red');
  assert.equal(list.total, 2);
  assert.equal(tree.replaceItems(t, 'ns:gone', [fx.page([])]), false);
});

test('after a refresh, lists whose container vanished are closed', () => {
  const t = tree.createTree();
  tree.openList(t, NS);
  tree.addPage(t, 'ns:default', fx.page([fx.deployment(), fx.configMap()]));
  tree.openList(t, {type: 'parent', uid: 'dep-1'}, 'ns:default');
  tree.addPage(t, 'parent:dep-1', fx.page([fx.replicaSet()]));
  tree.openList(t, {type: 'parent', uid: 'rs-1'}, 'parent:dep-1');
  tree.openList(t, {type: 'namespace', name: 'deleted-ns'});
  tree.openList(t, {type: 'nodes'});
  tree.addPage(t, 'nodes', fx.page([fx.node()]));
  tree.openList(t, {type: 'node', name: 'kvleva-control-plane'}, 'nodes');
  tree.openList(t, {type: 'node', name: 'drained'}, 'nodes');
  tree.openList(t, {type: 'cluster'});

  // Nothing changed for the deployment yet: only the unknown namespace and node go.
  assert.deepEqual(tree.prune(t, fx.overview()).sort(), ['node:drained', 'ns:deleted-ns']);

  // The deployment lost its children: its list and the nested one are closed.
  tree.replaceItems(t, 'ns:default', [fx.page([{...fx.deployment(), childCount: 0}, fx.configMap()])]);
  assert.deepEqual(tree.prune(t, fx.overview()).sort(), ['parent:dep-1', 'parent:rs-1']);
  assert.deepEqual([...t.lists.keys()].sort(), ['cluster', 'node:kvleva-control-plane', 'nodes', 'ns:default']);
});

test('a list that is still loading its first page is not pruned', () => {
  const t = tree.createTree();
  tree.openList(t, NS);
  tree.openList(t, {type: 'parent', uid: 'dep-1'}, 'ns:default');

  assert.deepEqual(tree.prune(t, fx.overview()), []);
});

test('the drawer is refetched when its resource changed and marked gone when deleted', () => {
  assert.equal(tree.drawerRefresh('pod-1', fx.change({changed: ['x', 'pod-1']})), 'refetch');
  assert.equal(tree.drawerRefresh('pod-1', fx.change({overflow: true})), 'refetch');
  assert.equal(tree.drawerRefresh('pod-1', fx.change({deleted: ['pod-1']})), 'gone');
  assert.equal(tree.drawerRefresh('pod-1', fx.change({changed: ['other'], deleted: ['x']})), 'none');
  assert.equal(tree.drawerRefresh(null, fx.change({overflow: true})), 'none');
});

// --- Refresh scheduling ------------------------------------------------------

function scheduler(run = async () => {}) {
  const clock = fakeClock();
  const runs = [];
  const s = tree.createRefreshScheduler({
    run: (change) => {
      runs.push({at: clock.now(), change});
      return run(change);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  return {clock, runs, s};
}

test('a change is followed by one refresh 500 ms later', async () => {
  const {clock, runs, s} = scheduler();

  s.notify(fx.change({changed: ['a']}));
  clock.advance(499);
  assert.equal(runs.length, 0);
  clock.advance(1);
  await flush();
  clock.advance(10000);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].at, 500);
  assert.deepEqual(runs[0].change, {changed: ['a'], deleted: [], overflow: false});
});

test('a burst of changes becomes one refresh carrying all of them', async () => {
  const {clock, runs, s} = scheduler();

  s.notify(fx.change({changed: ['a'], deleted: ['x']}));
  clock.advance(200);
  s.notify(fx.change({changed: ['b', 'a']}));
  clock.advance(200);
  s.notify(fx.change({deleted: ['y']}));
  clock.advance(499);
  assert.equal(runs.length, 0, 'still debouncing');
  clock.advance(1);
  await flush();

  assert.equal(runs.length, 1);
  assert.equal(runs[0].at, 900);
  assert.deepEqual(runs[0].change, {changed: ['a', 'b'], deleted: ['x', 'y'], overflow: false});
});

test('an overflow anywhere in the burst makes the refresh an overflow', async () => {
  const {clock, runs, s} = scheduler();

  s.notify(fx.change({changed: ['a']}));
  s.notify(fx.change({overflow: true}));
  s.notify(fx.change({changed: ['b']}));
  clock.advance(500);
  await flush();

  assert.equal(runs[0].change.overflow, true);
});

test('refreshes start at least 2 s apart', async () => {
  const {clock, runs, s} = scheduler();

  s.notify(fx.change({changed: ['a']}));
  clock.advance(500);
  await flush();
  clock.advance(100);
  s.notify(fx.change({changed: ['b']}));
  clock.advance(1899);
  await flush();
  assert.equal(runs.length, 1, 'the second refresh waits for the 2 s interval');
  clock.advance(1);
  await flush();

  assert.deepEqual(runs.map((r) => r.at), [500, 2500]);
  assert.deepEqual(runs[1].change.changed, ['b'], 'changes are not reported twice');
});

test('a refresh never starts while the previous one is still running', async () => {
  const first = deferred();
  let calls = 0;
  const {clock, runs, s} = scheduler(() => (++calls === 1 ? first.promise : Promise.resolve()));

  s.notify(fx.change({changed: ['a']}));
  clock.advance(500);
  s.notify(fx.change({changed: ['b']}));
  clock.advance(60000);
  await flush();
  assert.equal(runs.length, 1, 'the slow refresh is still running');

  first.resolve();
  await flush();
  clock.advance(0);
  await flush();

  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].change.changed, ['b']);
});

test('a failed refresh does not stop later refreshes', async () => {
  let calls = 0;
  const {clock, runs, s} = scheduler(() => (++calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve()));

  s.notify(fx.change({changed: ['a']}));
  clock.advance(500);
  await flush();
  s.notify(fx.change({changed: ['b']}));
  clock.advance(5000);
  await flush();

  assert.equal(runs.length, 2);
});

test('a stopped scheduler runs nothing', async () => {
  const {clock, runs, s} = scheduler();

  s.notify(fx.change({changed: ['a']}));
  s.stop();
  clock.advance(60000);
  await flush();

  assert.equal(runs.length, 0);
  assert.equal(clock.pending(), 0);
});

// --- Nearest rendered ancestor -----------------------------------------------
// Revealing a resource that is folded away, or hidden by the filters, falls
// back to the innermost box around it that is on the page.

const renderedIds = (...ids) => (id) => ids.includes(id);

test('a rendered resource stands for itself', () => {
  assert.equal(tree.lift(fx.pod(), renderedIds('pod-1', 'rs-1', 'dep-1', 'ns:default')), 'pod-1');
});

test('a folded resource is represented by its innermost rendered owner', () => {
  assert.equal(tree.lift(fx.pod(), renderedIds('rs-1', 'dep-1', 'ns:default')), 'rs-1');
  assert.equal(tree.lift(fx.pod(), renderedIds('dep-1', 'ns:default')), 'dep-1');
});

test('a resource in a closed namespace is represented by the namespace box', () => {
  assert.equal(tree.lift(fx.pod(), renderedIds('ns:default', 'ns:shop', 'cluster', 'nodes')), 'ns:default');
});

test('an unrendered cluster-scoped resource is represented by the cluster-wide area', () => {
  const gatewayClass = fx.link({uid: 'gc-1', kindId: 'gateway.networking.k8s.io/GatewayClass', namespace: '',
                                name: 'kvleva', path: ['cluster']});

  assert.equal(tree.lift(gatewayClass, renderedIds('cluster', 'nodes', 'ns:default')), 'cluster');
});

test('an unrendered Node is represented by the Nodes area, not the cluster-wide area', () => {
  assert.equal(tree.lift(fx.node(), renderedIds('cluster', 'nodes', 'ns:default')), 'nodes');
  assert.equal(tree.lift(fx.node(), renderedIds('node-1', 'cluster', 'nodes')), 'node-1', 'its widget is preferred');
});

test('a Namespace object is represented by its namespace box', () => {
  const shop = fx.link({uid: fx.UID.nsShop, kindId: 'core/Namespace', namespace: '', name: 'shop', path: ['cluster']});

  assert.equal(tree.lift(shop, renderedIds('ns:default', 'ns:shop', 'cluster')), 'ns:shop');
});

test('a resource with nothing rendered around it has no representative', () => {
  const far = fx.link({uid: 'far', namespace: 'gone', path: ['ns:gone', 'far-owner']});

  assert.equal(tree.lift(far, renderedIds('ns:default', 'cluster', 'nodes')), null);
  assert.equal(tree.lift({uid: 'bare', kindId: 'core/ConfigMap', name: 'bare'}, renderedIds('ns:default')), null,
      'a missing path is tolerated');
});
