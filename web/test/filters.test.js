import test from 'node:test';
import assert from 'node:assert/strict';

import * as filters from '../static/js/filters.js';
import * as fx from './fixtures.js';
import {memoryStorage} from './helpers.js';

test('default filters show everything and send no filter parameters', () => {
  const f = filters.defaultFilters();

  assert.deepEqual(f, {
    health: {green: true, yellow: true, red: true},
    hiddenKinds: [],
    q: '',
    connections: 'all',
  });
  assert.deepEqual(filters.toQuery(f), {});
});

test('unchecked health values are left out of the health parameter', () => {
  const noGreen = filters.toggleHealth(filters.defaultFilters(), 'green');
  const onlyRed = filters.toggleHealth(noGreen, 'yellow');

  assert.deepEqual(filters.toQuery(noGreen), {health: 'red,yellow'});
  assert.deepEqual(filters.toQuery(onlyRed), {health: 'red'});
});

test('toggling a health value back on removes the health parameter again', () => {
  const start = filters.defaultFilters();
  const off = filters.toggleHealth(start, 'red');
  const on = filters.toggleHealth(off, 'red');

  assert.deepEqual(filters.toQuery(on), {});
  assert.deepEqual(start.health, {green: true, yellow: true, red: true}, 'input must not be mutated');
});

test('unchecking the last health value shows every health again', () => {
  let f = filters.defaultFilters();
  f = filters.toggleHealth(f, 'green');
  f = filters.toggleHealth(f, 'yellow');
  f = filters.toggleHealth(f, 'red');

  assert.deepEqual(f.health, {green: true, yellow: true, red: true});
  assert.deepEqual(filters.toQuery(f), {});
});

test('hidden kinds are sent as a comma separated hideKinds parameter', () => {
  let f = filters.defaultFilters();
  f = filters.setKindHidden(f, 'core/Secret', true);
  f = filters.setKindHidden(f, 'apps/ReplicaSet', true);
  f = filters.setKindHidden(f, 'core/Secret', true);

  assert.deepEqual(filters.toQuery(f), {hideKinds: 'apps/ReplicaSet,core/Secret'});
  assert.equal(filters.isKindHidden(f, 'core/Secret'), true);
  assert.equal(filters.isKindHidden(f, 'core/Pod'), false);

  f = filters.setKindHidden(f, 'core/Secret', false);
  assert.deepEqual(filters.toQuery(f), {hideKinds: 'apps/ReplicaSet'});
});

test('None hides every kind of the overview and All shows them again', () => {
  const kinds = fx.overview().kinds;

  const none = filters.setAllKindsHidden(filters.defaultFilters(), kinds, true);
  const all = filters.setAllKindsHidden(none, kinds, false);

  assert.deepEqual(filters.toQuery(none), {
    hideKinds: 'apps/Deployment,apps/ReplicaSet,core/Pod,core/Secret,core/Service,' +
        'gateway.networking.k8s.io/Gateway',
  });
  assert.deepEqual(filters.toQuery(all), {});
});

test('the search text is trimmed and sent as q', () => {
  const f = filters.setQuery(filters.defaultFilters(), '  CHECK ');

  assert.deepEqual(filters.toQuery(f), {q: 'CHECK'});
  assert.deepEqual(filters.toQuery(filters.setQuery(f, '   ')), {});
});

test('the connection mode is one of all, selected, off and is not a query parameter', () => {
  const f = filters.setConnections(filters.defaultFilters(), 'selected');

  assert.equal(f.connections, 'selected');
  assert.deepEqual(filters.toQuery(f), {});
  assert.equal(filters.setConnections(f, 'off').connections, 'off');
  assert.equal(filters.setConnections(f, 'sideways').connections, 'selected', 'unknown modes are ignored');
});

test('filters survive a serialize / deserialize round trip', () => {
  let f = filters.defaultFilters();
  f = filters.toggleHealth(f, 'green');
  f = filters.setKindHidden(f, 'core/Secret', true);
  f = filters.setQuery(f, 'web');
  f = filters.setConnections(f, 'off');

  assert.deepEqual(filters.deserialize(filters.serialize(f)), f);
});

test('deserialize falls back to defaults for missing or corrupt data', () => {
  for (const text of [null, undefined, '', '{not json', 'null', '42', '"x"', '[]']) {
    assert.deepEqual(filters.deserialize(text), filters.defaultFilters(), String(text));
  }
});

test('deserialize repairs individual invalid fields', () => {
  const got = filters.deserialize(JSON.stringify({
    health: {green: false, yellow: 'yes', red: true, purple: true},
    hiddenKinds: ['core/Secret', 7, null, 'core/Secret', {}],
    q: 12,
    connections: 'sideways',
    extra: 'ignored',
  }));

  assert.deepEqual(got, {
    health: {green: false, yellow: true, red: true},
    hiddenKinds: ['core/Secret'],
    q: '',
    connections: 'all',
  });
});

test('deserialize never yields a filter that hides every health', () => {
  const got = filters.deserialize(JSON.stringify({health: {green: false, yellow: false, red: false}}));

  assert.deepEqual(got.health, {green: true, yellow: true, red: true});
});

test('filters are saved to and restored from storage', () => {
  const storage = memoryStorage();
  const f = filters.setKindHidden(filters.setQuery(filters.defaultFilters(), 'api'), 'core/Secret', true);

  filters.saveFilters(storage, f);

  assert.deepEqual([...storage.data.keys()], ['kvleva.filters']);
  assert.deepEqual(filters.loadFilters(storage), f);
});

test('loading uses defaults when storage is empty, missing or broken', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
  };

  assert.deepEqual(filters.loadFilters(memoryStorage()), filters.defaultFilters());
  assert.deepEqual(filters.loadFilters(undefined), filters.defaultFilters());
  assert.deepEqual(filters.loadFilters(broken), filters.defaultFilters());
  assert.doesNotThrow(() => filters.saveFilters(broken, filters.defaultFilters()));
  assert.doesNotThrow(() => filters.saveFilters(undefined, filters.defaultFilters()));
});

test('the resource type list is narrowed by kind or group, keeping its order', () => {
  const kinds = fx.overview().kinds;
  const names = (list) => list.map((k) => k.kind);

  assert.deepEqual(names(filters.matchKinds(kinds, '')), names(kinds));
  assert.deepEqual(names(filters.matchKinds(kinds, 'SE')), ['Service', 'ReplicaSet', 'Secret']);
  assert.deepEqual(names(filters.matchKinds(kinds, 'apps')), ['Deployment', 'ReplicaSet']);
  assert.deepEqual(names(filters.matchKinds(kinds, ' gateway.networking ')), ['Gateway']);
  assert.deepEqual(names(filters.matchKinds(kinds, 'zzz')), []);
});
