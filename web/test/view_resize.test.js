import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';

import * as viewModule from '../static/js/view.js';
import {assertNoPageErrors, fire, loadShell, recorder} from './helpers.js';

afterEach(assertNoPageErrors);

/** Mounts the view in a window of the given width. */
function mount({windowWidth = 1200} = {}) {
  const {document, window} = loadShell();
  window.innerWidth = windowWidth;
  const {handlers, calls} = recorder();
  const view = viewModule.createView(document, handlers);
  const $ = (selector) => document.querySelector(selector);
  return {document, window, view, calls, $, sidebar: $('#sidebar'), divider: $('#sidebar-resizer')};
}

/**
 * Presses the mouse on the divider, moves it to each x in turn, releases.
 * The pointer leaves the thin divider while dragging, so moves and the
 * release happen elsewhere on the page.
 */
function drag({document, divider}, ...xs) {
  fire(divider, 'mousedown', {clientX: 260, button: 0});
  for (const x of xs) fire(document.body, 'mousemove', {clientX: x});
  fire(document.body, 'mouseup', {clientX: xs.at(-1)});
}

test('dragging the divider makes the filters panel follow the pointer', () => {
  const m = mount();

  fire(m.divider, 'mousedown', {clientX: 260, button: 0});
  fire(m.document.body, 'mousemove', {clientX: 300});
  assert.equal(m.sidebar.style.width, '300px');
  fire(m.document.body, 'mousemove', {clientX: 350});
  assert.equal(m.sidebar.style.width, '350px');
  fire(m.document.body, 'mousemove', {clientX: 220});
  assert.equal(m.sidebar.style.width, '220px', 'and back again');
});

test('the chosen width is reported once, when the mouse is released', () => {
  const m = mount();

  drag(m, 300, 320, 345);

  assert.deepEqual(m.calls, [['onSidebarWidth', 345]]);
});

test('the filters panel cannot be dragged wider than a third of the window', () => {
  const m = mount({windowWidth: 1200});

  drag(m, 500, 1100);

  assert.equal(m.sidebar.style.width, '400px');
  assert.deepEqual(m.calls, [['onSidebarWidth', 400]]);
});

test('the limit follows the width of the window', () => {
  const m = mount({windowWidth: 900});

  drag(m, 800);

  assert.equal(m.sidebar.style.width, '300px');
});

test('the filters panel cannot be dragged narrower than its minimum', () => {
  const m = mount();

  drag(m, 5);

  assert.equal(m.sidebar.style.width, '180px');
  assert.deepEqual(m.calls, [['onSidebarWidth', 180]]);
});

test('moving the mouse without holding the divider changes nothing', () => {
  const m = mount();

  fire(m.document.body, 'mousemove', {clientX: 400});
  assert.equal(m.sidebar.style.width, '', 'before any drag');

  drag(m, 300);
  fire(m.document.body, 'mousemove', {clientX: 380});
  fire(m.document.body, 'mouseup', {clientX: 380});

  assert.equal(m.sidebar.style.width, '300px', 'after the drag ended');
  assert.deepEqual(m.calls, [['onSidebarWidth', 300]]);
});

test('only the main mouse button starts a drag', () => {
  const m = mount();

  fire(m.divider, 'mousedown', {clientX: 260, button: 2});
  fire(m.document.body, 'mousemove', {clientX: 330});

  assert.equal(m.sidebar.style.width, '');
});

test('while dragging, the page shows the resize cursor everywhere and selects no text', () => {
  const m = mount();

  const press = fire(m.divider, 'mousedown', {clientX: 260, button: 0});
  assert.equal(press.defaultPrevented, true, 'so the drag does not select text');
  assert.ok(m.document.body.classList.contains('resizing-panel'));

  fire(m.document.body, 'mouseup', {clientX: 300});
  assert.equal(m.document.body.classList.contains('resizing-panel'), false);
});

test('the arrow keys move the focused divider in steps', () => {
  const m = mount();
  m.view.setSidebarWidth(300);

  fire(m.divider, 'keydown', {key: 'ArrowRight'});
  assert.equal(m.sidebar.style.width, '316px');
  fire(m.divider, 'keydown', {key: 'ArrowLeft'});
  fire(m.divider, 'keydown', {key: 'ArrowLeft'});
  assert.equal(m.sidebar.style.width, '284px');

  assert.deepEqual(m.calls, [['onSidebarWidth', 316], ['onSidebarWidth', 300], ['onSidebarWidth', 284]]);
});

test('the arrow keys start from the default width and respect the limits', () => {
  const m = mount({windowWidth: 810});

  fire(m.divider, 'keydown', {key: 'ArrowRight'});
  assert.equal(m.sidebar.style.width, '270px', 'a third of 810, not 260 + 16');

  fire(m.divider, 'keydown', {key: 'Enter'});
  assert.equal(m.sidebar.style.width, '270px', 'other keys do nothing');
});

test('a restored width is applied within the limits of the current window', () => {
  const wide = mount({windowWidth: 1200});
  wide.view.setSidebarWidth(380);
  assert.equal(wide.sidebar.style.width, '380px');

  const narrow = mount({windowWidth: 900});
  narrow.view.setSidebarWidth(380);
  assert.equal(narrow.sidebar.style.width, '300px', 'saved on a wider window');

  assert.deepEqual([...wide.calls, ...narrow.calls], [], 'restoring is not reported as a choice');
});

test('without a restored width the filters panel keeps its default size', () => {
  const m = mount();

  m.view.setSidebarWidth(null);

  assert.equal(m.sidebar.style.width, '');
});

test('the divider tells assistive technology the current width and its limits', () => {
  const m = mount({windowWidth: 1200});

  assert.equal(m.divider.getAttribute('aria-valuenow'), '260');
  assert.equal(m.divider.getAttribute('aria-valuemin'), '180');
  assert.equal(m.divider.getAttribute('aria-valuemax'), '400');

  drag(m, 333);
  assert.equal(m.divider.getAttribute('aria-valuenow'), '333');
});

// --- Hiding the filters panel --------------------------------------------------

test('the filters panel starts shown and its button says so', () => {
  const m = mount();
  const button = m.$('#sidebar-toggle');

  assert.equal(m.sidebar.hidden, false);
  assert.equal(m.divider.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.match(button.title, /hide/i);
});

test('the button hides the filters panel together with its divider, and shows them again', () => {
  const m = mount();
  const button = m.$('#sidebar-toggle');

  button.click();
  assert.equal(m.sidebar.hidden, true);
  assert.equal(m.divider.hidden, true, 'nothing is left to drag');
  assert.equal(button.hidden, false, 'the way back stays available');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.match(button.title, /show/i);

  button.click();
  assert.equal(m.sidebar.hidden, false);
  assert.equal(m.divider.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');

  assert.deepEqual(m.calls, [['onSidebarHidden', true], ['onSidebarHidden', false]]);
});

test('a hidden filters panel comes back with the width it had', () => {
  const m = mount();
  drag(m, 333);
  m.calls.length = 0;

  m.$('#sidebar-toggle').click();
  m.$('#sidebar-toggle').click();

  assert.equal(m.sidebar.style.width, '333px');
});

test('hiding the filters panel while using it moves the keyboard focus to the button', () => {
  const m = mount();
  m.$('#kind-search').focus();

  m.view.setSidebarHidden(true);

  assert.equal(m.document.activeElement, m.$('#sidebar-toggle'), 'focus must not be lost in a hidden panel');
});

test('hiding the filters panel leaves the focus alone when it is elsewhere', () => {
  const m = mount();
  m.$('#search').focus();

  m.view.setSidebarHidden(true);

  assert.equal(m.document.activeElement, m.$('#search'));
});

test('a restored hidden state is applied without being reported as a choice', () => {
  const m = mount();

  m.view.setSidebarHidden(true);

  assert.equal(m.sidebar.hidden, true);
  assert.equal(m.$('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(m.calls, []);
});

// --- Resizing the details panel ------------------------------------------------
// The details panel sits at the right edge of the window, so its divider is on
// its left: dragging to the left makes the panel wider.

/** Mounts the view with the details panel open. */
function mountWithDetails(options) {
  const m = mount(options);
  m.view.renderDrawer({state: 'loading', selection: {uid: 'dep-1'}});
  return {...m, drawer: m.$('#drawer'), divider: m.$('#drawer-resizer')};
}

test('the divider of the details panel is only there while the panel is open', () => {
  const m = mount();
  const divider = m.$('#drawer-resizer');
  assert.equal(divider.hidden, true, 'closed panel, nothing to drag');

  m.view.renderDrawer({state: 'loading', selection: {uid: 'dep-1'}});
  assert.equal(divider.hidden, false);

  m.view.renderDrawer({state: 'closed'});
  assert.equal(divider.hidden, true);
});

test('dragging its divider to the left makes the details panel wider', () => {
  const m = mountWithDetails({windowWidth: 1500});

  fire(m.divider, 'mousedown', {clientX: 1020, button: 0});
  fire(m.document.body, 'mousemove', {clientX: 1100});
  assert.equal(m.drawer.style.width, '400px', 'from the pointer to the right edge of the window');
  fire(m.document.body, 'mousemove', {clientX: 1050});
  assert.equal(m.drawer.style.width, '450px');
  fire(m.document.body, 'mouseup', {clientX: 1050});

  assert.deepEqual(m.calls, [['onDrawerWidth', 450]]);
  assert.equal(m.sidebar.style.width, '', 'the filters panel is not affected');
});

test('the details panel cannot be dragged wider than a third of the window', () => {
  const m = mountWithDetails({windowWidth: 1500});

  drag(m, 300);

  assert.equal(m.drawer.style.width, '500px');
  assert.deepEqual(m.calls, [['onDrawerWidth', 500]]);
});

test('the details panel cannot be dragged narrower than its minimum', () => {
  const m = mountWithDetails({windowWidth: 1500});

  drag(m, 1490);

  assert.equal(m.drawer.style.width, '280px');
});

test('dragging the details divider shows the resize cursor and does not move the filters panel', () => {
  const m = mountWithDetails({windowWidth: 1500});

  fire(m.divider, 'mousedown', {clientX: 1020, button: 0});
  assert.ok(m.document.body.classList.contains('resizing-panel'));
  fire(m.document.body, 'mousemove', {clientX: 1080});
  fire(m.document.body, 'mouseup', {clientX: 1080});

  assert.equal(m.document.body.classList.contains('resizing-panel'), false);
  assert.equal(m.sidebar.style.width, '');
});

test('the arrow keys move the details divider: left is wider, right is narrower', () => {
  const m = mountWithDetails({windowWidth: 1500});
  m.view.setDrawerWidth(400);

  fire(m.divider, 'keydown', {key: 'ArrowLeft'});
  assert.equal(m.drawer.style.width, '416px');
  fire(m.divider, 'keydown', {key: 'ArrowRight'});
  fire(m.divider, 'keydown', {key: 'ArrowRight'});
  assert.equal(m.drawer.style.width, '384px');

  assert.deepEqual(m.calls, [['onDrawerWidth', 416], ['onDrawerWidth', 400], ['onDrawerWidth', 384]]);
});

test('a restored details panel width is applied within the limits, also before the panel is opened', () => {
  const m = mount({windowWidth: 1200});

  m.view.setDrawerWidth(470);
  m.view.renderDrawer({state: 'loading', selection: {uid: 'dep-1'}});

  assert.equal(m.$('#drawer').style.width, '400px', 'saved on a wider window: a third of 1200 now');
  assert.deepEqual(m.calls, []);

  m.view.setDrawerWidth(null);
  assert.equal(m.$('#drawer').style.width, '', 'no chosen width: the default from the stylesheet');
});

test('the details divider tells assistive technology the current width and its limits', () => {
  const m = mountWithDetails({windowWidth: 1500});

  assert.equal(m.divider.getAttribute('aria-valuenow'), '480');
  assert.equal(m.divider.getAttribute('aria-valuemin'), '280');
  assert.equal(m.divider.getAttribute('aria-valuemax'), '500');
});
