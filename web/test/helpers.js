// Shared test doubles. These stand in for collaborators of the code under test
// (the clock, the network, the event stream, storage, the page); never for the
// code itself.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';

// --- Time and promises -------------------------------------------------------

/** A manually advanced clock with the setTimeout / clearTimeout contract. */
export function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.set(id, {at: now + Math.max(0, ms), fn, id});
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Moves time forward, running due timers in order. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.at <= end && (next === null || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) {
            next = timer;
          }
        }
        if (next === null) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

/** Lets every already-resolved promise chain run to completion. */
export async function flush() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A promise that the test settles by hand. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

/** An in-memory Storage double. */
export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

// --- DOM ---------------------------------------------------------------------

const SHELL = new URL('../static/index.html', import.meta.url);

/** Errors thrown inside event listeners of the pages loaded so far. */
const pageErrors = [];

/**
 * jsdom, like a browser, does not propagate an exception thrown by an event
 * listener to the code that dispatched the event. Register this as an
 * `afterEach` hook so that such an exception fails the test that caused it.
 */
export function assertNoPageErrors() {
  const errors = pageErrors.splice(0);
  assert.deepEqual(errors.map((e) => e.detail?.stack ?? e.stack ?? String(e)), [], 'uncaught error in the page');
}

/**
 * Loads the real static shell into a fresh jsdom document. jsdom does not run
 * the page's scripts; tests drive the modules directly.
 */
export function loadShell() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => pageErrors.push(error));
  const dom = new JSDOM(readFileSync(SHELL, 'utf8'),
      {url: 'http://localhost/', pretendToBeVisual: true, virtualConsole});
  return {dom, window: dom.window, document: dom.window.document};
}

/**
 * Handlers that record how the view called them: `calls` holds
 * [handlerName, ...arguments] entries in order.
 */
export function recorder(results = {}) {
  const calls = [];
  const handlers = new Proxy({}, {
    get: (_, name) => (...args) => {
      calls.push([name, ...args]);
      return results[name];
    },
  });
  return {handlers, calls};
}

/** Dispatches a bubbling event of the given type on an element (or a window). */
export function fire(element, type, init = {}) {
  const view = element.ownerDocument?.defaultView ?? element;
  const EventClass = type.startsWith('key') ? view.KeyboardEvent :
      type.startsWith('mouse') || type === 'click' ? view.MouseEvent : view.Event;
  const event = new EventClass(type, {bubbles: true, cancelable: true, ...init});
  element.dispatchEvent(event);
  return event;
}

/** Types text into an input the way a user would (value, then `input`). */
export function type(input, text) {
  input.value = text;
  fire(input, 'input');
}

// --- Backend -----------------------------------------------------------------

/** An EventSource double: tests emit events, the code under test listens. */
export class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(eventType, fn) {
    (this.listeners[eventType] ??= []).push(fn);
  }

  close() {
    this.closed = true;
  }

  emit(eventType, event = {}) {
    for (const fn of this.listeners[eventType] ?? []) fn(event);
  }

  /** Emits a `change` event carrying the given payload. */
  change(payload) {
    this.emit('change', {data: JSON.stringify(payload)});
  }
}

/**
 * An in-memory backend that speaks the HTTP contract of docs/api.md through a
 * `fetch` function and answers with real Response objects.
 *
 * `lists` maps a scope ("namespace=default", "cluster=true", "nodes=true",
 * "parent=<uid>", "node=<name>") to the full list of that scope, or to a
 * function of the query parameters returning it; pagination is applied here.
 * `details` maps a uid to a detail body; `containers` maps "<uid>/<name>".
 * Filter parameters are recorded but only interpreted by list functions.
 */
export function fakeBackend({overview, lists = {}, details = {}, containers = {}} = {}) {
  const requests = [];
  const backend = {
    overview, lists, details, containers, requests,
    /** When set, every request fails with this status. */
    failWith: null,
    /** When set, called with the request and awaited before answering. */
    gate: null,
    /** Query parameters of every list request so far. */
    listRequests: () => requests.filter((r) => r.path === '/api/resources').map((r) => r.params),
    /** Paths (with query) of every request so far. */
    urls: () => requests.map((r) => r.url),
    forget: () => {
      requests.length = 0;
    },
  };

  const json = (status, body) =>
      new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

  backend.fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost');
    const params = Object.fromEntries(parsed.searchParams.entries());
    const request = {url, method: init.method ?? 'GET', path: parsed.pathname, params, body: init.body};
    requests.push(request);
    if (backend.gate) await backend.gate(request);
    if (backend.failWith) return json(backend.failWith, {error: 'backend unavailable'});

    // `overview` may be a function of the query parameters, for tests in
    // which the answer depends on the system resources switch.
    const overviewFor = (query) => (typeof backend.overview === 'function' ? backend.overview(query) : backend.overview);

    if (parsed.pathname === '/api/overview') return json(200, overviewFor(params));

    if (parsed.pathname === '/api/resources') {
      const scope = ['namespace', 'cluster', 'nodes', 'parent', 'node'].find((name) => name in params);
      const source = backend.lists[scope ? `${scope}=${params[scope]}` : 'all'] ?? [];
      const all = typeof source === 'function' ? source(params) : source;
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? 100);
      return json(200, {
        items: all.slice(offset, offset + limit), total: all.length, offset, limit,
        revision: overviewFor(params).revision,
      });
    }

    const match = /^\/api\/resources\/([^/]+)(?:\/containers\/([^/]+))?$/.exec(parsed.pathname);
    if (match) {
      const uid = decodeURIComponent(match[1]);
      const body = match[2] === undefined ?
          backend.details[uid] : backend.containers[`${uid}/${decodeURIComponent(match[2])}`];
      return body ? json(200, body) : json(404, {error: 'resource not found'});
    }
    return json(404, {error: 'not found'});
  };
  return backend;
}
