// Sample API payloads shaped exactly like docs/api.md. Every function returns a
// fresh object so tests can mutate what they get.

export const UID = {
  nsDefault: 'ns-default-uid',
  nsShop: 'ns-shop-uid',
  node: 'node-1',
  gatewayClass: 'gc-1',
  gateway: 'gw-1',
  route: 'route-1',
  service: 'svc-1',
  deployment: 'dep-1',
  replicaSet: 'rs-1',
  pod: 'pod-1',
  configMap: 'cm-1',
};

export function rollup(green = 0, yellow = 0, red = 0) {
  return {green, yellow, red};
}

/** A ResourceSummary with sensible defaults; `overrides` wins. */
export function summary(overrides = {}) {
  const health = overrides.health ?? 'green';
  return {
    uid: 'uid-x',
    kindId: 'core/ConfigMap',
    group: 'core',
    version: 'v1',
    kind: 'ConfigMap',
    namespace: 'default',
    name: 'x',
    health,
    reason: '',
    createdAt: '2026-11-14T17:00:00Z',
    childCount: 0,
    rollup: rollup(health === 'green' ? 1 : 0, health === 'yellow' ? 1 : 0, health === 'red' ? 1 : 0),
    selfMatch: true,
    path: ['ns:default'],
    refs: [],
    refsTruncated: false,
    ...overrides,
  };
}

/** A reference entry as found in ResourceSummary.refs. */
export function ref(overrides = {}) {
  return {
    uid: 'uid-target',
    kindId: 'core/ConfigMap',
    kind: 'ConfigMap',
    namespace: 'default',
    name: 'target',
    relation: 'ref',
    path: ['ns:default'],
    ...overrides,
  };
}

/** A Link as found in owners / outgoing / incoming. */
export function link(overrides = {}) {
  return {
    uid: 'uid-target',
    kindId: 'core/ConfigMap',
    kind: 'ConfigMap',
    namespace: 'default',
    name: 'target',
    health: 'green',
    path: ['ns:default'],
    relation: 'ref',
    ...overrides,
  };
}

/** A /api/resources response. */
export function page(items, {total = items.length, offset = 0, limit = 100, revision = 1042} = {}) {
  return {items, total, offset, limit, revision};
}

export function node() {
  return summary({
    uid: UID.node, kindId: 'core/Node', kind: 'Node', namespace: '',
    name: 'kvleva-control-plane', reason: 'Ready', path: ['cluster'],
  });
}

export function gateway() {
  return summary({
    uid: UID.gateway, kindId: 'gateway.networking.k8s.io/Gateway',
    group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'gw', reason: 'Programmed',
    refs: [ref({
      uid: UID.gatewayClass, kindId: 'gateway.networking.k8s.io/GatewayClass', kind: 'GatewayClass',
      namespace: '', name: 'kvleva', relation: 'gatewayClassName', path: ['cluster'],
    })],
  });
}

export function route() {
  return summary({
    uid: UID.route, kindId: 'gateway.networking.k8s.io/HTTPRoute',
    group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'route', reason: 'Accepted',
    refs: [
      ref({
        uid: UID.gateway, kindId: 'gateway.networking.k8s.io/Gateway', kind: 'Gateway',
        name: 'gw', relation: 'parentRefs',
      }),
      ref({uid: UID.service, kindId: 'core/Service', kind: 'Service', name: 'web', relation: 'backendRefs'}),
    ],
  });
}

export function service() {
  return summary({
    uid: UID.service, kindId: 'core/Service', kind: 'Service', name: 'web',
    refs: [ref({
      uid: UID.pod, kindId: 'core/Pod', kind: 'Pod', name: 'web-7d4b9c-abcde', relation: 'selector',
      path: ['ns:default', UID.deployment, UID.replicaSet],
    })],
  });
}

export function deployment() {
  return summary({
    uid: UID.deployment, kindId: 'apps/Deployment', group: 'apps', kind: 'Deployment',
    name: 'web', health: 'yellow', reason: 'Progressing', childCount: 1, rollup: rollup(1, 2, 0),
  });
}

export function replicaSet() {
  return summary({
    uid: UID.replicaSet, kindId: 'apps/ReplicaSet', group: 'apps', kind: 'ReplicaSet',
    name: 'web-7d4b9c', childCount: 1, rollup: rollup(1, 1, 0),
    path: ['ns:default', UID.deployment],
  });
}

export function pod() {
  return summary({
    uid: UID.pod, kindId: 'core/Pod', kind: 'Pod', name: 'web-7d4b9c-abcde',
    health: 'yellow', reason: 'ContainerCreating', rollup: rollup(0, 1, 0),
    path: ['ns:default', UID.deployment, UID.replicaSet],
    node: 'kvleva-control-plane',
    containers: [
      {name: 'migrate', image: 'migrate:1.0', init: true, health: 'green',
       state: 'terminated', reason: 'Completed', ready: false, restarts: 0},
      {name: 'app', image: 'nginx:1.27', init: false, health: 'yellow',
       state: 'waiting', reason: 'ContainerCreating', ready: false, restarts: 0},
    ],
    refs: [
      ref({uid: UID.node, kindId: 'core/Node', kind: 'Node', namespace: '',
           name: 'kvleva-control-plane', relation: 'nodeName', path: ['cluster']}),
      ref({uid: UID.configMap, kindId: 'core/ConfigMap', kind: 'ConfigMap',
           name: 'web-config', relation: 'volumes'}),
    ],
  });
}

export function configMap() {
  return summary({uid: UID.configMap, name: 'web-config'});
}

/** A /api/overview response for a small cluster. */
export function overview(overrides = {}) {
  return {
    cluster: {name: 'kind-kvleva', server: 'https://127.0.0.1:6443', version: 'v1.35.0'},
    revision: 1042,
    sync: {ready: true, kindsTotal: 61, kindsSynced: 61, errors: []},
    health: rollup(310, 4, 1),
    kinds: [
      {kindId: 'gateway.networking.k8s.io/Gateway', group: 'gateway.networking.k8s.io', version: 'v1',
       kind: 'Gateway', namespaced: true, count: 1, rollup: rollup(1, 0, 0)},
      {kindId: 'core/Service', group: 'core', version: 'v1', kind: 'Service',
       namespaced: true, count: 9, rollup: rollup(9, 0, 0)},
      {kindId: 'apps/Deployment', group: 'apps', version: 'v1', kind: 'Deployment',
       namespaced: true, count: 12, rollup: rollup(11, 1, 0)},
      {kindId: 'apps/ReplicaSet', group: 'apps', version: 'v1', kind: 'ReplicaSet',
       namespaced: true, count: 14, rollup: rollup(14, 0, 0)},
      {kindId: 'core/Pod', group: 'core', version: 'v1', kind: 'Pod',
       namespaced: true, count: 42, rollup: rollup(38, 3, 1)},
      {kindId: 'core/Secret', group: 'core', version: 'v1', kind: 'Secret',
       namespaced: true, count: 12, rollup: rollup(12, 0, 0)},
    ],
    namespaces: [
      {name: 'default', uid: UID.nsDefault, health: 'green', reason: 'Active',
       count: 42, rollup: rollup(40, 2, 0)},
      {name: 'shop', uid: UID.nsShop, health: 'yellow', reason: 'Terminating',
       count: 7, rollup: rollup(5, 1, 1)},
    ],
    clusterScoped: {count: 180, rollup: rollup(180, 0, 0)},
    nodes: {count: 3, rollup: rollup(3, 0, 0)},
    ...overrides,
  };
}

/** A /api/resources/{uid} response for the Deployment. */
export function detail(overrides = {}) {
  return {
    summary: deployment(),
    yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: default\nspec:\n  replicas: 3\n',
    statusYaml: 'replicas: 3\nreadyReplicas: 2\n',
    conditions: [
      {type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated', message: 'rolling out',
       lastTransitionTime: '2026-11-14T17:00:05Z', source: ''},
      {type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable', message: '',
       lastTransitionTime: '2026-11-14T16:00:00Z', source: ''},
    ],
    events: [
      {type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container',
       count: 7, firstSeen: '2026-11-14T17:00:00Z', lastSeen: '2026-11-14T17:05:00Z', source: 'kubelet'},
      {type: 'Normal', reason: 'ScalingReplicaSet', message: 'Scaled up replica set web-7d4b9c to 3',
       count: 1, firstSeen: '2026-11-14T16:59:00Z', lastSeen: '2026-11-14T16:59:00Z',
       source: 'deployment-controller'},
    ],
    eventsError: '',
    owners: [],
    outgoing: [link({uid: UID.configMap, name: 'web-config', relation: 'volumes'})],
    incoming: [link({
      uid: UID.service, kindId: 'core/Service', kind: 'Service', name: 'web', relation: 'selector',
    })],
    missing: [
      {kindId: 'core/Secret', kind: 'Secret', namespace: 'default', name: 'does-not-exist', relation: 'envFrom'},
    ],
    ...overrides,
  };
}

/** A /api/resources/{uid}/containers/{name} response. */
export function containerDetail(overrides = {}) {
  const thePod = pod();
  return {
    pod: thePod,
    container: thePod.containers[1],
    yaml: 'name: app\nimage: nginx:1.27\n',
    statusYaml: 'ready: false\nstate:\n  waiting:\n    reason: ContainerCreating\n',
    events: [
      {type: 'Normal', reason: 'Pulling', message: 'Pulling image "nginx:1.27"',
       count: 1, firstSeen: '2026-11-14T17:00:00Z', lastSeen: '2026-11-14T17:00:00Z', source: 'kubelet'},
    ],
    eventsError: '',
    ...overrides,
  };
}

/** The payload of a `change` event on /api/stream. */
export function change(overrides = {}) {
  return {revision: 1043, changed: [], deleted: [], overflow: false, ...overrides};
}
