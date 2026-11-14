import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';

const STATIC = fileURLToPath(new URL('../static/', import.meta.url));
const read = (name) => readFileSync(STATIC + name, 'utf8');
const shell = () => new JSDOM(read('index.html')).window.document;

test('the shell loads the stylesheet and the module entry point by relative URL', () => {
  const doc = shell();

  const sheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
  const scripts = [...doc.querySelectorAll('script')].map((s) => [s.getAttribute('src'), s.getAttribute('type')]);

  assert.deepEqual(sheets, ['css/app.css']);
  assert.deepEqual(scripts, [['js/main.js', 'module']]);
});

test('the shell works under the CSP default-src \'self\'', () => {
  const doc = shell();

  assert.equal(doc.querySelectorAll('style').length, 0, 'no inline <style>');
  for (const script of doc.querySelectorAll('script')) {
    assert.equal(script.textContent.trim(), '', 'no inline script');
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      assert.notEqual(attr.name, 'style', `style attribute on <${el.localName}>`);
      assert.doesNotMatch(attr.name, /^on/, `inline handler ${attr.name} on <${el.localName}>`);
      if (['href', 'src', 'action', 'data', 'poster', 'srcset'].includes(attr.name)) {
        assert.doesNotMatch(attr.value, /^([a-z][a-z0-9+.-]*:|\/\/)/i, `remote URL ${attr.value}`);
      }
    }
  }
});

test('the shell offers nothing that could submit or modify', () => {
  const doc = shell();

  assert.equal(doc.querySelectorAll('form').length, 0);
  for (const button of doc.querySelectorAll('button')) {
    assert.equal(button.getAttribute('type'), 'button', `button ${button.id} must not be a submit button`);
  }
});

test('the shell has the header, sidebar, canvas, arrow layer and drawer regions', () => {
  const doc = shell();

  for (const id of [
    'cluster-name', 'cluster-version', 'sync', 'stream', 'pills', 'search',
    'sidebar', 'health-filter', 'connections-filter', 'connections-note',
    'kind-search', 'kinds-all', 'kinds-none', 'kind-list',
    'canvas', 'canvas-content', 'cluster-box', 'cluster-title', 'expand-all', 'collapse-all', 'areas',
    'arrows', 'arrow-paths', 'arrowhead', 'arrowhead-emphasized',
    'drawer', 'drawer-close', 'drawer-body', 'app-error',
  ]) {
    assert.ok(doc.getElementById(id), `#${id} is missing`);
  }
  assert.equal(doc.getElementById('drawer').hidden, true, 'the drawer starts closed');
  assert.equal(doc.getElementById('arrows').namespaceURI, 'http://www.w3.org/2000/svg');
  assert.ok(doc.getElementById('canvas-content').contains(doc.getElementById('arrows')),
      'the arrow layer lives inside the scrolling content so it scrolls with it');
});

test('the sidebar has the three health checkboxes and the three connection modes', () => {
  const doc = shell();

  const healths = [...doc.querySelectorAll('#health-filter input[type="checkbox"]')].map((i) => i.dataset.health);
  const modes = [...doc.querySelectorAll('#connections-filter input[type="radio"]')].map((i) => i.value);

  assert.deepEqual(healths, ['green', 'yellow', 'red']);
  assert.deepEqual(modes, ['all', 'selected', 'off']);
  for (const input of doc.querySelectorAll('#sidebar input')) {
    const labelled = input.closest('label') !== null || input.getAttribute('aria-label');
    assert.ok(labelled, `input ${input.id || input.value || input.dataset.health} needs a label`);
  }
});

test('only the documented files are shipped', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(STATIC + dir, {withFileTypes: true})) {
      const path = dir + entry.name;
      if (entry.isDirectory()) walk(path + '/'); else files.push(path);
    }
  };
  walk('');

  assert.deepEqual(files.sort(), [
    'css/app.css', 'index.html',
    'js/api.js', 'js/edges.js', 'js/filters.js', 'js/main.js', 'js/tree.js', 'js/view.js', 'js/yaml.js',
  ]);
});

test('the stylesheet defines the health and arrow colors as variables', () => {
  const css = read('css/app.css');
  const variable = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();

  assert.equal(variable('green'), '#3fb950');
  assert.equal(variable('yellow'), '#d29922');
  assert.equal(variable('red'), '#f85149');
  assert.equal(variable('arrow'), '#8b949e');
  assert.equal(variable('arrow-emphasized'), '#58a6ff');
});

test('every health has an outline rule of at least 2px solid in its color', () => {
  const css = read('css/app.css');

  for (const health of ['green', 'yellow', 'red']) {
    assert.match(css, new RegExp(`\\.health-${health}\\s*\\{[^}]*--health:\\s*var\\(--${health}\\)`),
        `.health-${health} must select the ${health} color`);
  }
  for (const box of ['widget', 'container', 'area']) {
    const rule = new RegExp(`\\.${box}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const border = /border:\s*(\d+)px\s+solid\s+var\(--health\)/.exec(rule);
    assert.ok(border, `.${box} must have a solid border in the health color`);
    assert.ok(Number(border[1]) >= 2, `.${box} border must be at least 2px`);
  }
});

test('a box without a known health falls back to neutral instead of inheriting its container color', () => {
  const css = read('css/app.css');

  // Custom properties inherit: without a reset, a widget with an unknown
  // health inside a red area would be outlined in red.
  const reset = /((?:\.[a-z-]+(?: [a-z]+)?,\s*)*\.[a-z-]+(?: [a-z]+)?)\s*\{\s*--health:\s*var\(--muted\);\s*\}/.exec(css);
  assert.ok(reset, 'a rule must reset --health to the neutral color');
  const selectors = reset[1].split(',').map((s) => s.trim());
  for (const box of ['.widget', '.container', '.area', '.dot']) {
    assert.ok(selectors.includes(box), `${box} must reset --health`);
  }
  assert.ok(reset.index < css.indexOf('.health-green'), 'the health classes must come later so that they win');
});

test('the stylesheet fetches nothing and keeps hidden elements hidden', () => {
  const css = read('css/app.css');

  assert.doesNotMatch(css, /@import|url\(/i, 'no imports, fonts or images');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('no script builds markup from strings or evaluates code', () => {
  const forbidden = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setAttribute\(\s*['"]on|srcdoc|createContextualFragment|DOMParser/;
  for (const bad of ['el.innerHTML = name', 'el.insertAdjacentHTML("beforeend", x)', 'document.write(x)',
                     'eval (code)', 'el.setAttribute("onclick", x)']) {
    assert.match(bad, forbidden, 'the guard itself must recognize: ' + bad);
  }
  for (const name of readdirSync(STATIC + 'js')) {
    const lines = read('js/' + name).split('\n');
    lines.forEach((text, i) => {
      assert.doesNotMatch(text, forbidden, `js/${name}:${i + 1}`);
    });
  }
  assert.ok(existsSync(STATIC + 'js/view.js'));
});

test('DOM-free modules do not reach for browser globals', () => {
  const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);
  for (const name of ['api.js', 'filters.js', 'tree.js', 'edges.js', 'yaml.js']) {
    const code = read('js/' + name).split('\n').filter((l) => !isComment(l)).join('\n');
    assert.doesNotMatch(code, /\b(document|window|localStorage|navigator|globalThis)\b/, `js/${name}`);
    assert.doesNotMatch(code, /^import /m, `js/${name} must stay dependency-free`);
  }
});
