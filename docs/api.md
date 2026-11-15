# kvleva HTTP API

The backend serves a small **read-only** JSON API to the browser UI. This file is
the contract between `internal/server` (Go) and `web/static` (JavaScript).

## Ground rules

- Every endpoint is `GET` (or `HEAD`). Any other method returns `405`.
- The server only answers requests that come from the local machine and that
  carry a loopback `Host` header (`localhost`, `127.0.0.1`, `[::1]`). Anything
  else returns `403`.
- Responses are `application/json` unless noted. Errors are
  `{"error": "<message>"}` with a non-2xx status.
- All timestamps are RFC 3339 strings. Absent optional fields are omitted.

## Vocabulary

| Term | Meaning |
|---|---|
| `uid` | The Kubernetes `metadata.uid` of a resource. Primary key everywhere. |
| `kindId` | `<group>/<Kind>`; the core group is spelled `core`. Examples: `core/Pod`, `apps/Deployment`, `gateway.networking.k8s.io/HTTPRoute`. |
| `health` | `"green"` (configured / reconciled), `"yellow"` (in progress, pending, or stuck), `"red"` (failed). |
| `rollup` | `{"green": n, "yellow": n, "red": n}` — health counts of a resource **and all of its descendants**. |
| parent / child | Containment used for nesting widgets. A resource is the child of its controller owner (`metadata.ownerReferences`) when both live in the same namespace. Example: Deployment ⊃ ReplicaSet ⊃ Pod. Containers are not resources; they are embedded in the Pod summary. |
| reference | A relation `source → target` listed in the details of both resources. Extracted from the source's spec (e.g. `HTTPRoute.spec.parentRefs → Gateway`, `Pod.spec.nodeName → Node`, `Service.spec.selector → Pod`). |
| `path` | Ancestor container ids of a resource, outermost first. Used by the UI to find the nearest *visible* ancestor when a widget itself is not rendered. Elements are `"cluster"` (the cluster-scoped area), `"ns:<namespace>"`, or the `uid` of an owner. Examples: `["cluster"]`, `["ns:default"]`, `["ns:default", "<deployment uid>", "<replicaset uid>"]`. |

## `GET /api/overview`

Cheap summary of the whole cluster. Poll/refetch freely.

```json
{
  "cluster": {"name": "kind-kvleva", "server": "https://127.0.0.1:6443", "version": "v1.35.0"},
  "revision": 1042,
  "systemResources": 285,
  "sync": {
    "ready": true,
    "kindsTotal": 61,
    "kindsSynced": 61,
    "errors": [{"kindId": "example.io/Widget", "message": "forbidden"}]
  },
  "health": {"green": 310, "yellow": 4, "red": 1},
  "kinds": [
    {"kindId": "apps/Deployment", "group": "apps", "version": "v1", "kind": "Deployment",
     "namespaced": true, "count": 12, "rollup": {"green": 11, "yellow": 1, "red": 0}}
  ],
  "namespaces": [
    {"name": "default", "uid": "…", "health": "green", "reason": "Active",
     "count": 42, "rollup": {"green": 40, "yellow": 2, "red": 0}}
  ],
  "clusterScoped": {"count": 180, "rollup": {"green": 180, "yellow": 0, "red": 0}},
  "nodes": {"count": 3, "rollup": {"green": 3, "yellow": 0, "red": 0}}
}
```

- `revision` increases whenever anything in the cluster changes.
- `sync.ready` is false until the first full load of every watched kind finishes.
- `kinds` is sorted in display order (see *Ordering*) and lists every watched
  kind, including kinds with `count: 0`.
- `namespaces[].health` is the health of the Namespace object itself; `rollup`
  counts every resource inside the namespace. `count` is the number of resources
  in the namespace.
- `clusterScoped` covers cluster-scoped resources **excluding** Namespaces and
  Nodes. `nodes` covers Node objects only.
- `systemResources` is the number of system resources in the cluster. It is
  the same whether or not they are part of the other numbers.

By default the overview leaves **system resources** out: every count excludes
them and the system namespaces are not listed. `GET /api/overview?system=true`
includes them. See *System resources* below.

## System resources

System resources are what a cluster brings along, as opposed to what its users
deploy. Both `/api/overview` and `/api/resources` leave them out unless
`system=true` is given; this is the "System resources" switch of the web
interface, which starts off. A resource is a system resource when it

- lives in a system namespace, or is that namespace: every namespace whose
  name starts with `kube-`, and `local-path-storage` (the storage provisioner
  that kind installs);
- is maintained by Kubernetes itself, whenever it was created: built-in RBAC
  roles and bindings, anything named `system:…` or `kubeadm:…`, automatically
  managed API services, built-in API priority objects, platform add-ons
  (`addonmanager.kubernetes.io/mode`), the `kube-root-ca.crt` ConfigMap and
  the `default` ServiceAccount of every namespace, the `kubernetes` Service
  and its endpoints, allocated Service addresses, CSINode objects, `system-…`
  priority classes, and certificate requests made by nodes;
- is a **cluster-scoped** resource created while the cluster was being
  created, that is within 30 seconds after the `kube-system` namespace
  appeared. This covers what installers add right after the control plane is
  up, such as a network plugin's roles or a default storage class.

Nodes and the `default` namespace are never system resources. Namespaced
resources outside the system namespaces are never judged by their age, so an
application deployed seconds after the cluster was created is still shown.

The details of a system resource (`/api/resources/{uid}`) are always
available, so references to system resources can be followed.

## `GET /api/resources`

Paginated list of resource summaries. Exactly one *scope* parameter selects what
is listed; the filter parameters apply to every scope.

### Scope (pick one)

| Parameter | Lists |
|---|---|
| `namespace=<name>` | Top-level resources of the namespace (those without a parent). |
| `cluster=true` | Top-level cluster-scoped resources, excluding Namespaces and Nodes. |
| `nodes=true` | Node objects. |
| `parent=<uid>` | Children of the resource. |
| `node=<nodeName>` | Pods scheduled on the node (flat). |
| *(none)* | Every resource, flat (global search). |

### Filters

| Parameter | Meaning |
|---|---|
| `hideKinds=<kindId>,<kindId>` | Kinds to leave out. In tree scopes (`namespace`, `cluster`, `parent`) a hidden resource is skipped and **its children are promoted** to its place, so hiding `apps/ReplicaSet` shows Pods directly inside their Deployment. |
| `health=red,yellow` | Keep resources with one of these health values. |
| `q=<text>` | Keep resources whose name contains the text (case-insensitive). |
| `system=true` | Include system resources (see *System resources*). Without it they are left out; in tree scopes a system resource is skipped like a hidden kind. |
| `limit` | Page size. Default 100, maximum 500. |
| `offset` | Zero-based start index. Default 0. |

In tree scopes, `health` and `q` keep a resource when **it or any of its
descendants** matches, so a failing Pod stays reachable through its Deployment.
`selfMatch` tells whether the resource itself matched.

### Response

```json
{
  "items": [ /* ResourceSummary */ ],
  "total": 1234,
  "offset": 0,
  "limit": 100,
  "revision": 1042
}
```

`total` is the number of matches before pagination.

### ResourceSummary

```json
{
  "uid": "0b9c…",
  "kindId": "core/Pod",
  "group": "core",
  "version": "v1",
  "kind": "Pod",
  "namespace": "default",
  "name": "web-7d4b9c-abcde",
  "health": "yellow",
  "reason": "ContainerCreating",
  "createdAt": "2026-11-14T17:00:00Z",
  "childCount": 0,
  "rollup": {"green": 0, "yellow": 1, "red": 0},
  "selfMatch": true,
  "path": ["ns:default", "<deployment uid>", "<replicaset uid>"],
  "node": "kvleva-control-plane",
  "containers": [
    {"name": "app", "image": "nginx:1.27", "init": false, "health": "yellow",
     "state": "waiting", "reason": "ContainerCreating", "ready": false, "restarts": 0}
  ]
}
```

- `namespace` is `""` for cluster-scoped resources.
- `childCount` is the number of direct children after `hideKinds` is applied.
- `node` and `containers` are present for Pods only. Container `state` is
  `running`, `waiting`, `terminated`, or `unknown`.
- Summaries carry no references; those are part of the resource's details
  (`outgoing`, `incoming`, `missing`).

### Ordering

Items are sorted by kind (display order below), then namespace, then name.
Kinds unknown to the table sort after it, alphabetically by `kindId`.

1. Namespace, Node
2. Gateway API and ingress: GatewayClass, Gateway, HTTPRoute, GRPCRoute,
   TLSRoute, TCPRoute, UDPRoute, ReferenceGrant, IngressClass, Ingress
3. Service, EndpointSlice, NetworkPolicy
4. Workloads: Deployment, StatefulSet, DaemonSet, CronJob, Job, ReplicaSet,
   ReplicationController, Pod
5. Scaling and disruption: HorizontalPodAutoscaler, PodDisruptionBudget
6. Config: ConfigMap, Secret, ServiceAccount
7. Storage: PersistentVolumeClaim, PersistentVolume, StorageClass
8. RBAC: Role, RoleBinding, ClusterRole, ClusterRoleBinding
9. CustomResourceDefinition
10. Everything else

## `GET /api/resources/{uid}`

Full detail for one resource.

```json
{
  "summary": { /* ResourceSummary */ },
  "yaml": "apiVersion: v1\nkind: Pod\nmetadata:\n  name: …\nspec:\n  …\n",
  "statusYaml": "phase: Running\nconditions:\n- …\n",
  "conditions": [
    {"type": "Ready", "status": "True", "reason": "", "message": "",
     "lastTransitionTime": "2026-11-14T17:00:05Z", "source": ""}
  ],
  "events": [
    {"type": "Warning", "reason": "BackOff", "message": "Back-off restarting failed container",
     "count": 7, "firstSeen": "2026-11-14T17:00:00Z", "lastSeen": "2026-11-14T17:05:00Z",
     "source": "kubelet"}
  ],
  "eventsError": "",
  "owners": [ /* Link */ ],
  "outgoing": [ /* Link with relation */ ],
  "incoming": [ /* Link with relation */ ],
  "missing": [
    {"kindId": "core/Service", "kind": "Service", "namespace": "default",
     "name": "does-not-exist", "relation": "backendRefs"}
  ]
}
```

- `yaml` is the manifest **without** `status` and without
  `metadata.managedFields`. Secret values are always replaced by a redaction
  marker; they never leave the backend.
- `statusYaml` is the `status` subtree, or `""` when the resource has none.
- `conditions` are sorted newest first. `source` is empty for
  `status.conditions` and names the nested origin otherwise, for example
  `parents[0]` for an HTTPRoute or `listeners[1]` for a Gateway.
- `events` are the Kubernetes Events about this resource, newest first.
  `eventsError` is non-empty when events could not be loaded.
- `outgoing` / `incoming` are resolved references from / to this resource.
  `missing` lists references whose target does not exist.

`Link` is `{"uid", "kindId", "kind", "namespace", "name", "health", "path", "relation"}`
(`relation` is omitted in `owners`).

Returns `404` when the uid is unknown (for example the resource was deleted).

## `GET /api/resources/{uid}/containers/{name}`

Detail for one container of a Pod.

```json
{
  "pod": { /* ResourceSummary of the Pod */ },
  "container": { /* container entry as in ResourceSummary.containers */ },
  "yaml": "name: app\nimage: nginx:1.27\n…",
  "statusYaml": "ready: true\nstate:\n  running:\n    startedAt: …\n",
  "events": [ /* events whose subject is this container */ ],
  "eventsError": ""
}
```

Returns `404` when the Pod or the container is unknown.

## `GET /api/stream`

Server-Sent Events (`text/event-stream`). The UI uses it only as a "something
changed, refetch what you show" signal; it never carries resource bodies.

```
event: change
data: {"revision": 1043, "changed": ["<uid>", "<uid>"], "deleted": ["<uid>"], "overflow": false}

: heartbeat
```

- Changes are coalesced and sent at most once per second.
- When more than 500 resources changed in one batch, `overflow` is `true` and
  the uid lists are empty: refetch everything visible.
- A `change` event with the current revision is sent right after connecting.
- A comment line is sent every 15 seconds to keep the connection alive.

## `GET /healthz`

Returns `200 ok` (plain text) while the server runs.

## Static assets

Everything else is served from the embedded `web/static` directory; `/` serves
`index.html`.
