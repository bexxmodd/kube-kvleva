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
    system: false,
  });
  assert.deepEqual(filters.toQuery(f), {});
});

test('system resources are off by default and requested only when switched on', () => {
  const off = filters.defaultFilters();
  const on = filters.setSystem(off, true);

  assert.equal(off.system, false);
  assert.deepEqual(filters.toQuery(off), {}, 'off sends nothing: the backend hides them by default');
  assert.deepEqual(filters.toQuery(on), {system: 'true'});
  assert.deepEqual(filters.toQuery(filters.setSystem(on, false)), {});
  assert.equal(off.system, false, 'input must not be mutated');
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

test('a connection mode saved by an earlier version is dropped', () => {
  // Reference arrows and their mode control were removed; filters saved
  // while they existed still carry the setting.
  const saved = JSON.stringify({...filters.defaultFilters(), q: 'web', connections: 'off'});

  assert.deepEqual(filters.deserialize(saved), {...filters.defaultFilters(), q: 'web'});
});

test('filters survive a serialize / deserialize round trip', () => {
  let f = filters.defaultFilters();
  f = filters.toggleHealth(f, 'green');
  f = filters.setKindHidden(f, 'core/Secret', true);
  f = filters.setQuery(f, 'web');
  f = filters.setSystem(f, true);

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
    system: 'yes',
    extra: 'ignored',
  }));

  assert.deepEqual(got, {
    health: {green: false, yellow: true, red: true},
    hiddenKinds: ['core/Secret'],
    q: '',
    system: false,
  });
});

test('filters saved before the system switch existed keep system resources off', () => {
  const saved = JSON.stringify({health: {green: true, yellow: true, red: true}, hiddenKinds: [], q: 'web'});

  assert.equal(filters.deserialize(saved).system, false);
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

test('resource types are grouped by API group: core first, the others alphabetically', () => {
  const groups = filters.groupKinds(fx.overview().kinds);

  assert.deepEqual(groups.map((g) => [g.group, g.kinds.map((k) => k.kind), g.count]), [
    ['core', ['Service', 'Pod', 'Secret'], 63],
    ['apps', ['Deployment', 'ReplicaSet'], 26],
    ['gateway.networking.k8s.io', ['Gateway'], 1],
  ], 'inside a group the types keep the order of the overview');
  assert.deepEqual(filters.groupKinds([]), []);
});

test('a group is fully shown, fully hidden, or partly hidden', () => {
  const kinds = fx.overview().kinds;
  const core = filters.groupKinds(kinds)[0].kinds;
  let f = filters.defaultFilters();
  assert.equal(filters.groupState(f, core), 'shown');

  f = filters.setKindHidden(f, 'core/Secret', true);
  assert.equal(filters.groupState(f, core), 'partly');

  f = filters.setKindsHidden(f, ['core/Service', 'core/Pod'], true);
  assert.equal(filters.groupState(f, core), 'hidden');
});

test('several resource types are hidden or shown in one step', () => {
  let f = filters.setKindHidden(filters.defaultFilters(), 'apps/Deployment', true);

  f = filters.setKindsHidden(f, ['core/Secret', 'core/Pod', 'core/Secret'], true);
  assert.deepEqual(f.hiddenKinds, ['apps/Deployment', 'core/Pod', 'core/Secret'], 'sorted, without duplicates');

  f = filters.setKindsHidden(f, ['core/Pod', 'core/Service'], false);
  assert.deepEqual(f.hiddenKinds, ['apps/Deployment', 'core/Secret'], 'the others stay as they were');
  assert.deepEqual(filters.toQuery(f), {hideKinds: 'apps/Deployment,core/Secret'});
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
