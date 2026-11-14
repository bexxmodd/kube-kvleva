// Reference arrows: which arrows exist given what is rendered (lifting,
// dropping, merging), which of them to draw (modes and the cap), and the
// geometry of one arrow from two rectangles. DOM-free: the view supplies
// "is this id rendered", "does this element contain that one" and rectangles.
//
// Element ids are the uid of a widget, `ns:<name>` for a namespace box,
// `cluster` for the cluster-wide area and `nodes` for the Nodes area.

/** Arrows drawn at once in mode "all" before falling back to selected-only. */
export const MAX_ARROWS = 300;

const NODE_KIND = 'core/Node';
const NAMESPACE_KIND = 'core/Namespace';

/**
 * Ids that can stand for an endpoint, most specific first: its own widget,
 * then its ancestors from the innermost outward.
 * @param {{uid: string, kindId: string, name: string, path?: !Array<string>}} endpoint
 * @return {!Array<string>}
 */
function candidates(endpoint) {
  const ids = [endpoint.uid];
  // A Namespace object is shown as its namespace box, not as a widget.
  if (endpoint.kindId === NAMESPACE_KIND) ids.push(`ns:${endpoint.name}`);
  const path = endpoint.path ?? [];
  for (let i = path.length - 1; i >= 0; i--) {
    // Nodes are cluster-scoped but live in their own area.
    ids.push(path[i] === 'cluster' && endpoint.kindId === NODE_KIND ? 'nodes' : path[i]);
  }
  return ids;
}

/**
 * Replaces an endpoint by its nearest rendered ancestor.
 * @param {!Object} endpoint A ResourceSummary or one of its refs.
 * @param {function(string): boolean} isRendered
 * @return {?string} An element id, or null when nothing of it is rendered.
 */
export function lift(endpoint, isRendered) {
  return candidates(endpoint).find(isRendered) ?? null;
}

/**
 * Computes the arrows for everything that is loaded.
 * @param {!Iterable<!Object>} summaries Loaded ResourceSummary objects.
 * @param {{isRendered: function(string): boolean,
 *          contains: function(string, string): boolean}} canvas
 * @return {!Array<{from: string, to: string, relations: !Array<string>}>}
 *     One arrow per ordered pair of distinct, non-nested elements.
 */
export function buildArrows(summaries, {isRendered, contains}) {
  const merged = new Map();
  for (const summary of summaries) {
    if (!summary.refs?.length) continue;
    const from = lift(summary, isRendered);
    if (from === null) continue;
    for (const ref of summary.refs) {
      const to = lift(ref, isRendered);
      if (to === null || to === from) continue;
      if (contains(from, to) || contains(to, from)) continue;
      const key = `${from}\n${to}`;
      let arrow = merged.get(key);
      if (!arrow) {
        arrow = {from, to, relations: new Set()};
        merged.set(key, arrow);
      }
      if (ref.relation) arrow.relations.add(ref.relation);
    }
  }
  return [...merged.values()].map((a) => ({from: a.from, to: a.to, relations: [...a.relations].sort()}));
}

/**
 * Chooses the arrows to draw.
 * @param {!Array<{from: string, to: string}>} arrows From buildArrows.
 * @param {{mode: string, focus: !Array<string>, cap?: number}} options `focus`
 *     holds the ids of the hovered and the selected widget.
 * @return {{arrows: !Array<!Object>, capped: boolean}} `capped` reports that
 *     mode "all" had too many arrows and only the focused ones are drawn.
 */
export function selectArrows(arrows, {mode, focus, cap = MAX_ARROWS}) {
  if (mode === 'off') return {arrows: [], capped: false};
  const focused = new Set(focus);
  const marked = arrows.map((a) => ({...a, emphasized: focused.has(a.from) || focused.has(a.to)}));
  const capped = mode === 'all' && marked.length > cap;
  if (mode === 'all' && !capped) return {arrows: marked, capped};
  return {arrows: marked.filter((a) => a.emphasized), capped};
}

// --- Geometry ----------------------------------------------------------------

/** @typedef {{x: number, y: number, width: number, height: number}} Rect */

const MIN_REACH = 20;
const MAX_REACH = 120;

/** Unit vector pointing out of a rectangle through each of its sides. */
const OUTWARD = {
  left: {x: -1, y: 0},
  right: {x: 1, y: 0},
  top: {x: 0, y: -1},
  bottom: {x: 0, y: 1},
};

/**
 * @param {!Rect} rect
 * @param {string} side
 * @return {{x: number, y: number, side: string}} Middle of that side.
 */
function sideMiddle(rect, side) {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  switch (side) {
    case 'left': return {x: rect.x, y: midY, side};
    case 'right': return {x: rect.x + rect.width, y: midY, side};
    case 'top': return {x: midX, y: rect.y, side};
    default: return {x: midX, y: rect.y + rect.height, side};
  }
}

/**
 * Picks the border points an arrow connects. Rectangles side by side connect
 * through their facing vertical borders; rectangles above each other through
 * their facing horizontal borders.
 * @param {!Rect} source
 * @param {!Rect} target
 * @return {{start: {x: number, y: number, side: string},
 *           end: {x: number, y: number, side: string}}}
 */
export function anchors(source, target) {
  let sides;
  if (source.x + source.width <= target.x) {
    sides = ['right', 'left'];
  } else if (target.x + target.width <= source.x) {
    sides = ['left', 'right'];
  } else if (source.y + source.height <= target.y) {
    sides = ['bottom', 'top'];
  } else if (target.y + target.height <= source.y) {
    sides = ['top', 'bottom'];
  } else {
    // Overlapping rectangles (not expected for drawn arrows): go by centers.
    const dx = (target.x + target.width / 2) - (source.x + source.width / 2);
    const dy = (target.y + target.height / 2) - (source.y + source.height / 2);
    if (Math.abs(dx) >= Math.abs(dy)) {
      sides = dx >= 0 ? ['right', 'left'] : ['left', 'right'];
    } else {
      sides = dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
    }
  }
  return {start: sideMiddle(source, sides[0]), end: sideMiddle(target, sides[1])};
}

const round = (n) => String(Math.round(n * 10) / 10);

/**
 * SVG path data of the arrow between two rectangles: a cubic curve that leaves
 * the source border and reaches the target border perpendicularly, so an
 * `orient="auto"` arrowhead points into the target.
 * @param {!Rect} source
 * @param {!Rect} target
 * @return {string}
 */
export function curve(source, target) {
  const {start, end} = anchors(source, target);
  const out = OUTWARD[start.side];
  const into = OUTWARD[end.side];
  const gap = Math.abs(out.x !== 0 ? end.x - start.x : end.y - start.y);
  const reach = Math.min(MAX_REACH, Math.max(MIN_REACH, gap / 2));
  const c1 = {x: start.x + out.x * reach, y: start.y + out.y * reach};
  const c2 = {x: end.x + into.x * reach, y: end.y + into.y * reach};
  return `M${round(start.x)} ${round(start.y)} ` +
      `C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(end.x)} ${round(end.y)}`;
}

/**
 * Translates a client rectangle (from getBoundingClientRect) into the
 * coordinate system of the arrow layer.
 * @param {{left: number, top: number, width: number, height: number}} rect
 * @param {{left: number, top: number}} layer Client rectangle of the layer.
 * @return {!Rect}
 */
export function relativeRect(rect, layer) {
  return {x: rect.left - layer.left, y: rect.top - layer.top, width: rect.width, height: rect.height};
}
