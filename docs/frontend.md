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
   remote fonts, images, or scripts (the one font the app uses ships with it,
   in `static/fonts`). Setting `element.style.foo = …` from JavaScript is
   fine.
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
│  Resource     │ │ │ [node] [node] [node]             │ │ │  default/web  │
│  types        │ │ └──────────────────────────────────┘ │ │  ● green …    │
│   ☑ Pod   42  │ │ ┌ Cluster-wide (180) ──────────────┐ │ │               │
│   ☑ Service 9 │ │ └──────────────────────────────────┘ │ │ Configuration │
│   ☐ Secret 12 │ │ ┌ namespace: default ──────────────┐ │ │  (YAML)       │
│   …           │ │ │ Gateway  [gw]                    │ │ │ Status        │
│               │ │ │ HTTPRoute [route]                │ │ │ Events        │
│               │ │ │ Deployment [web ▾ [rs ▾ [pod]]]  │ │ │ Connections   │
│               │ │ └──────────────────────────────────┘ │ │               │
│               │ └──────────────────────────────────────┘ │               │
└───────────────┴──────────────────────────────────────────┴───────────────┘
   sidebar                     canvas (scrolls)               drawer
```

### Header

- App name, cluster name, server version, sync indicator (`sync.ready`,
  `kindsSynced/kindsTotal`, and a warning with the messages in `sync.errors`).
- **System resources switch**, right after the cluster information (left to
  middle of the header). Off by default. Off: system resources are not
  requested (no `system` parameter) and the switch says how many are hidden
  (`overview.systemResources`). On: the overview and every list are requested
  with `system=true`. Flipping it refetches the overview first, closes lists
  of namespaces that are no longer shown, then refetches the open lists. The
  state is saved with the other filters.
- Three health pills with the cluster totals. Clicking a pill toggles that
  health in the health filter.
- Search box bound to the `q` filter (debounced ~250 ms).
- **Theme button** (`#theme-toggle`) at the far right: switches between the
  night theme (the default) and the day theme, and names the theme it
  switches to (`☀ Day` / `☾ Night`). The choice is saved in `localStorage`
  (`kvleva.theme`). Switching requests nothing and changes nothing else. See
  [Visual style](#visual-style).

### Sidebar (filters)

- **Health**: three checkboxes (green, yellow, red). All checked means no
  `health` parameter is sent.
- **Resource types**: the entries of `overview.kinds`, **grouped by API
  group**. The `core` group comes first, the others alphabetically; inside a
  group the types keep the order of the overview. Each group has a heading
  with its name, the number of resources of all its types, and a checkbox
  that hides or shows every type listed under it at once (checked: all shown,
  unchecked: all hidden, indeterminate: mixed; clicking a mixed group shows
  all). Each type has a checkbox, its kind, and its count, and is indented
  slightly (12 px) past the checkbox of its group. Unchecked kinds are
  sent as `hideKinds`. A text box narrows the list by kind or group name;
  groups without a match disappear and a group then counts and acts on the
  types it still lists. `All` / `None` buttons flip every checkbox.
- **Collapsible groups**: every group starts **collapsed**: only its heading
  is listed. The `▸` / `▾` button at the start of the heading expands the
  group (its types are listed under it) or collapses it again. The heading
  always shows the name, count, and checkbox, so a collapsed group can still
  be filtered as a whole. Expanding and collapsing is not a filter: nothing
  is requested and the canvas does not change. While the text box narrows the
  list, every match is listed whatever is collapsed, and the buttons are
  disabled until the text is cleared. The names of the expanded groups are
  saved in `localStorage` (`kvleva.expandedGroups`) and restored on load.
- Filter state is saved in `localStorage` and restored on load.
- **Resizable**: the dividing line between the sidebar and the canvas
  (`#sidebar-resizer`) can be dragged with the mouse, or moved with the arrow
  keys while focused (16 px per press). The sidebar is 260 px wide by default,
  at least 180 px, and never wider than a third of the window; the cap is
  enforced both while dragging and by the stylesheet (`max-width`), so it also
  holds when the window is made smaller afterwards. The chosen width is saved
  in `localStorage` (`kvleva.sidebarWidth`) and restored on load. The limits
  and persistence live in `static/js/layout.js`.
- **Hideable**: the `☰ Filters` button at the far left of the header
  (`#sidebar-toggle`) hides the sidebar together with its divider and shows
  them again, with the width they had. The filters keep applying while the
  panel is hidden. If keyboard focus is inside the panel when it is hidden,
  focus moves to the button. The state is saved in `localStorage`
  (`kvleva.sidebarHidden`) and restored on load.

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

### References

References between resources are **not drawn** on the canvas. An earlier
version drew them as arrows in an SVG layer over the canvas; that was removed.
References are shown in the details drawer instead (the *Connections* section
below), where each one is a link that reveals the referenced resource.

**Nearest rendered ancestor**: revealing a resource whose widget is not on the
page (folded away, or filtered out) falls back to the nearest rendered box
around it, found by walking its `path` from the innermost entry outward (`uid`
widgets, `ns:<name>` namespace boxes, `cluster` for the cluster-wide area;
Nodes fall back to the Nodes area, and a Namespace object is its namespace
box).

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

The drawer is **resizable** like the sidebar: a divider on its left edge
(`#drawer-resizer`, only present while the drawer is open) can be dragged, or
moved with the arrow keys while focused (left widens, right narrows). The
drawer is 480 px wide by default, at least 280 px, and never wider than a
third of the window, enforced while dragging and by the stylesheet. The
chosen width is saved in `localStorage` (`kvleva.drawerWidth`).

### Live updates

Open `/api/stream` once. On a `change` event schedule a refresh (debounced
500 ms, at most one refresh every 2 s):

- always refetch `/api/overview` (with `system=true` while the switch is on);
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
| `static/css/app.css` | All styling. Every color is a CSS variable, defined once per theme. | – |
| `static/fonts/InterVariable.woff2` | The typeface (Inter 4.1, variable), with its licence in `Inter-LICENSE.txt`. | – |
| `static/js/theme-boot.js` | The only script that is not a module: loaded in the `<head>`, it applies a remembered day theme before the page is drawn. | yes |
| `static/js/api.js` | URL building and `fetch` wrappers for every endpoint; stream subscription. | no (takes `fetch`/`EventSource` by injection) |
| `static/js/filters.js` | Filter state, (de)serialization, mapping to query parameters. | no |
| `static/js/layout.js` | Widths of the two side panels (limits), whether the filters panel is hidden, which API groups are expanded, and the theme; persistence of all five. | no |
| `static/js/tree.js` | View model: open scopes, pages, lanes, initial expansion, refresh planning, nearest rendered ancestor. | no |
| `static/js/yaml.js` | Tokenizing YAML lines for coloring. | no |
| `static/js/view.js` | Building and updating DOM for canvas, sidebar, header, drawer. | yes |
| `static/js/main.js` | Wiring: state, events, refresh loop. | yes |

Keep logic in the DOM-free modules so it is unit-testable; `view.js` is tested
with jsdom. Tests live in `web/test/*.test.js` and are **not** embedded.

## Visual style

Calm and information-dense, in two themes.

**Typeface.** Text is set in [Inter](https://rsms.me/inter/), 14 px, and no
text is smaller than 11 px; YAML uses the system's monospace font. Inter ships
with the app (`static/fonts/InterVariable.woff2`, one variable file for every
weight, SIL Open Font License) so that text looks the same on every machine and
nothing is fetched from elsewhere. The system fonts remain as fallback for
scripts Inter does not cover.

**Themes.** `night` (dark, the default) and `day` (light). The root element
carries `data-theme`; the stylesheet defines every color as a CSS variable in
`:root` (night) and again in `:root[data-theme="day"]`, and names a color
nowhere else, so a switch recolors everything. `js/theme-boot.js` applies a
remembered day theme before the first paint, so a light page never flashes
dark first. In both themes text and health colors have a contrast of at
least 4.5 : 1 against every surface (checked by `test/shell.test.js`).

Health colors (each also paired with a shape, so that color is not the only
cue):

| | night | day |
|---|---|---|
| green | `#3fb950` | `#177530` |
| yellow | `#d29922` | `#855800` |
| red | `#f85149` | `#c5202b` |

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
- **Pods shown twice** (in their namespace and under an opened node): reveal
  goes to the instance in the namespace.
- **Dots** differ in shape as well as color: ● green, ▲ yellow, ■ red.
- **Kind identifiers the UI depends on**: `core/Node` (falls back to the Nodes
  area) and `core/Namespace` (maps to the `ns:<name>` box).

The frontend has been exercised with jsdom, including end to end against the
real backend, but layout and styling can only be judged in a browser.
