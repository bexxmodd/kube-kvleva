import test from 'node:test';
import assert from 'node:assert/strict';

import * as layout from '../static/js/layout.js';
import {memoryStorage} from './helpers.js';

test('a width within the limits is kept, rounded to whole pixels', () => {
  assert.equal(layout.clampSidebarWidth(300, 1200), 300);
  assert.equal(layout.clampSidebarWidth(299.6, 1200), 300);
});

test('the filters panel is never wider than a third of the window', () => {
  assert.equal(layout.clampSidebarWidth(900, 1200), 400);
  assert.equal(layout.clampSidebarWidth(401, 1200), 400);
  assert.equal(layout.clampSidebarWidth(400, 1200), 400, 'exactly a third is allowed');
  assert.equal(layout.clampSidebarWidth(5000, 1000), 333, 'a third is rounded down');
});

test('the filters panel is never narrower than its minimum', () => {
  assert.equal(layout.clampSidebarWidth(20, 1200), layout.SIDEBAR_MIN_WIDTH);
  assert.equal(layout.clampSidebarWidth(-50, 1200), layout.SIDEBAR_MIN_WIDTH);
  assert.equal(layout.SIDEBAR_MIN_WIDTH, 180);
});

test('in a very narrow window the third-of-the-window limit wins over the minimum', () => {
  assert.equal(layout.clampSidebarWidth(300, 450), 150);
  assert.equal(layout.clampSidebarWidth(10, 450), 150);
});

test('a width that is not a number falls back to the default', () => {
  for (const bad of [NaN, Infinity, undefined, null, 'wide']) {
    assert.equal(layout.clampSidebarWidth(bad, 1200), layout.SIDEBAR_DEFAULT_WIDTH, String(bad));
  }
  assert.equal(layout.SIDEBAR_DEFAULT_WIDTH, 260);
});

test('the chosen width is saved to and restored from storage', () => {
  const storage = memoryStorage();

  layout.saveSidebarWidth(storage, 312);

  assert.deepEqual([...storage.data.keys()], ['kvleva.sidebarWidth']);
  assert.equal(layout.loadSidebarWidth(storage), 312);
});

test('without a usable saved width nothing is restored', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
  };

  assert.equal(layout.loadSidebarWidth(memoryStorage()), null);
  assert.equal(layout.loadSidebarWidth(undefined), null);
  assert.equal(layout.loadSidebarWidth(broken), null);
  for (const garbage of ['', 'wide', '-40', '0', 'NaN', '{"w":1}']) {
    assert.equal(layout.loadSidebarWidth(memoryStorage({'kvleva.sidebarWidth': garbage})), null, garbage);
  }
  assert.doesNotThrow(() => layout.saveSidebarWidth(broken, 300));
  assert.doesNotThrow(() => layout.saveSidebarWidth(undefined, 300));
});

test('whether the filters panel is hidden is saved to and restored from storage', () => {
  const storage = memoryStorage();
  assert.equal(layout.loadSidebarHidden(storage), false, 'shown until the user hides it');

  layout.saveSidebarHidden(storage, true);
  assert.equal(layout.loadSidebarHidden(storage), true);

  layout.saveSidebarHidden(storage, false);
  assert.equal(layout.loadSidebarHidden(storage), false);
  assert.ok(storage.data.has('kvleva.sidebarHidden'));
});

test('the filters panel is shown when nothing usable was saved about hiding it', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
  };

  assert.equal(layout.loadSidebarHidden(undefined), false);
  assert.equal(layout.loadSidebarHidden(broken), false);
  for (const garbage of ['', 'yes', '1', 'TRUE', '{}']) {
    assert.equal(layout.loadSidebarHidden(memoryStorage({'kvleva.sidebarHidden': garbage})), false, garbage);
  }
  assert.doesNotThrow(() => layout.saveSidebarHidden(broken, true));
  assert.doesNotThrow(() => layout.saveSidebarHidden(undefined, true));
});

// --- Details panel -------------------------------------------------------------

test('the details panel is never wider than a third of the window either', () => {
  assert.equal(layout.clampDrawerWidth(420, 1500), 420);
  assert.equal(layout.clampDrawerWidth(900, 1500), 500);
  assert.equal(layout.clampDrawerWidth(500, 1500), 500, 'exactly a third is allowed');
  assert.equal(layout.clampDrawerWidth(900, 1000), 333, 'a third is rounded down');
});

test('the details panel has its own minimum and default', () => {
  assert.equal(layout.DRAWER_MIN_WIDTH, 280);
  assert.equal(layout.DRAWER_DEFAULT_WIDTH, 480);
  assert.equal(layout.clampDrawerWidth(40, 1500), 280);
  assert.equal(layout.clampDrawerWidth(undefined, 1500), 480);
  assert.equal(layout.clampDrawerWidth(undefined, 1200), 400, 'the default is capped at a third as well');
  assert.equal(layout.clampDrawerWidth(300, 600), 200, 'in a narrow window the third wins over the minimum');
});

test('the details panel width is saved separately from the filters panel width', () => {
  const storage = memoryStorage();

  layout.saveSidebarWidth(storage, 222);
  layout.saveDrawerWidth(storage, 444);

  assert.equal(layout.loadSidebarWidth(storage), 222);
  assert.equal(layout.loadDrawerWidth(storage), 444);
  assert.ok(storage.data.has('kvleva.drawerWidth'));
  assert.equal(layout.loadDrawerWidth(memoryStorage()), null);
  assert.equal(layout.loadDrawerWidth(memoryStorage({'kvleva.drawerWidth': 'wide'})), null);
  assert.equal(layout.loadDrawerWidth(undefined), null);
});

// --- Expanded API groups -------------------------------------------------------

test('expanded API groups are saved to and restored from storage', () => {
  const storage = memoryStorage();
  assert.deepEqual(layout.loadExpandedGroups(storage), [], 'every group is collapsed until the user expands one');

  layout.saveExpandedGroups(storage, ['apps', 'gateway.networking.k8s.io']);
  assert.ok(storage.data.has('kvleva.expandedGroups'));
  assert.deepEqual(layout.loadExpandedGroups(storage), ['apps', 'gateway.networking.k8s.io']);

  layout.saveExpandedGroups(storage, []);
  assert.deepEqual(layout.loadExpandedGroups(storage), []);
});

test('no API group is expanded when nothing usable was saved about it', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
  };
  const saved = (text) => layout.loadExpandedGroups(memoryStorage({'kvleva.expandedGroups': text}));

  assert.deepEqual(layout.loadExpandedGroups(undefined), []);
  assert.deepEqual(layout.loadExpandedGroups(broken), []);
  for (const garbage of ['', 'apps', '[', 'null', '42', '"apps"', '{"apps":true}']) {
    assert.deepEqual(saved(garbage), [], garbage);
  }
  assert.deepEqual(saved('["apps",7,null,["core"],{"group":"x"},"core","apps"]'), ['apps', 'core'],
      'only names count, each once');
  assert.deepEqual(layout.loadExpandedGroups(memoryStorage({'kvleva.collapsedGroups': '["apps"]'})), [],
      'what an earlier version saved about collapsed groups says nothing about expanded ones');
  assert.doesNotThrow(() => layout.saveExpandedGroups(broken, ['apps']));
  assert.doesNotThrow(() => layout.saveExpandedGroups(undefined, ['apps']));
});

// --- Theme ---------------------------------------------------------------------

test('the theme is night until the user chooses day, and the choice is saved', () => {
  const storage = memoryStorage();
  assert.equal(layout.loadTheme(storage), 'night');

  layout.saveTheme(storage, 'day');
  assert.equal(storage.data.get('kvleva.theme'), 'day');
  assert.equal(layout.loadTheme(storage), 'day');

  layout.saveTheme(storage, 'night');
  assert.equal(layout.loadTheme(storage), 'night');
});

test('anything but a known theme means night', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
  };

  assert.equal(layout.loadTheme(undefined), 'night');
  assert.equal(layout.loadTheme(broken), 'night');
  for (const garbage of ['', 'DAY', 'light', 'dark', '"day"', '{}']) {
    assert.equal(layout.loadTheme(memoryStorage({'kvleva.theme': garbage})), 'night', garbage);
  }
  assert.doesNotThrow(() => layout.saveTheme(broken, 'day'));
  assert.doesNotThrow(() => layout.saveTheme(undefined, 'day'));
});

test('the other theme of night is day and the other way round', () => {
  assert.equal(layout.otherTheme('night'), 'day');
  assert.equal(layout.otherTheme('day'), 'night');
  assert.equal(layout.otherTheme('anything else'), 'day', 'whatever is not day counts as night');
});
