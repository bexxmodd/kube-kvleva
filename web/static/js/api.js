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
 * @param {{hideKinds?: string, health?: string, q?: string}=} query
 * @param {{offset?: number, limit?: number}=} pageRequest
 * @return {string}
 */
export function resourcesUrl(scope, query = {}, {offset = 0, limit = DEFAULT_LIMIT} = {}) {
  const params = new URLSearchParams(scopeParams(scope));
  for (const name of ['hideKinds', 'health', 'q']) {
    if (query[name]) params.set(name, query[name]);
  }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `/api/resources?${params}`;
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
    overview: () => get('/api/overview'),

    resources: async (scope, query, pageRequest) => get(resourcesUrl(scope, query, pageRequest)),

    resource: (uid) => get(`/api/resources/${encodeURIComponent(uid)}`),

    container: (uid, name) =>
        get(`/api/resources/${encodeURIComponent(uid)}/containers/${encodeURIComponent(name)}`),

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
