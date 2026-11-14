# kube-kvleva

**kvleva** shows a Kubernetes cluster as a live, clickable picture in your
browser. It starts from the terminal, connects to a cluster through your
kubeconfig, and serves a web interface on localhost.

- Every resource is a **widget**: built-in kinds and custom resources alike.
- The widget outline tells its state: **green** (configured / reconciled),
  **yellow** (in progress, pending, or stuck), **red** (failed).
- Resources are **nested** where one owns another (Deployment ⊃ ReplicaSet ⊃
  Pod ⊃ containers) and **connected by arrows** where one refers to another
  (HTTPRoute → Gateway, Pod → ConfigMap, Service → Pods, …).
- Clicking a widget shows its **YAML**, followed by its **status**, conditions,
  events, and connections.
- It is **read-only** and **local-only**, by construction (see
  [Safety](#safety)).
- It is built for **large clusters**: nothing is loaded into the page until
  you open it, every list is paginated, and filters run on the server.

## Quick start

Requirements: Go 1.25 or newer, and a kubeconfig that can read the cluster.

```sh
# Build
make build            # or: go build -o bin/kvleva ./cmd/kvleva

# Run against the kind cluster "kvleva"
bin/kvleva -config kvleva.example.yaml

# Then open
#   http://127.0.0.1:8080
```

Without `-config`, kvleva uses the current context of your default kubeconfig
and serves on `127.0.0.1:8080`.

To try it on a throwaway cluster:

```sh
kind create cluster --name kvleva
kubectl --context kind-kvleva apply -f examples/demo.yaml   # optional sample workloads
bin/kvleva -config kvleva.example.yaml
```

> kvleva only answers requests addressed to `localhost` / `127.0.0.1` / `[::1]`
> from the same machine. If it runs on a remote workstation, forward the port
> and open the forwarded address locally:
> `ssh -L 8080:127.0.0.1:8080 <workstation>`.

## Configuration

A small YAML file, all settings optional. See
[`kvleva.example.yaml`](kvleva.example.yaml).

| Setting | Default | Meaning |
|---|---|---|
| `cluster.kubeconfig` | `$KUBECONFIG`, then `~/.kube/config` | Kubeconfig file to read. |
| `cluster.context` | the kubeconfig's current context | Context (cluster) to show. |
| `listen.address` | `127.0.0.1` | Must be a loopback address or `localhost`. |
| `listen.port` | `8080` | Local port. |
| `resources.exclude` | `events`, `events.events.k8s.io`, `leases.coordination.k8s.io`, `endpoints` | Resource types that are not loaded, named `<resource>` or `<resource>.<group>`. Replaces the default list when set. |

Unknown settings are rejected at startup so that typos do not go unnoticed.

## Using the interface

- **Cluster box** – contains a *Nodes* area, a *Cluster-wide* area, and one box
  per namespace. Headers show how many resources are inside and how many are
  green / yellow / red, so problems are visible before you open anything.
- **Open** an area or a widget to load what is inside it. Opening a node lists
  the pods running on it; every pod shows its containers.
- **Click** a widget (or a container) for its details: configuration YAML,
  then status and conditions (newest first), events, and what it is connected
  to. Connections are links.
- **Filters** (left): hide resource types, show only certain health colors,
  search by name. Hiding an in-between type (say ReplicaSets) keeps its
  contents, shown one level up. Filtering by health or name keeps the path to
  whatever matches, so a failing pod is still reachable through its
  deployment.
- **Arrows**: all, only those of the selected widget, or none. An arrow to
  something folded away ends at the nearest visible box that contains it.

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
than guessed. The rules live in [`internal/health`](internal/health) and are
specified in [`features/resource_health.feature`](features/resource_health.feature).

## How relationships are found

- **Nesting** follows `metadata.ownerReferences` when owner and owned are in
  the same namespace. An owner elsewhere (a Node owning a static Pod) becomes
  an arrow instead.
- **Arrows** come from the resource's spec: well-known fields
  (`nodeName`, `serviceAccountName`, `secretName`, `claimName`,
  `storageClassName`, `gatewayClassName`, volumes, env sources, Ingress
  backends, RBAC `roleRef` / `subjects`, …), label selectors of Services,
  PodDisruptionBudgets and NetworkPolicies, and, for any kind including custom
  resources, every field named `…Ref` / `…Refs` that holds a name
  (`parentRefs`, `backendRefs`, `scaleTargetRef`, `issuerRef`, …).
- References to something that does not exist are listed in the details as
  **missing references**.

## Safety

kvleva is meant to be safe to point at any cluster.

**It cannot change the cluster.**

- Every request to the cluster goes through a transport that only lets `GET`
  and `HEAD` through. Creates, updates, patches, deletes, and connection
  upgrades (`exec`, `attach`, `port-forward`) are refused before anything is
  sent ([`internal/kube/readonly.go`](internal/kube/readonly.go)).
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

## Development

```sh
make test        # Go tests (with the race detector) and frontend tests
make test-go
make test-web    # needs Node 22+; run `npm install` in web/ once
```

| Path | What |
|---|---|
| `cmd/kvleva` | The command: configuration, wiring, shutdown. |
| `internal/config` | Configuration file. |
| `internal/kube` | Read-only cluster connection, discovery, list & watch, events. |
| `internal/health` | Green / yellow / red rules. |
| `internal/refs` | Ownership and reference extraction. |
| `internal/graph` | In-memory model: nesting, references, filters, pagination, change feed. |
| `internal/server` | HTTP server: local-only and read-only guards, JSON API, change stream. |
| `web/static` | The web interface (plain ES modules, no build step), embedded into the binary. |
| `features/` | Behavior specifications (Gherkin). |
| `docs/api.md` | The HTTP API between backend and frontend. |
| `docs/frontend.md` | Frontend design. |

The project is developed test-first: behavior is written down in `features/`,
then as failing tests, then implemented.

## Known limitations

- Only one cluster per process.
- Relationships that are not expressed as owner references, by-name
  references, or the label selectors listed above are not drawn.
- Health of custom resources depends on them following the usual status
  conventions.
- The name search and the health filter narrow the lists that are open. In a
  cluster large enough that areas start closed, a closed area does not yet say
  how many matches it holds.
- A node widget does not show how many pods run on it until it is opened.
- An open details panel refreshes when its resource changes, but not when
  only a new Event about it arrives; reselect the resource to see it.
- Timestamps are shown as the cluster reports them (RFC 3339, UTC).

## License

MIT, see [LICENSE](LICENSE).
