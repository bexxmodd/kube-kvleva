# kvleva frontend design

The UI is a dependency-free, build-free single page app made of static ES
modules under `web/static/`. The Go binary embeds that directory and serves it;
there is no bundler and nothing to compile. `web/package.json` only exists for
development: tests run with `node --test` and use `jsdom` for a DOM.

The backend contract is [api.md](api.md). Behavior is specified in
[`features/`](../features).

## Non-negotiable constraints

1. **Read-only.** The UI only issues `GET` requests. There are no forms,
   buttons, or code paths that modify the cluster.
2. **Untrusted data.** Names, labels, messages, and YAML come from the cluster
   and may be hostile. Never build markup from them: use `textContent`,
   `createElement`, and `setAttribute` on known-safe attribute names. No
   `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write` with
   non-constant strings.
3. **Strict CSP.** The server sends `default-src 'self'`. Therefore: no inline
   `<script>`, no inline `<style>`, no `style="…"` attributes in markup, no
   remote fonts, images, or scripts. Setting `element.style.foo = …` from
   JavaScript is fine.
4. **Scale.** A cluster can hold tens of thousands of nodes and pods. The DOM
   must stay bounded: nothing is rendered until its container is opened, every
   list is paginated, and refreshes only refetch what is currently open.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ kvleva   kind-kvleva · v1.35.0 · ● synced    ●310 ●4 ●1    [ search… ]   │  header
├───────────────┬──────────────────────────────────────────┬───────────────┤
│ Filters       │ ┌ cluster: kind-kvleva ────────────────┐ │ Details       │
│  Health       │ │ ┌ Nodes (3) ───────────────────────┐ │ │  Deployment   │
│  Connections  │ │ │ [node] [node] [node]             │ │ │  default/web  │
│  Resource     │ │ └──────────────────────────────────┘ │ │  ● green …    │
│  types        │ │ ┌ Cluster-wide (180) ──────────────┐ │ │               │
│   ☑ Pod   42  │ │ └──────────────────────────────────┘ │ │ Configuration │
│   ☑ Service 9 │ │ ┌ namespace: default ──────────────┐ │ │  (YAML)       │
│   ☐ Secret 12 │ │ │ Gateway  [gw]───────┐            │ │ │ Status        │
│   …           │ │ │ HTTPRoute [route]◄──┘            │ │ │ Events        │
│               │ │ │ Deployment [web ▾ [rs ▾ [pod]]]  │ │ │ Connections   │
│               │ │ └──────────────────────────────────┘ │ │               │
│               │ └──────────────────────────────────────┘ │               │
└───────────────┴──────────────────────────────────────────┴───────────────┘
   sidebar                     canvas (scrolls)               drawer
```

### Header

- App name, cluster name, server version, sync indicator (`sync.ready`,
  `kindsSynced/kindsTotal`, and a warning with the messages in `sync.errors`).
- Three health pills with the cluster totals. Clicking a pill toggles that
  health in the health filter.
- Search box bound to the `q` filter (debounced ~250 ms).

### Sidebar (filters)

- **Health**: three checkboxes (green, yellow, red). All checked means no
  `health` parameter is sent.
- **Connections**: `all`, `selected only`, `off` (see *Arrows*).
- **Resource types**: one checkbox per entry of `overview.kinds` in the given
  order, labelled with kind, group (muted), and count. Unchecked kinds are sent
  as `hideKinds`. A text box narrows the list; `All` / `None` buttons flip every
  checkbox.
- Filter state is saved in `localStorage` and restored on load.

### Canvas

The cluster is one outer box containing three kinds of *areas*, in this order:

1. **Nodes** — `nodes=true`. Each node is a widget. Opening a node lists the
   pods scheduled on it (`node=<name>`), each with its containers.
2. **Cluster-wide resources** — `cluster=true`.
3. One box per **namespace** (from `overview.namespaces`), listing
   `namespace=<name>`. The namespace header is itself clickable and selects the
   Namespace object (`uid` from the overview).

Every area header shows its name, resource count, and a rollup (green / yellow /
red counts). Area borders use the worst color of the rollup.

Inside an area, items arrive already sorted. Consecutive items of the same
`kindId` form a **lane**: a labelled row (`Deployment`, `Service`, …) whose
widgets wrap.

### Widgets

A widget is a clickable box for one resource:

- Outline color = `health` (`green`, `yellow`, `red`). This is the primary
  visual signal and must be unmistakable (2px+ solid border in the health
  color, plus a matching dot so color is not the only cue; the `reason` is the
  tooltip and is shown as small text).
- Shows kind (small), name, and for nested items the rollup when collapsed.
- `selfMatch: false` widgets (kept only because a descendant matched) are
  dimmed.
- A widget with `childCount > 0` has a disclosure toggle. Opening it fetches
  `parent=<uid>` and renders the children **inside** the widget, grouped into
  lanes the same way. Closing it removes the child DOM.
- A Pod widget always renders its `containers` inside itself as small container
  widgets (init containers marked), each outlined in its own health color.
  Clicking a container selects that container.
- Clicking a widget (not its toggle) selects it and opens the drawer.
- Keyboard: widgets are focusable; `Enter`/`Space` selects, `Escape` closes the
  drawer.

### Pagination

Every list (area, children, pods on a node) loads `limit=100` items. When
`total` exceeds what is loaded, a `Show more (N remaining)` button appends the
next page.

### Initial expansion

On first load: if the cluster has at most 400 resources in total, open the Nodes
area and every namespace, and open child lists up to two levels deep when
`childCount <= 10`. Otherwise everything starts closed and the user opens what
they need. `Expand all` / `Collapse all` controls sit in the cluster box header
(`Expand all` only opens areas, not every nested widget).

### Arrows (references)

Arrows are drawn in one SVG layer over the canvas content.

- Every loaded `ResourceSummary.refs` entry is a candidate arrow
  `summary → ref`.
- **Lifting**: an endpoint that has no rendered widget is replaced by its
  nearest rendered ancestor, found by walking its `path` from the innermost
  entry outward (`uid` widgets, `ns:<name>` namespace boxes, `cluster` for the
  cluster-wide area; Node targets lift to the Nodes area). If nothing is
  rendered the arrow is dropped.
- After lifting, drop arrows whose two ends are the same element or where one
  end contains the other, and merge duplicates.
- Modes: `all` draws every arrow faintly and emphasizes those touching the
  hovered or selected widget; `selected only` draws just those; `off` draws
  none. If more than 300 arrows would be drawn in `all` mode, fall back to
  `selected only` behavior and say so next to the control.
- Arrows are cubic curves from the border of the source to the border of the
  target with an arrowhead at the target, colored neutrally (not a health
  color).
- Redraw (throttled with `requestAnimationFrame`) after any render, on window
  resize, and when a container is opened or closed.

### Details drawer

Opens on selection; closable. Top to bottom:

1. Header: kind, `namespace/name`, health badge, `reason`.
2. **Configuration** — `yaml` in a monospace block with light syntax coloring
   (keys, strings, numbers, comments) and a `Copy` button.
3. **Status** — conditions table (`type`, `status`, `reason`, `message`,
   `lastTransitionTime`, `source`), then `statusYaml`. Shown after the
   configuration, as the product requirement states.
4. **Events** — table of events, warnings marked; show `eventsError` as a note
   if set; "No events" when empty.
5. **Connections** — `owners`, `outgoing` ("refers to"), `incoming` ("referred
   to by"), and `missing` ("missing references", visually flagged). Resolved
   entries are links that select that resource. Selecting reveals it: open the
   containers named in its `path`, then scroll it into view and flash it.

For a container selection the drawer shows the container header, its `yaml`,
`statusYaml`, and events, plus a link back to the Pod.

A `404` (resource deleted) shows "This resource no longer exists."

### Live updates

Open `/api/stream` once. On a `change` event schedule a refresh (debounced
500 ms, at most one refresh every 2 s):

- always refetch `/api/overview`;
- refetch every list that is currently open, keeping the number of loaded
  items (re-request the same number of pages);
- refetch the drawer if its `uid` is in `changed`, or if `overflow` is set;
  if its `uid` is in `deleted`, show the "no longer exists" state.

Refreshes must preserve scroll position, open/closed state, selection, and
focus. If the stream disconnects, show "reconnecting…" in the header and let
`EventSource` retry.

## Code structure

| File | Responsibility | DOM? |
|---|---|---|
| `static/index.html` | Static shell. | – |
| `static/css/app.css` | All styling. Health colors as CSS variables. | – |
| `static/js/api.js` | URL building and `fetch` wrappers for every endpoint; stream subscription. | no (takes `fetch`/`EventSource` by injection) |
| `static/js/filters.js` | Filter state, (de)serialization, mapping to query parameters. | no |
| `static/js/tree.js` | View model: open scopes, pages, lanes, initial expansion, refresh planning. | no |
| `static/js/edges.js` | Arrow lifting, de-duplication, capping, and path geometry from rectangles. | no |
| `static/js/yaml.js` | Tokenizing YAML lines for coloring. | no |
| `static/js/view.js` | Building and updating DOM for canvas, sidebar, header, drawer, SVG layer. | yes |
| `static/js/main.js` | Wiring: state, events, refresh loop. | yes |

Keep logic in the DOM-free modules so it is unit-testable; `view.js` is tested
with jsdom. Tests live in `web/test/*.test.js` and are **not** embedded.

## Visual style

Dark, calm, information-dense. System font stack; monospace for YAML.
Health colors (also for color-blind safety pair each with an icon/dot shape or
label): green `#3fb950`, yellow `#d29922`, red `#f85149`. Neutral arrows
`#8b949e`, emphasized arrows `#58a6ff`.

## Implementation notes

Where the implementation settles something this document leaves open, or
departs from it:

- **Health filter**: unchecking the last health re-checks all three, because
  "show nothing" cannot be expressed. The `health` parameter is always sent
  in the order `red,yellow,green`.
- **Refresh paging**: a list with N loaded pages is refetched as
  `offset=0&limit=N*100`, split into requests of at most 500.
- **Stream**: the event sent right after connecting is ignored when it
  carries nothing newer than the overview already shown. After a reconnect
  everything visible is refreshed, as for `overflow`.
- **Failures**: if the first `/api/overview` fails, a banner is shown and the
  request is retried every 3 seconds. A list that cannot be refreshed keeps
  its items and shows the error.
- **Reveal**: looks for the target through at most 10 further pages per list
  on its path; if it is still not rendered (for example filtered out), the
  nearest rendered ancestor is scrolled to and flashed instead.
- **Pods shown twice** (in their namespace and under an opened node): arrows
  attach to the instance in the namespace.
- **Dots** differ in shape as well as color: ● green, ▲ yellow, ■ red.
- **Kind identifiers the UI depends on**: `core/Node` (lifts to the Nodes
  area) and `core/Namespace` (maps to the `ns:<name>` box).

The frontend has been exercised with jsdom, including end to end against the
real backend, but layout and styling can only be judged in a browser.
