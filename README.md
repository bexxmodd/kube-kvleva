<p align="center">
  <img src="assets/logo/kvleva-512.svg" alt="kvleva logo">
</p>

# kube-kvleva

**kvleva** shows a Kubernetes cluster as a live picture in your browser.

You start kvleva from a terminal. It reads the cluster with your kubeconfig.
It serves a web page on your own machine.

## What you get

- **A widget for every resource.** This includes custom resources.
- **Health.** The outline of a widget shows the health of the resource:
  Healthy, In-Progress, or Failed.
- **Nesting.** A Deployment contains its ReplicaSets. A ReplicaSet contains
  its Pods. A Pod contains its containers.
- **Details.** Click a widget to see its YAML, status, events, and
  connections to other resources.
- **Live logs.** Read the output of a container, a Pod, or all Pods of a
  workload while they write it.
- **Live updates.** The picture changes when the cluster changes.
- **Read-only access.** kvleva cannot change the cluster.
- **Local access only.** Other machines cannot open the page.
- **Support for large clusters.** The page loads only the parts that you
  open.

## Install

You need Go 1.25 or newer.

```sh
git clone https://github.com/bexxmodd/kube-kvleva.git
cd kube-kvleva
make build
```

This builds the program `bin/kvleva`.

## Run

```sh
bin/kvleva
```

Open <http://127.0.0.1:8080> in your browser. Press Ctrl+C in the terminal to
stop kvleva.

kvleva shows the cluster of the current context in your kubeconfig. Your
kubeconfig user must have permission to read the cluster.

To show a different cluster or to use a different port, write a
[configuration file](#configuration):

```sh
bin/kvleva -config kvleva.yaml
```

### Try kvleva on a test cluster

You need [kind](https://kind.sigs.k8s.io/) and `kubectl`.

```sh
kind create cluster --name kvleva
kubectl --context kind-kvleva apply -f examples/demo.yaml
make run
```

- `examples/demo.yaml` adds sample workloads of all three health states.
- `make run` builds kvleva and starts it with `kvleva.example.yaml`. That file
  selects the `kind-kvleva` context.
- `examples/gateway-misconfigured.yaml` adds Gateway API resources that
  contain mistakes on purpose. It needs a Gateway controller. The top of the
  file tells you how to install one.

### Run kvleva on a remote machine

kvleva answers only the machine that it runs on. To see the page on your own
machine, forward the port:

```sh
ssh -L 8080:127.0.0.1:8080 <remote-machine>
```

Then open <http://127.0.0.1:8080> on your own machine.

## Use the page

The page has four parts.

| Part | Position | Content |
|---|---|---|
| Top bar | Top | Cluster name, health totals, search box, switches |
| Filters panel | Left | Filters for health and for resource types |
| Cluster picture | Middle | Nodes, cluster-wide resources, and one box for each namespace |
| Details panel | Right | The resource that you clicked |

| Task | Action |
|---|---|
| Look inside a namespace, a node, or a resource | Click the **▸** button on it. |
| Open all top-level boxes | Click **Expand all**. |
| See the details of a resource | Click its widget. The details panel shows the YAML first. Status, conditions, events, and connections follow. |
| Go to a connected resource | Click its link in the details panel. |
| Read the live logs of a resource | Click its widget. Then click **View Live Logs** in the details panel. Click **Details** to go back. |
| Filter the log lines | Type a keyword in the filter field above the log. For a regular expression, type `/pattern/` or `/pattern/i`. |
| Find a resource by name | Type the name in the search box. |
| Show only some health states | Click a health total in the top bar. Or use **Health** in the filters panel. |
| Hide resource types | Use **Resource types** in the filters panel. Click **▸** to list the types of an API group. Clear the checkbox of a type or of a full group. |
| Show system resources | Set the **System resources** switch to on. |
| Change the width of a side panel | Drag its edge. A panel uses a third of the window at most. |
| Hide the filters panel | Click **☰ Filters**. The filters stay active. |
| Change the theme | Click **☀ Day** or **☾ Night** in the top bar. |

Good to know:

- System resources are off by default. They are the resources that the cluster
  came with, for example the `kube-system` namespace.
- Each box shows how many of its resources are Healthy, In-Progress, and
  Failed. You see a problem before you open the box.
- The browser remembers your filters, panel widths, and theme.
- **View Live Logs** shows for a container, a Pod, and a resource that
  contains Pods, such as a Deployment. A resource with many Pods shows the
  logs of 10 Pods.

## Health

| Health | Color | Examples |
|---|---|---|
| Healthy | Green | A Pod that is running and ready. A Deployment that is fully rolled out. |
| In-Progress | Yellow | A pending Pod. A rollout that is under way. A resource that is terminating or stuck. |
| Failed | Red | `CrashLoopBackOff`. `ImagePullBackOff`. A Node that is not ready. |

A resource without a status, such as a ConfigMap, is Healthy. The full rules
are in [How kvleva works](docs/how-it-works.md#how-health-is-decided).

## Configuration

The configuration file is YAML. All settings are optional.
[`kvleva.example.yaml`](kvleva.example.yaml) shows each setting.

| Setting | Default | Meaning |
|---|---|---|
| `cluster.kubeconfig` | `$KUBECONFIG`, then `~/.kube/config` | The kubeconfig file to read. |
| `cluster.context` | The current context of the kubeconfig | The context (cluster) to show. |
| `listen.address` | `127.0.0.1` | The address to listen on. It must be `localhost` or a loopback address. |
| `listen.port` | `8080` | The local port. |
| `resources.exclude` | `events`, `events.events.k8s.io`, `leases.coordination.k8s.io`, `endpoints` | Resource types that kvleva does not load. Write `<resource>` or `<resource>.<group>`. Your list replaces the default list. |
| `logs.enabled` | `true` | Set this to `false` to switch live logs off. |

kvleva does not start if the file contains an unknown setting. This prevents
silent typing errors.

## Safety

- kvleva sends only read requests (`GET` and `HEAD`) to the cluster.
- kvleva listens only on a local address. It refuses requests from other
  machines and from other websites.
- kvleva does not send Secret values to the browser. It replaces them with
  `<redacted>`.
- The page loads nothing from the internet.
- Live logs show all the text that your applications write. This text can
  contain passwords or tokens. To switch live logs off, set `logs.enabled` to
  `false`.

These guards are in the program, not in the cluster. kvleva uses the
credentials of your kubeconfig. For a guarantee from the cluster itself, use a
kubeconfig user that has only a read-only role, such as `view`.

## More information

- [How kvleva works](docs/how-it-works.md): system resources, health rules,
  relationships, live logs, safety, large clusters, code layout, known
  limitations.
- [HTTP API](docs/api.md)
- [Frontend design](docs/frontend.md)
- [Behavior specifications](features/)
- [Logo](assets/logo/): the kvleva logo as SVG files in different sizes, for
  use outside the app.

## Development

```sh
make test
```

`make test` runs the Go tests and the frontend tests. The frontend tests need
Node 22 or newer. Run `npm install` in `web/` one time before the first test
run.

## License

MIT. See [LICENSE](LICENSE).

kvleva includes the [Inter](https://rsms.me/inter/) typeface. Inter has the
SIL Open Font License 1.1. See
[`web/static/fonts/Inter-LICENSE.txt`](web/static/fonts/Inter-LICENSE.txt).
