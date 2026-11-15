// HTTP client for the kvleva backend (see docs/api.md). Read-only by
// construction: the only verb this module can issue is GET.
//
// Nothing here touches `document` or `window`; `fetch` and `EventSource` are
// injected so the module is testable and never reaches for globals at import.

const DEFAULT_LIMIT = 100;

/** An HTTP-level failure reported by the backend. */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} message Server-provided or generic message.
   */
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Query parameter selecting what a scope lists.
 * @param {{type: string, name?: string, uid?: string}} scope
 * @return {Array<Array<string>>} Zero or one [name, value] pair.
 */
function scopeParams(scope) {
  switch (scope?.type) {
    case 'namespace': return [['namespace', scope.name]];
    case 'cluster': return [['cluster', 'true']];
    case 'nodes': return [['nodes', 'true']];
    case 'parent': return [['parent', scope.uid]];
    case 'node': return [['node', scope.name]];
    case 'all': return [];
    default: throw new TypeError(`unknown scope ${JSON.stringify(scope)}`);
  }
}

/**
 * Builds the URL of a resource list request.
 * @param {{type: string, name?: string, uid?: string}} scope
 * @param {{hideKinds?: string, health?: string, q?: string, system?: string}=} query
 * @param {{offset?: number, limit?: number}=} pageRequest
 * @return {string}
 */
export function resourcesUrl(scope, query = {}, {offset = 0, limit = DEFAULT_LIMIT} = {}) {
  const params = new URLSearchParams(scopeParams(scope));
  for (const name of ['hideKinds', 'health', 'q', 'system']) {
    if (query[name]) params.set(name, query[name]);
  }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `/api/resources?${params}`;
}

/**
 * Builds the URL of the overview request. Only the system resources switch
 * applies to the overview; the other filters narrow lists.
 * @param {{system?: string}=} query
 * @return {string}
 */
export function overviewUrl(query = {}) {
  return query.system ? `/api/overview?${new URLSearchParams({system: query.system})}` : '/api/overview';
}

/**
 * Builds the URL of the details of a resource, or of one container of a Pod.
 * @param {{uid: string, container?: string}} selection
 * @return {string}
 */
function detailUrl({uid, container}) {
  const resource = `/api/resources/${encodeURIComponent(uid)}`;
  return container === undefined ? resource : `${resource}/containers/${encodeURIComponent(container)}`;
}

/**
 * Builds the URL of the live logs of a resource, or of one container of a Pod.
 * @param {{uid: string, container?: string}} selection
 * @return {string}
 */
export function logsUrl(selection) {
  return `${detailUrl(selection)}/logs`;
}

/** @return {string} `value` when it is text, otherwise no text. */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** @return {!Array<!Object>} The objects among the entries of `value`; none when it is not a list. */
function objects(value) {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && typeof entry === 'object') : [];
}

/**
 * Normalizes the payload of a `logs` event, so that what is passed on has the
 * shape of the contract whatever was sent.
 * @param {string} data Raw event data.
 * @return {?{lines: !Array<{pod: string, container: string, time: string, text: string}>,
 *           notices: !Array<{pod: string, container: string, message: string}>}}
 *     Null when the event carries nothing that can be shown.
 */
function parseLogs(data) {
  let raw = null;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const lines = objects(raw?.lines).map((line) =>
      ({pod: text(line.pod), container: text(line.container), time: text(line.time), text: text(line.text)}));
  const notices = objects(raw?.notices).map((notice) =>
      ({pod: text(notice.pod), container: text(notice.container), message: text(notice.message)}));
  return lines.length + notices.length > 0 ? {lines, notices} : null;
}

/**
 * Normalizes the payload of a `change` event. Anything that does not look like
 * the contract degrades to "refetch everything visible".
 * @param {string} data Raw event data.
 * @return {{revision: number, changed: !Array<string>, deleted: !Array<string>, overflow: boolean}}
 */
function parseChange(data) {
  let raw = null;
  try {
    raw = JSON.parse(data);
  } catch {
    raw = null;
  }
  const revision = Number.isFinite(raw?.revision) ? raw.revision : 0;
  const wellFormed = raw !== null && typeof raw === 'object' &&
      Array.isArray(raw.changed) && Array.isArray(raw.deleted);
  if (!wellFormed) return {revision, changed: [], deleted: [], overflow: true};
  return {
    revision,
    changed: raw.changed.map(String),
    deleted: raw.deleted.map(String),
    overflow: raw.overflow === true,
  };
}

/**
 * @param {{fetch: function(string, !Object): !Promise<!Response>,
 *          EventSource?: function(new: EventSource, string)}} deps
 * @return {!Object} The API client.
 */
export function createApi({fetch, EventSource}) {
  async function get(url) {
    const response = await fetch(url, {method: 'GET', headers: {Accept: 'application/json'}});
    if (!response.ok) {
      let message = `request failed with status ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body?.error === 'string' && body.error) message = body.error;
      } catch {
        // Not JSON: keep the generic message.
      }
      throw new ApiError(response.status, message);
    }
    return response.json();
  }

  return {
    overview: (query) => get(overviewUrl(query)),

    resources: async (scope, query, pageRequest) => get(resourcesUrl(scope, query, pageRequest)),

    resource: (uid) => get(detailUrl({uid})),

    container: (uid, name) => get(detailUrl({uid, container: name})),

    /**
     * Opens the live logs of a resource, or of one container of a Pod.
     * `onBatch` hears the lines and notices of every event; `onState` hears
     * 'open' and, once, 'ended'. Unlike the change stream this one is not
     * left to reconnect: a new connection starts with the most recent lines
     * again, which would repeat what was already delivered. So when the
     * stream fails or the server ends it, it is closed for good.
     * @param {{uid: string, container?: string}} selection
     * @param {{onBatch: function(!Object), onState?: function(string)}} callbacks
     * @return {function()} Closes the stream; nothing is reported afterwards.
     */
    logs(selection, {onBatch, onState = () => {}}) {
      const source = new EventSource(logsUrl(selection));
      let open = true;
      const close = () => {
        open = false;
        source.close();
      };
      source.addEventListener('logs', (event) => {
        const batch = open ? parseLogs(event.data) : null;
        if (batch) onBatch(batch);
      });
      source.addEventListener('open', () => {
        if (open) onState('open');
      });
      source.addEventListener('error', () => {
        if (!open) return;
        close();
        onState('ended');
      });
      return close;
    },

    /**
     * Opens the change stream. EventSource reconnects on its own; `onState`
     * hears 'open' and 'reconnecting'.
     * @return {function()} Closes the stream.
     */
    subscribe({onChange, onState = () => {}}) {
      const source = new EventSource('/api/stream');
      source.addEventListener('change', (event) => onChange(parseChange(event.data)));
      source.addEventListener('open', () => onState('open'));
      source.addEventListener('error', () => onState('reconnecting'));
      return () => source.close();
    },
  };
}
