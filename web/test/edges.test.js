import test from 'node:test';
import assert from 'node:assert/strict';

import * as edges from '../static/js/edges.js';
import * as fx from './fixtures.js';

/**
 * A stand-in for the rendered canvas: `rendered` lists element ids that
 * exist, `nesting` maps an id to the ids rendered inside it.
 */
function canvas(rendered, nesting = {}) {
  const ids = new Set(rendered);
  const inside = (outer, inner) =>
      (nesting[outer] ?? []).some((id) => id === inner || inside(id, inner));
  return {isRendered: (id) => ids.has(id), contains: inside};
}

const pairs = (arrows) => arrows.map((a) => `${a.from} -> ${a.to}`);

// --- Lifting -----------------------------------------------------------------

test('a reference between two rendered widgets is an arrow between them', () => {
  const arrows = edges.buildArrows([fx.route()], canvas(['route-1', 'gw-1', 'svc-1', 'ns:default']));

  assert.deepEqual(pairs(arrows), ['route-1 -> gw-1', 'route-1 -> svc-1']);
});

test('an arrow to a folded resource ends at its nearest rendered ancestor', () => {
  // The pod sits in a replica set inside a collapsed deployment.
  const arrows = edges.buildArrows([fx.service()], canvas(['svc-1', 'dep-1', 'ns:default']));

  assert.deepEqual(pairs(arrows), ['svc-1 -> dep-1']);
});

test('lifting prefers the innermost rendered ancestor', () => {
  const arrows = edges.buildArrows([fx.service()], canvas(['svc-1', 'dep-1', 'rs-1', 'ns:default']));

  assert.deepEqual(pairs(arrows), ['svc-1 -> rs-1']);
});

test('a target in a closed namespace lifts to the namespace box', () => {
  const source = fx.summary({
    uid: 'src', refs: [fx.ref({uid: 'far', namespace: 'shop', path: ['ns:shop', 'far-owner']})],
  });

  const arrows = edges.buildArrows([source], canvas(['src', 'ns:default', 'ns:shop']));

  assert.deepEqual(pairs(arrows), ['src -> ns:shop']);
});

test('an unrendered cluster-scoped target lifts to the cluster-wide area', () => {
  const arrows = edges.buildArrows([fx.gateway()], canvas(['gw-1', 'ns:default', 'cluster', 'nodes']));

  assert.deepEqual(pairs(arrows), ['gw-1 -> cluster']);
});

test('an unrendered Node target lifts to the Nodes area, not the cluster-wide area', () => {
  const pod = {...fx.pod(), refs: [fx.pod().refs[0]]};

  const arrows = edges.buildArrows([pod], canvas(['pod-1', 'ns:default', 'cluster', 'nodes']));

  assert.deepEqual(pairs(arrows), ['pod-1 -> nodes']);
});

test('a rendered Node widget is preferred over the Nodes area', () => {
  const pod = {...fx.pod(), refs: [fx.pod().refs[0]]};

  const arrows = edges.buildArrows([pod], canvas(['pod-1', 'node-1', 'nodes']));

  assert.deepEqual(pairs(arrows), ['pod-1 -> node-1']);
});

test('a reference to a Namespace object ends at that namespace box', () => {
  const source = fx.summary({
    uid: 'src', namespace: 'default',
    refs: [fx.ref({uid: fx.UID.nsShop, kindId: 'core/Namespace', kind: 'Namespace',
                   namespace: '', name: 'shop', path: ['cluster']})],
  });

  const arrows = edges.buildArrows([source], canvas(['src', 'ns:default', 'ns:shop', 'cluster']));

  assert.deepEqual(pairs(arrows), ['src -> ns:shop']);
});

test('an arrow whose end has no rendered ancestor at all is dropped', () => {
  const source = fx.summary({
    uid: 'src', refs: [fx.ref({uid: 'far', namespace: 'gone', path: ['ns:gone']})],
  });

  assert.deepEqual(edges.buildArrows([source], canvas(['src', 'ns:default'])), []);
});

test('a source that is not rendered itself is lifted the same way', () => {
  const arrows = edges.buildArrows([fx.pod()], canvas(['dep-1', 'cm-1', 'node-1', 'ns:default']));

  assert.deepEqual(pairs(arrows), ['dep-1 -> node-1', 'dep-1 -> cm-1']);
});

// --- Dropping and merging ----------------------------------------------------

test('an arrow whose two ends lift to the same element is dropped', () => {
  // A collapsed replica set referring to its own (unrendered) pod.
  const rs = {...fx.replicaSet(), refs: [fx.ref({
    uid: 'pod-1', kindId: 'core/Pod', kind: 'Pod', path: ['ns:default', 'dep-1', 'rs-1'],
  })]};

  assert.deepEqual(edges.buildArrows([rs], canvas(['rs-1', 'dep-1', 'ns:default'])), []);
});

test('an arrow is dropped when one end contains the other', () => {
  // The pod is listed inside the opened node it runs on.
  const pod = {...fx.pod(), refs: [fx.pod().refs[0]]};
  const inNode = canvas(['pod-1', 'node-1', 'nodes'], {'nodes': ['node-1'], 'node-1': ['pod-1']});
  assert.deepEqual(edges.buildArrows([pod], inNode), []);

  // A target lifted to the namespace box that also holds the source.
  const source = fx.summary({uid: 'src', refs: [fx.ref({uid: 'hidden', path: ['ns:default', 'folded']})]});
  const inNamespace = canvas(['src', 'ns:default'], {'ns:default': ['src']});
  assert.deepEqual(edges.buildArrows([source], inNamespace), []);
});

test('arrows that coincide after lifting are merged into one', () => {
  const service = {...fx.service(), refs: [
    fx.ref({uid: 'pod-a', kindId: 'core/Pod', relation: 'selector', path: ['ns:default', 'dep-1', 'rs-1']}),
    fx.ref({uid: 'pod-b', kindId: 'core/Pod', relation: 'selector', path: ['ns:default', 'dep-1', 'rs-1']}),
    fx.ref({uid: 'pod-c', kindId: 'core/Pod', relation: 'other', path: ['ns:default', 'dep-1', 'rs-2']}),
  ]};

  const arrows = edges.buildArrows([service], canvas(['svc-1', 'dep-1', 'ns:default']));

  assert.deepEqual(arrows, [{from: 'svc-1', to: 'dep-1', relations: ['other', 'selector']}]);
});

test('a summary loaded in two lists does not duplicate its arrows', () => {
  const arrows = edges.buildArrows([fx.route(), fx.route()], canvas(['route-1', 'gw-1', 'svc-1']));

  assert.deepEqual(pairs(arrows), ['route-1 -> gw-1', 'route-1 -> svc-1']);
});

test('opposite directions are two different arrows', () => {
  const a = fx.summary({uid: 'a', refs: [fx.ref({uid: 'b'})]});
  const b = fx.summary({uid: 'b', refs: [fx.ref({uid: 'a'})]});

  assert.deepEqual(pairs(edges.buildArrows([a, b], canvas(['a', 'b']))), ['a -> b', 'b -> a']);
});

test('summaries without references produce no arrows', () => {
  const bare = fx.summary({uid: 'a'});
  delete bare.refs;

  assert.deepEqual(edges.buildArrows([bare, fx.configMap()], canvas(['a', 'cm-1'])), []);
});

// --- Modes and the cap -------------------------------------------------------

const AB = {from: 'a', to: 'b', relations: ['r']};
const BC = {from: 'b', to: 'c', relations: ['r']};
const CD = {from: 'c', to: 'd', relations: ['r']};

test('mode "all" draws every arrow and emphasizes those touching the focus', () => {
  const got = edges.selectArrows([AB, BC, CD], {mode: 'all', focus: ['b']});

  assert.equal(got.capped, false);
  assert.deepEqual(got.arrows.map((a) => [a.from, a.to, a.emphasized]),
      [['a', 'b', true], ['b', 'c', true], ['c', 'd', false]]);
});

test('mode "selected" draws only the arrows touching the hovered or selected widget', () => {
  const got = edges.selectArrows([AB, BC, CD], {mode: 'selected', focus: ['d', 'a']});

  assert.equal(got.capped, false);
  assert.deepEqual(got.arrows.map((a) => [a.from, a.to, a.emphasized]), [['a', 'b', true], ['c', 'd', true]]);
});

test('mode "selected" without a focus draws nothing', () => {
  assert.deepEqual(edges.selectArrows([AB, BC], {mode: 'selected', focus: []}).arrows, []);
});

test('mode "off" draws nothing', () => {
  assert.deepEqual(edges.selectArrows([AB, BC], {mode: 'off', focus: ['a']}), {arrows: [], capped: false});
});

test('more than 300 arrows in mode "all" fall back to the selected-only behavior', () => {
  const lots = Array.from({length: 301}, (_, i) => ({from: `s${i}`, to: 'hub', relations: ['r']}));

  const atCap = edges.selectArrows(lots.slice(0, 300), {mode: 'all', focus: ['s7']});
  assert.equal(atCap.capped, false);
  assert.equal(atCap.arrows.length, 300);

  const overCap = edges.selectArrows(lots, {mode: 'all', focus: ['s7']});
  assert.equal(overCap.capped, true);
  assert.deepEqual(overCap.arrows.map((a) => [a.from, a.to, a.emphasized]), [['s7', 'hub', true]]);
});

test('the fallback is not reported in mode "selected"', () => {
  const lots = Array.from({length: 301}, (_, i) => ({from: `s${i}`, to: 'hub', relations: ['r']}));

  const got = edges.selectArrows(lots, {mode: 'selected', focus: ['hub']});

  assert.equal(got.capped, false);
  assert.equal(got.arrows.length, 301);
});

// --- Geometry ----------------------------------------------------------------

const rect = (x, y, width = 100, height = 40) => ({x, y, width, height});

test('a target to the right is entered on its left border from the source right border', () => {
  const got = edges.anchors(rect(0, 0), rect(300, 100));

  assert.deepEqual(got.start, {x: 100, y: 20, side: 'right'});
  assert.deepEqual(got.end, {x: 300, y: 120, side: 'left'});
});

test('a target to the left is entered on its right border', () => {
  const got = edges.anchors(rect(300, 100), rect(0, 0));

  assert.deepEqual(got.start, {x: 300, y: 120, side: 'left'});
  assert.deepEqual(got.end, {x: 100, y: 20, side: 'right'});
});

test('a target below, horizontally overlapping, is entered on its top border', () => {
  const got = edges.anchors(rect(0, 0), rect(50, 200));

  assert.deepEqual(got.start, {x: 50, y: 40, side: 'bottom'});
  assert.deepEqual(got.end, {x: 100, y: 200, side: 'top'});
});

test('a target above, horizontally overlapping, is entered on its bottom border', () => {
  const got = edges.anchors(rect(50, 200), rect(0, 0));

  assert.deepEqual(got.start, {x: 100, y: 200, side: 'top'});
  assert.deepEqual(got.end, {x: 50, y: 40, side: 'bottom'});
});

test('the curve is a cubic from border to border that arrives perpendicular to the target', () => {
  // Horizontal: control points extend along x, so the arrowhead points right.
  assert.equal(edges.curve(rect(0, 0), rect(300, 100)), 'M100 20 C200 20 200 120 300 120');
  // Vertical: control points extend along y, so the arrowhead points down.
  assert.equal(edges.curve(rect(0, 0), rect(50, 200)), 'M50 40 C50 120 100 120 100 200');
});

test('control points keep a minimum and a maximum reach', () => {
  // 10px apart: the reach is clamped up to 20.
  assert.equal(edges.curve(rect(0, 0), rect(110, 0)), 'M100 20 C120 20 90 20 110 20');
  // 1000px apart: the reach is clamped down to 120.
  assert.equal(edges.curve(rect(0, 0), rect(1100, 0)), 'M100 20 C220 20 980 20 1100 20');
});

test('coordinates are rounded to one decimal and never NaN', () => {
  const d = edges.curve({x: 0.123, y: 0.456, width: 33.333, height: 11.111}, {x: 200.06, y: 0, width: 0, height: 0});

  assert.equal(d, 'M33.5 6 C116.8 6 116.8 0 200.1 0');
  assert.doesNotMatch(edges.curve(rect(0, 0, 0, 0), rect(0, 0, 0, 0)), /NaN|Infinity/);
});

test('client rectangles are translated into the coordinates of the arrow layer', () => {
  const layer = {left: 260, top: 48, width: 900, height: 2000};
  const widget = {left: 300, top: 20, width: 120, height: 40};

  assert.deepEqual(edges.relativeRect(widget, layer), {x: 40, y: -28, width: 120, height: 40});
});
