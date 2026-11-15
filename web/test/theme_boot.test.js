import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

import * as layout from '../static/js/layout.js';

// js/theme-boot.js is the one script that is not a module: the page loads it
// in the head so that it runs before anything is drawn. These tests run the
// real file inside a page, the way a browser does.

const BOOT = new URL('../static/js/theme-boot.js', import.meta.url);

/**
 * Runs the boot script in a fresh page.
 * @param {function(!Window)=} prepare Called with the window before the script runs.
 * @return {!Element} The root element of the page afterwards.
 */
function bootPage(prepare = () => {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
      {url: 'http://localhost/', runScripts: 'outside-only'});
  prepare(dom.window);
  dom.window.eval(readFileSync(BOOT, 'utf8'));
  return dom.window.document.documentElement;
}

test('a remembered day theme is applied to the page before it is drawn', () => {
  const root = bootPage((window) => layout.saveTheme(window.localStorage, 'day'));

  assert.equal(root.dataset.theme, 'day');
});

test('without a remembered theme the page stays in the night theme', () => {
  assert.equal(bootPage().hasAttribute('data-theme'), false);
  assert.equal(bootPage((window) => layout.saveTheme(window.localStorage, 'night')).hasAttribute('data-theme'), false);
});

test('anything else in storage is ignored', () => {
  for (const garbage of ['', 'DAY', 'light', '"day"', 'day"><script>', '{}']) {
    const root = bootPage((window) => window.localStorage.setItem('kvleva.theme', garbage));
    assert.equal(root.hasAttribute('data-theme'), false, garbage);
  }
});

test('a browser that forbids storage still gets the page, in the night theme', () => {
  const root = bootPage((window) => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
  });

  assert.equal(root.hasAttribute('data-theme'), false);
});

test('the boot script leaves nothing behind in the page', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
      {url: 'http://localhost/', runScripts: 'outside-only'});
  const before = new Set(Object.getOwnPropertyNames(dom.window));

  dom.window.eval(readFileSync(BOOT, 'utf8'));

  assert.deepEqual(Object.getOwnPropertyNames(dom.window).filter((name) => !before.has(name)), []);
});
