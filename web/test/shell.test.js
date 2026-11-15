import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';

const STATIC = fileURLToPath(new URL('../static/', import.meta.url));
const read = (name) => readFileSync(STATIC + name, 'utf8');
const shell = () => new JSDOM(read('index.html')).window.document;

test('the shell loads the stylesheet, the theme boot script and the module entry point by relative URL', () => {
  const doc = shell();

  const sheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
  const scripts = [...doc.querySelectorAll('script')].map((s) => [s.getAttribute('src'), s.getAttribute('type')]);

  assert.deepEqual(sheets, ['css/app.css']);
  assert.deepEqual(scripts, [['js/theme-boot.js', null], ['js/main.js', 'module']]);
});

test('the theme boot script runs before anything is drawn', () => {
  const doc = shell();

  // A plain script in the head blocks rendering until it has run, unlike the
  // module, which runs after the page was parsed: that is what keeps the
  // night theme from flashing before a remembered day theme.
  const boot = doc.querySelector('script[src="js/theme-boot.js"]');
  assert.ok(boot, 'js/theme-boot.js is not loaded');
  assert.equal(boot.parentElement, doc.head);
  for (const attribute of ['defer', 'async', 'type']) {
    assert.equal(boot.hasAttribute(attribute), false, `${attribute} would let the page be drawn first`);
  }
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

test('the shell has the header, sidebar, canvas and drawer regions', () => {
  const doc = shell();

  for (const id of [
    'cluster-name', 'cluster-version', 'sync', 'stream', 'pills', 'search',
    'sidebar', 'health-filter',
    'kind-search', 'kinds-all', 'kinds-none', 'kind-list',
    'canvas', 'canvas-content', 'cluster-box', 'cluster-title', 'expand-all', 'collapse-all', 'areas',
    'drawer', 'drawer-close', 'drawer-body', 'app-error',
  ]) {
    assert.ok(doc.getElementById(id), `#${id} is missing`);
  }
  assert.equal(doc.getElementById('drawer').hidden, true, 'the drawer starts closed');
});

test('the shell draws no reference arrows and offers no control for them', () => {
  const doc = shell();

  assert.equal(doc.querySelectorAll('svg').length, 0, 'no arrow layer over the canvas');
  for (const id of ['arrows', 'arrow-paths', 'arrowhead', 'connections-filter', 'connections-note']) {
    assert.equal(doc.getElementById(id), null, `#${id} belongs to the removed arrows`);
  }
  assert.equal(doc.querySelectorAll('#sidebar input[type="radio"]').length, 0);
  assert.doesNotMatch(doc.getElementById('sidebar').textContent, /connections/i);
});

test('the header has the system resources switch, off, between the cluster name and the totals', () => {
  const doc = shell();

  const toggle = doc.getElementById('system-toggle');
  assert.ok(toggle, '#system-toggle is missing');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.checked, false, 'system resources start hidden');
  assert.match(toggle.closest('label').textContent, /system resources/i);
  assert.ok(doc.getElementById('system-count'), '#system-count is missing');

  // "Top left to middle": in the header, after the cluster it belongs to and
  // before the right-aligned totals and search box.
  const header = doc.querySelector('header.header');
  const order = [...header.children].map((child) => child.id || child.className);
  const at = (name) => order.indexOf(name);
  assert.ok(header.contains(toggle));
  assert.ok(at('cluster-name') < at('switch') && at('switch') < at('pills') && at('pills') < at('search'),
      `header order is ${order.join(', ')}`);
});

test('the header starts with the button that hides and shows the filters panel', () => {
  const doc = shell();

  const button = doc.getElementById('sidebar-toggle');
  assert.ok(button, '#sidebar-toggle is missing');
  assert.equal(button.localName, 'button');
  assert.equal(doc.querySelector('header.header').firstElementChild, button, 'top left, above the panel it controls');
  assert.equal(button.getAttribute('aria-controls'), 'sidebar');
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'the panel starts shown');
  assert.match(button.textContent, /filters/i);
  assert.equal(doc.getElementById('sidebar').hidden, false);
});

test('the header ends with the button that switches between the night and the day theme', () => {
  const doc = shell();

  const button = doc.getElementById('theme-toggle');
  assert.ok(button, '#theme-toggle is missing');
  assert.equal(button.localName, 'button');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(doc.querySelector('header.header').lastElementChild, button, 'top right');
  // The page starts in the night theme, so the button offers the day theme.
  assert.equal(doc.documentElement.hasAttribute('data-theme'), false);
  assert.match(button.textContent, /day/i);
  assert.equal(button.getAttribute('aria-label'), 'Switch to the day theme');
});

test('a divider that can be dragged and focused sits between the filters panel and the canvas', () => {
  const doc = shell();

  const divider = doc.getElementById('sidebar-resizer');
  assert.ok(divider, '#sidebar-resizer is missing');
  assert.equal(divider.previousElementSibling.id, 'sidebar');
  assert.equal(divider.nextElementSibling.id, 'canvas');
  assert.equal(divider.getAttribute('role'), 'separator');
  assert.equal(divider.getAttribute('aria-orientation'), 'vertical');
  assert.equal(divider.getAttribute('aria-controls'), 'sidebar');
  assert.equal(divider.getAttribute('tabindex'), '0');
  assert.ok(divider.getAttribute('aria-label'));
});

test('the stylesheet caps the filters panel at a third of the window and marks the divider as draggable', () => {
  const css = read('css/app.css');
  const rule = (selector) => new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  // The cap lives in the stylesheet too, so it holds when the window is made
  // smaller after the panel was resized.
  assert.match(rule('\\.sidebar'), /max-width:\s*calc\(100vw\s*\/\s*3\)/);
  assert.match(rule('\\.sidebar'), /width:\s*260px/, 'the default width');
  assert.match(rule('\\.resizer'), /cursor:\s*col-resize/, 'the pointer shows that the line can be dragged');
  assert.match(css, /\.resizing-panel[^{]*\{[^}]*cursor:\s*col-resize/);
});

test('a second divider sits between the canvas and the details panel and starts hidden with it', () => {
  const doc = shell();

  const divider = doc.getElementById('drawer-resizer');
  assert.ok(divider, '#drawer-resizer is missing');
  assert.equal(divider.previousElementSibling.id, 'canvas');
  assert.equal(divider.nextElementSibling.id, 'drawer');
  assert.equal(divider.getAttribute('role'), 'separator');
  assert.equal(divider.getAttribute('aria-orientation'), 'vertical');
  assert.equal(divider.getAttribute('aria-controls'), 'drawer');
  assert.equal(divider.getAttribute('tabindex'), '0');
  assert.ok(divider.getAttribute('aria-label'));
  assert.ok(divider.classList.contains('resizer'));
  assert.equal(divider.hidden, true, 'the details panel starts closed');
});

test('the stylesheet caps the details panel at a third of the window too', () => {
  const css = read('css/app.css');
  const rule = /(?:^|\n)\.drawer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  assert.match(rule, /max-width:\s*calc\(100vw\s*\/\s*3\)/);
  assert.match(rule, /width:\s*480px/, 'the default width');
  assert.doesNotMatch(rule, /50vw/, 'the old half-window cap is gone');
});

test('the stylesheet indents the resource types of an API group slightly past the checkbox of their group', () => {
  const css = read('css/app.css');
  const rule = (selector) => new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const px = (selector, property) =>
      Number(new RegExp(`(?:^|[\\s;])${property}:\\s*(?:0\\s+0\\s+0\\s+)?(\\d+)px`).exec(rule(selector))?.[1]);

  // The checkbox of a group starts after the collapse button and the gap that
  // follows it; the checkboxes of its types must start further to the right.
  const groupCheckbox = px('\\.toggle', 'width') + px('\\.kind-group-bar', 'gap');
  const typeCheckbox = px('\\.kind-group-kinds', 'padding(?:-left)?');
  const indent = typeCheckbox - groupCheckbox;

  assert.ok(indent >= 8 && indent <= 20,
      `types start ${typeCheckbox}px in, the checkbox of their group ${groupCheckbox}px: indented by ${indent}px`);
});

test('the sidebar has the three health checkboxes', () => {
  const doc = shell();

  const healths = [...doc.querySelectorAll('#health-filter input[type="checkbox"]')].map((i) => i.dataset.health);

  assert.deepEqual(healths, ['green', 'yellow', 'red']);
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
    'css/app.css', 'fonts/Inter-LICENSE.txt', 'fonts/InterVariable.woff2', 'index.html',
    'js/api.js', 'js/filters.js', 'js/layout.js', 'js/main.js', 'js/theme-boot.js', 'js/tree.js', 'js/view.js',
    'js/yaml.js',
  ]);
});

test('the stylesheet defines the health colors as variables and styles no arrows', () => {
  const css = read('css/app.css');
  const variable = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();

  assert.equal(variable('green'), '#3fb950');
  assert.equal(variable('yellow'), '#d29922');
  assert.equal(variable('red'), '#f85149');
  assert.doesNotMatch(css, /arrow/i, 'the arrow layer was removed');
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

test('the stylesheet fetches nothing from outside the app and keeps hidden elements hidden', () => {
  const css = read('css/app.css');

  assert.doesNotMatch(css, /@import/i, 'no imports');
  // The only files a stylesheet may load are the fonts shipped next to it:
  // under the CSP default-src 'self' anything else would be refused anyway.
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/gi)].map((match) => match[1]);
  for (const url of urls) {
    assert.match(url, /^\.\.\/fonts\/[A-Za-z0-9._-]+\.woff2$/, `url(${url}) must be a font shipped with the app`);
    assert.ok(existsSync(STATIC + 'css/' + url), `url(${url}) points to a file that is not shipped`);
  }
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

// --- Typeface and text size ----------------------------------------------------

/** Everything the stylesheet declares for the body, from all of its rules. */
const bodyRules = (css) => [...css.matchAll(/(?:^|\n|,\s*)body\s*\{([^}]*)\}/g)].map((match) => match[1]).join('\n');

test('text is set in Inter, which ships with the app together with its licence', () => {
  const css = read('css/app.css');

  const face = /@font-face\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(face, /font-family:\s*["']?Inter["']?\s*;/);
  assert.match(face, /src:\s*url\(\s*["']?\.\.\/fonts\/InterVariable\.woff2["']?\s*\)\s*format\(["']woff2["']\)/);
  assert.match(face, /font-weight:\s*100\s+900/, 'one variable file covers every weight');

  const sans = /--sans:\s*([^;]+);/.exec(css)?.[1] ?? '';
  assert.match(sans, /^["']?Inter["']?\s*,/, 'Inter comes first');
  assert.match(sans, /sans-serif\s*$/, 'with a fallback for scripts Inter does not cover');
  assert.match(bodyRules(css), /font:[^;]*var\(--sans\)/);

  const font = readFileSync(STATIC + 'fonts/InterVariable.woff2');
  assert.equal(font.subarray(0, 4).toString('latin1'), 'wOF2', 'a real WOFF2 file');
  assert.match(read('fonts/Inter-LICENSE.txt'), /SIL Open Font License, Version 1\.1/);
});

test('ordinary text is 14px and no text is smaller than 11px', () => {
  const css = read('css/app.css');

  assert.match(bodyRules(css), /font:\s*14px\//);
  const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(sizes.length > 0);
  for (const size of sizes) {
    assert.match(size, /^\d+px$/, `font-size ${size}`);
    assert.ok(Number.parseInt(size, 10) >= 11, `font-size ${size} is too small to read`);
  }
});

// --- Themes --------------------------------------------------------------------

/** The custom properties of a theme block that hold a color, by name. */
function themeColors(css, selector) {
  const block = new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  return {
    block,
    colors: Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [m[1], m[2]])),
  };
}

/** WCAG 2 contrast ratio between two #rrggbb colors. */
function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const NIGHT = ':root';
const DAY = ':root\\[data-theme="day"\\]';

test('the day theme redefines every color of the night theme', () => {
  const css = read('css/app.css');
  const night = themeColors(css, NIGHT);
  const day = themeColors(css, DAY);

  assert.match(night.block, /color-scheme:\s*dark/);
  assert.match(day.block, /color-scheme:\s*light/, 'so that scrollbars and form controls follow');
  for (const name of ['bg', 'panel', 'panel-raised', 'line', 'text', 'muted', 'accent', 'green', 'yellow', 'red']) {
    assert.ok(night.colors[name], `the night theme must define --${name}`);
  }
  assert.deepEqual(Object.keys(day.colors).sort(), Object.keys(night.colors).sort(),
      'a color the day theme forgets would stay dark on a light page');
  for (const name of ['bg', 'panel', 'panel-raised', 'line', 'text', 'muted']) {
    assert.notEqual(day.colors[name], night.colors[name], `--${name} must differ between the themes`);
  }
  assert.ok(contrast(day.colors.bg, '#ffffff') < 1.2, 'the day theme is light');
  assert.ok(contrast(night.colors.bg, '#000000') < 1.2, 'the night theme is dark');
});

test('colors are only defined in the two themes, so nothing keeps the wrong color after a switch', () => {
  const css = read('css/app.css');
  const outside = css
      .replace(new RegExp(`(?:^|\\n)${NIGHT}\\s*\\{[^}]*\\}`), '')
      .replace(new RegExp(`(?:^|\\n)${DAY}\\s*\\{[^}]*\\}`), '');

  assert.notEqual(outside, css);
  assert.deepEqual(outside.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? [], []);
});

for (const [theme, selector] of [['night', NIGHT], ['day', DAY]]) {
  test(`in the ${theme} theme text is readable and health colors stand out on every surface`, () => {
    const {colors} = themeColors(read('css/app.css'), selector);

    for (const surface of ['bg', 'panel', 'panel-raised']) {
      for (const text of ['text', 'muted', 'accent', 'tok-key', 'tok-string', 'tok-number', 'tok-keyword']) {
        const ratio = contrast(colors[text], colors[surface]);
        assert.ok(ratio >= 4.5, `--${text} on --${surface}: contrast ${ratio.toFixed(2)}, want at least 4.5`);
      }
      // Health colors outline boxes and color small glyphs and counts.
      for (const health of ['green', 'yellow', 'red']) {
        const ratio = contrast(colors[health], colors[surface]);
        assert.ok(ratio >= 4.5, `--${health} on --${surface}: contrast ${ratio.toFixed(2)}, want at least 4.5`);
      }
    }
    assert.ok(contrast(colors['on-accent'], colors.accent) >= 3, 'the knob of a switched-on switch shows on its track');
  });
}

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
  for (const name of ['api.js', 'filters.js', 'layout.js', 'tree.js', 'yaml.js']) {
    const code = read('js/' + name).split('\n').filter((l) => !isComment(l)).join('\n');
    assert.doesNotMatch(code, /\b(document|window|localStorage|navigator|globalThis)\b/, `js/${name}`);
    assert.doesNotMatch(code, /^import /m, `js/${name} must stay dependency-free`);
  }
});
