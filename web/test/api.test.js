import test from 'node:test';
import assert from 'node:assert/strict';

import * as apiModule from '../static/js/api.js';
import * as fx from './fixtures.js';
import {FakeEventSource} from './helpers.js';

/**
 * A fetch double that records every call and answers with real Response
 * objects, so the code under test exercises the genuine Response interface.
 */
function recordingFetch(respond = () => ({status: 200, body: {}})) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    const {status = 200, body = {}, text} = respond(url);
    return new Response(text ?? JSON.stringify(body), {
      status, headers: {'content-type': text === undefined ? 'application/json' : 'text/plain'},
    });
  };
  return {fetch, calls};
}

function parse(url) {
  const u = new URL(url, 'http://localhost');
  return {path: u.pathname, params: Object.fromEntries(u.searchParams.entries())};
}

test('overview requests /api/overview and returns the parsed body', async () => {
  const {fetch, calls} = recordingFetch(() => ({body: fx.overview()}));
  const api = apiModule.createApi({fetch});

  const got = await api.overview();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/overview');
  assert.deepEqual(got, fx.overview());
});

test('overview and lists ask for system resources only when the switch is on', async () => {
  const {fetch, calls} = recordingFetch((url) => ({body: url.startsWith('/api/overview') ? fx.overview() : fx.page([])}));
  const api = apiModule.createApi({fetch});

  await api.overview({});
  await api.overview({system: 'true'});
  await api.resources({type: 'namespace', name: 'default'}, {});
  await api.resources({type: 'namespace', name: 'default'}, {system: 'true', q: 'web'});

  assert.equal(calls[0].url, '/api/overview');
  assert.equal(calls[1].url, '/api/overview?system=true');
  assert.deepEqual(parse(calls[2].url).params, {namespace: 'default', limit: '100', offset: '0'});
  assert.deepEqual(parse(calls[3].url).params,
      {namespace: 'default', q: 'web', system: 'true', limit: '100', offset: '0'});
});

test('resources maps each scope to its single scope parameter', async () => {
  const cases = [
    {scope: {type: 'namespace', name: 'default'}, want: {namespace: 'default'}},
    {scope: {type: 'cluster'}, want: {cluster: 'true'}},
    {scope: {type: 'nodes'}, want: {nodes: 'true'}},
    {scope: {type: 'parent', uid: 'dep-1'}, want: {parent: 'dep-1'}},
    {scope: {type: 'node', name: 'kvleva-control-plane'}, want: {node: 'kvleva-control-plane'}},
    {scope: {type: 'all'}, want: {}},
  ];
  for (const {scope, want} of cases) {
    const {fetch, calls} = recordingFetch(() => ({body: fx.page([])}));
    const api = apiModule.createApi({fetch});

    await api.resources(scope);

    const {path, params} = parse(calls[0].url);
    assert.equal(path, '/api/resources', JSON.stringify(scope));
    assert.deepEqual(params, {...want, limit: '100', offset: '0'}, JSON.stringify(scope));
  }
});

test('resources sends filter parameters and the requested page', async () => {
  const {fetch, calls} = recordingFetch(() => ({body: fx.page([fx.pod()], {total: 250, offset: 100})}));
  const api = apiModule.createApi({fetch});

  const got = await api.resources(
      {type: 'namespace', name: 'default'},
      {hideKinds: 'core/Secret,apps/ReplicaSet', health: 'red,yellow', q: 'web'},
      {offset: 100, limit: 200});

  assert.deepEqual(parse(calls[0].url).params, {
    namespace: 'default', hideKinds: 'core/Secret,apps/ReplicaSet', health: 'red,yellow', q: 'web',
    limit: '200', offset: '100',
  });
  assert.equal(got.total, 250);
  assert.equal(got.items[0].uid, fx.UID.pod);
});

test('resources omits empty filter parameters', async () => {
  const {fetch, calls} = recordingFetch(() => ({body: fx.page([])}));
  const api = apiModule.createApi({fetch});

  await api.resources({type: 'cluster'}, {hideKinds: '', health: undefined, q: ''});

  assert.deepEqual(parse(calls[0].url).params, {cluster: 'true', limit: '100', offset: '0'});
});

test('resources rejects an unknown scope instead of listing everything', async () => {
  const {fetch, calls} = recordingFetch();
  const api = apiModule.createApi({fetch});

  await assert.rejects(() => api.resources({type: 'bogus'}), /scope/);
  assert.equal(calls.length, 0);
});

test('values from the cluster are percent-encoded in URLs', async () => {
  const {fetch, calls} = recordingFetch(() => ({body: {}}));
  const api = apiModule.createApi({fetch});

  await api.resources({type: 'namespace', name: 'a&b=c'}, {q: 'x y&limit=1'});
  await api.resource('a/b?c');
  await api.container('pod/1', 'app #1');

  assert.deepEqual(parse(calls[0].url).params, {namespace: 'a&b=c', q: 'x y&limit=1', limit: '100', offset: '0'});
  assert.equal(calls[1].url, '/api/resources/a%2Fb%3Fc');
  assert.equal(calls[2].url, '/api/resources/pod%2F1/containers/app%20%231');
});

test('resource and container request the detail endpoints', async () => {
  const {fetch, calls} = recordingFetch((url) =>
      ({body: url.includes('/containers/') ? fx.containerDetail() : fx.detail()}));
  const api = apiModule.createApi({fetch});

  const detail = await api.resource(fx.UID.deployment);
  const container = await api.container(fx.UID.pod, 'app');

  assert.equal(calls[0].url, '/api/resources/dep-1');
  assert.equal(calls[1].url, '/api/resources/pod-1/containers/app');
  assert.equal(detail.summary.uid, fx.UID.deployment);
  assert.equal(container.container.name, 'app');
});

test('a non-2xx response rejects with the status and the server message', async () => {
  const {fetch} = recordingFetch(() => ({status: 404, body: {error: 'resource not found'}}));
  const api = apiModule.createApi({fetch});

  await assert.rejects(() => api.resource('gone'), (err) => {
    assert.ok(err instanceof apiModule.ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.message, 'resource not found');
    return true;
  });
});

test('a non-JSON error response still rejects with its status', async () => {
  const {fetch} = recordingFetch(() => ({status: 502, text: '<html>bad gateway</html>'}));
  const api = apiModule.createApi({fetch});

  await assert.rejects(() => api.overview(), (err) => {
    assert.ok(err instanceof apiModule.ApiError);
    assert.equal(err.status, 502);
    assert.match(err.message, /502/);
    return true;
  });
});

test('every request the api module issues is a GET without a body', async () => {
  const {fetch, calls} = recordingFetch(() => ({body: {}}));
  const api = apiModule.createApi({fetch, EventSource: FakeEventSource});

  await api.overview();
  for (const type of ['namespace', 'cluster', 'nodes', 'parent', 'node', 'all']) {
    await api.resources({type, name: 'n', uid: 'u'}, {q: 'x'}, {offset: 100});
  }
  await api.resource('u');
  await api.container('u', 'c');

  assert.equal(calls.length, 9);
  for (const {url, init} of calls) {
    assert.equal(init?.method, 'GET', url);
    assert.equal(init?.body, undefined, url);
  }
});

test('subscribe opens /api/stream once and delivers parsed change events', () => {
  FakeEventSource.instances.length = 0;
  const api = apiModule.createApi({fetch: recordingFetch().fetch, EventSource: FakeEventSource});
  const changes = [];

  api.subscribe({onChange: (c) => changes.push(c)});
  const [source] = FakeEventSource.instances;
  source.emit('change', {data: JSON.stringify(fx.change({changed: ['pod-1'], deleted: ['cm-1']}))});

  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(source.url, '/api/stream');
  assert.deepEqual(changes, [{revision: 1043, changed: ['pod-1'], deleted: ['cm-1'], overflow: false}]);
});

test('subscribe treats a malformed change event as "refetch everything"', () => {
  FakeEventSource.instances.length = 0;
  const api = apiModule.createApi({fetch: recordingFetch().fetch, EventSource: FakeEventSource});
  const changes = [];

  api.subscribe({onChange: (c) => changes.push(c)});
  const [source] = FakeEventSource.instances;
  source.emit('change', {data: '{not json'});
  source.emit('change', {data: JSON.stringify({revision: 7, changed: 'pod-1'})});

  assert.deepEqual(changes, [
    {revision: 0, changed: [], deleted: [], overflow: true},
    {revision: 7, changed: [], deleted: [], overflow: true},
  ]);
});

test('subscribe reports connection state and can be closed', () => {
  FakeEventSource.instances.length = 0;
  const api = apiModule.createApi({fetch: recordingFetch().fetch, EventSource: FakeEventSource});
  const states = [];

  const close = api.subscribe({onChange() {}, onState: (s) => states.push(s)});
  const [source] = FakeEventSource.instances;
  source.emit('error');
  source.emit('open');
  close();

  assert.deepEqual(states, ['reconnecting', 'open']);
  assert.equal(source.closed, true);
});

// --- Live logs ---------------------------------------------------------------

/** Opens a log stream on a fresh api client and records what it reports. */
function followLogs(selection = {uid: fx.UID.pod}) {
  FakeEventSource.instances.length = 0;
  const {fetch, calls} = recordingFetch();
  const api = apiModule.createApi({fetch, EventSource: FakeEventSource});
  const batches = [];
  const states = [];
  const close = api.logs(selection, {onBatch: (batch) => batches.push(batch), onState: (state) => states.push(state)});
  return {source: FakeEventSource.instances[0], batches, states, close, fetchCalls: calls};
}

test('logsUrl names the logs of a resource, or of one container of a Pod', () => {
  assert.equal(apiModule.logsUrl({uid: 'dep-1'}), '/api/resources/dep-1/logs');
  assert.equal(apiModule.logsUrl({uid: 'pod-1', container: 'app'}), '/api/resources/pod-1/containers/app/logs');
});

test('logsUrl percent-encodes the uid and the container name', () => {
  assert.equal(apiModule.logsUrl({uid: 'a/b?c'}), '/api/resources/a%2Fb%3Fc/logs');
  assert.equal(apiModule.logsUrl({uid: 'pod/1', container: 'app #1'}),
      '/api/resources/pod%2F1/containers/app%20%231/logs');
});

test('logs opens one event stream on the logs URL of the selection and fetches nothing', () => {
  const resource = followLogs({uid: 'a/b?c'});
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(resource.source.url, '/api/resources/a%2Fb%3Fc/logs');
  assert.equal(resource.source.closed, false);
  assert.deepEqual(resource.fetchCalls, []);

  const container = followLogs({uid: 'pod/1', container: 'app #1'});
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(container.source.url, '/api/resources/pod%2F1/containers/app%20%231/logs');
});

test('a logs event delivers its lines and notices', () => {
  const {source, batches} = followLogs();
  const first = fx.logBatch([fx.logLine(), fx.logLine({container: 'sidecar', text: 'proxy ready'})]);
  const second = fx.logBatch([], [fx.logNotice()]);

  source.logs(first);
  source.logs(second);

  assert.deepEqual(batches, [first, second]);
});

test('a logs event that is not the documented JSON is ignored', () => {
  const {source, batches, states} = followLogs();

  for (const data of ['{not json', '', 'null', '42', '"text"', '[]', '{"lines": "x", "notices": 7}',
                      '{"lines": [], "notices": []}']) {
    source.emit('logs', {data});
  }
  source.emit('logs', {});

  assert.deepEqual(batches, []);
  assert.deepEqual(states, [], 'and the stream is not given up for it');
  assert.equal(source.closed, false);
});

test('entries of a logs event that are not objects are skipped and missing fields are empty text', () => {
  const {source, batches} = followLogs();

  source.logs({
    lines: [null, 'x', {text: 'only text'}, {pod: 1, container: {}, time: 5, text: ['no']}, fx.logLine()],
    notices: [7, {message: 'only a message'}],
  });
  source.logs({notices: [fx.logNotice()]});

  assert.deepEqual(batches, [
    {
      lines: [
        {pod: '', container: '', time: '', text: 'only text'},
        {pod: '', container: '', time: '', text: ''},
        fx.logLine(),
      ],
      notices: [{pod: '', container: '', message: 'only a message'}],
    },
    {lines: [], notices: [fx.logNotice()]},
  ]);
});

test('logs reports when the stream is open', () => {
  const {source, states} = followLogs();

  source.emit('open');

  assert.deepEqual(states, ['open']);
});

test('a log stream that fails is closed for good, since a reconnect would repeat lines, and its end is reported', () => {
  const {source, states, batches} = followLogs();

  source.emit('error');

  assert.equal(source.closed, true, 'EventSource must not reconnect on its own');
  assert.deepEqual(states, ['ended']);

  source.emit('error');
  source.logs(fx.logBatch());
  assert.deepEqual(states, ['ended'], 'the end is reported once');
  assert.deepEqual(batches, []);
});

test('the function that logs returns closes the stream, and nothing is reported afterwards', () => {
  const {source, states, batches, close} = followLogs();

  close();

  assert.equal(source.closed, true);
  source.logs(fx.logBatch());
  source.emit('open');
  source.emit('error');
  assert.deepEqual(batches, []);
  assert.deepEqual(states, []);
});

test('logs works without a state callback', () => {
  FakeEventSource.instances.length = 0;
  const api = apiModule.createApi({fetch: recordingFetch().fetch, EventSource: FakeEventSource});
  const batches = [];

  api.logs({uid: fx.UID.pod}, {onBatch: (batch) => batches.push(batch)});
  const [source] = FakeEventSource.instances;
  source.emit('open');
  source.logs(fx.logBatch());
  source.emit('error');

  assert.deepEqual(batches, [fx.logBatch()]);
  assert.equal(source.closed, true);
});
