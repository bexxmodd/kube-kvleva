# How kvleva works

The [README](../README.md) says what kvleva is and how to use it. This page
holds the details: what counts as a system resource, how health and
relationships are decided, the safety guards, behavior on large clusters, the
code layout, and the known limitations.

## What counts as a system resource

With the *System resources* switch off, kvleva leaves out:

- everything in a namespace whose name starts with `kube-`, and in
  `local-path-storage` (kind's storage provisioner), together with those
  namespaces;
- what Kubernetes maintains by itself, whenever it was created: built-in
  roles and bindings, `system:…` and `kubeadm:…` objects, the
  `kube-root-ca.crt` ConfigMap and `default` ServiceAccount of every
  namespace, the `kubernetes` Service, and similar bookkeeping;
- cluster-wide resources created within 30 seconds of the cluster coming up,
  which is how the roles of a network plugin or a default storage class
  installed by the cluster creator are recognized.

Resources in your own namespaces and in `default` are never hidden because of
when they were created. A cluster-wide resource (a ClusterRole, a
StorageClass, …) that you create within those first 30 seconds is treated as
a system resource; flip the switch to see it. Nodes and the `default`
namespace are always shown. The exact rules are in
[`api.md`](api.md#system-resources) and
[`internal/graph/system.go`](../internal/graph/system.go).

## How health is decided

| Color | Meaning | Examples |
|---|---|---|
| green | reconciled | Pod running and ready, Deployment fully rolled out, PVC bound, condition `Ready=True`, or no status at all (ConfigMap) |
| yellow | in progress or stuck | Pod pending / unschedulable / not ready, rollout under way, controller has not observed the latest generation, condition `Unknown`, `Reconciling=True`, `Stalled=True`, resource terminating |
| red | failed | CrashLoopBackOff, ImagePullBackOff, Pod `Failed`, Deployment past its progress deadline, Job failed, Node not ready, `Ready=False` for a reason that is not "still working" |

Built-in workloads have dedicated rules. Everything else, including custom
resources, is judged by conventions: `status.observedGeneration` against
`metadata.generation`, and status conditions of well-known types (`Ready`,
`Available`, `Accepted`, `Programmed`, `ResolvedRefs`, `Established`, `…Ready`,
`…Failed`, `Degraded`, `Stalled`, `Reconciling`). Gateway API resources are
covered through their nested conditions (`status.parents[]`,
`status.listeners[]`). Condition types kvleva does not know are ignored rather
than guessed. The rules live in [`internal/health`](../internal/health) and are
specified in
[`features/resource_health.feature`](../features/resource_health.feature).

## How relationships are found

- **Nesting** follows `metadata.ownerReferences` when owner and owned are in
  the same namespace. An owner elsewhere (a Node owning a static Pod) is
  listed as a reference instead.
- **References**, shown under *Connections* in the details, come from the
  resource's spec: well-known fields
  (`nodeName`, `serviceAccountName`, `secretName`, `claimName`,
  `storageClassName`, `gatewayClassName`, volumes, env sources, Ingress
  backends, RBAC `roleRef` / `subjects`, …), label selectors of Services,
  PodDisruptionBudgets and NetworkPolicies, and, for any kind including custom
  resources, every field named `…Ref` / `…Refs` that holds a name
  (`parentRefs`, `backendRefs`, `scaleTargetRef`, `issuerRef`, …).
- References to something that does not exist are listed in the details as
  **missing references**.
- References are listed in the details only; they are not drawn as lines on
  the cluster picture.

## Safety

kvleva is meant to be safe to point at any cluster.

**It cannot change the cluster.**

- Every request to the cluster goes through a transport that only lets `GET`
  and `HEAD` through. Creates, updates, patches, deletes, and connection
  upgrades (`exec`, `attach`, `port-forward`) are refused before anything is
  sent ([`internal/kube/readonly.go`](../internal/kube/readonly.go)).
- The web API only has read endpoints and rejects every other HTTP method.
- This guard is in the program, not in the cluster: kvleva uses the
  credentials of your kubeconfig. For a guarantee enforced by the cluster
  itself, run it with a kubeconfig whose user is bound to a read-only role
  such as the built-in `view` ClusterRole (plus read access to the custom
  resources you want to see).

**It does not expose the cluster.**

- It refuses to start on any address that is not loopback.
- Requests must come from the local machine, must be addressed to a local host
  name (which defeats DNS rebinding), and must not be triggered by another
  website or another local web app.
- Secret values are replaced by `<redacted>` as soon as a Secret is read. They
  are not kept in memory and never reach the browser. Add `secrets` to
  `resources.exclude` to not read Secrets at all.
- The page is served with a strict Content-Security-Policy and loads nothing
  from the network.

## Large clusters

- The backend keeps one compact record per resource (summary, relationships,
  compressed manifest) instead of full objects, and loads each resource type
  page by page.
- The browser never receives the whole cluster. It asks for an overview
  (counts), then for one page of whatever you open. Health, type, and name
  filters are applied on the server.
- Live updates are a stream of "these changed" notices, coalesced to at most
  one per second, after which the page refetches only what is open.
- Events and Leases are left out by default because they change constantly
  and are rarely what you want to look at as widgets.

`go test ./internal/graph -bench LargeCluster -run xxx` measures the model on a
synthetic cluster of 2,000 nodes and 100,000 pods.

## Filters in detail

- Hiding an in-between type (say ReplicaSets) keeps its contents, shown one
  level up.
- Filtering by health or name keeps the path to whatever matches, so a failing
  pod is still reachable through its deployment.
- Collapsing or expanding an API group in the list of resource types only
  tidies the panel; it filters nothing.
- Filters keep applying while the filters panel is hidden.

## Code layout

| Path | What |
|---|---|
| `cmd/kvleva` | The command: configuration, wiring, shutdown. |
| `internal/config` | Configuration file. |
| `internal/kube` | Read-only cluster connection, discovery, list & watch, events. |
| `internal/health` | Green / yellow / red rules. |
| `internal/refs` | Ownership and reference extraction. |
| `internal/graph` | In-memory model: nesting, references, filters, pagination, change feed. |
| `internal/server` | HTTP server: local-only and read-only guards, JSON API, change stream. |
| `web/static` | The web interface (plain ES modules, no build step) and its typeface, embedded into the binary. |
| `features/` | Behavior specifications (Gherkin). |
| `docs/api.md` | The HTTP API between backend and frontend. |
| `docs/frontend.md` | Frontend design. |

The project is developed test-first: behavior is written down in `features/`,
then as failing tests, then implemented.

## Known limitations

- Only one cluster per process.
- Relationships that are not expressed as owner references, by-name
  references, or the label selectors listed above are not found.
- Health of custom resources depends on them following the usual status
  conventions.
- The name search and the health filter narrow the lists that are open. In a
  cluster large enough that areas start closed, a closed area does not yet say
  how many matches it holds.
- A node widget does not show how many pods run on it until it is opened.
- An open details panel refreshes when its resource changes, but not when
  only a new Event about it arrives; reselect the resource to see it.
- Timestamps are shown as the cluster reports them (RFC 3339, UTC).
