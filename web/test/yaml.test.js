import test from 'node:test';
import assert from 'node:assert/strict';

import * as yaml from '../static/js/yaml.js';

/** The visible tokens of one line as [type, text] pairs (whitespace dropped). */
function line(text) {
  const lines = yaml.tokenize(text);
  assert.equal(lines.length, 1, `expected one line for ${JSON.stringify(text)}`);
  return visible(lines[0]);
}

function visible(tokens) {
  return tokens.filter((t) => t.text.trim() !== '').map((t) => [t.type, t.text]);
}

test('a key with a plain value', () => {
  assert.deepEqual(line('name: web'), [['key', 'name'], ['punct', ':'], ['text', 'web']]);
});

test('a key without a value', () => {
  assert.deepEqual(line('metadata:'), [['key', 'metadata'], ['punct', ':']]);
});

test('numbers are recognized, version-like text is not', () => {
  assert.deepEqual(line('replicas: 3'), [['key', 'replicas'], ['punct', ':'], ['number', '3']]);
  assert.deepEqual(line('ratio: -1.5e3'), [['key', 'ratio'], ['punct', ':'], ['number', '-1.5e3']]);
  assert.deepEqual(line('version: 1.2.3'), [['key', 'version'], ['punct', ':'], ['text', '1.2.3']]);
});

test('booleans and null are keywords', () => {
  for (const word of ['true', 'false', 'null', '~']) {
    assert.deepEqual(line(`x: ${word}`), [['key', 'x'], ['punct', ':'], ['keyword', word]]);
  }
});

test('quoted values are strings even when they look like something else', () => {
  assert.deepEqual(line('port: "80"'), [['key', 'port'], ['punct', ':'], ['string', '"80"']]);
  assert.deepEqual(line(`msg: 'it''s # fine'`), [['key', 'msg'], ['punct', ':'], ['string', `'it''s # fine'`]]);
  assert.deepEqual(line('msg: "say \\"hi\\" # x"'), [['key', 'msg'], ['punct', ':'], ['string', '"say \\"hi\\" # x"']]);
});

test('an unterminated quote runs to the end of the line', () => {
  assert.deepEqual(line('msg: "oops'), [['key', 'msg'], ['punct', ':'], ['string', '"oops']]);
});

test('comments start at a # that begins the line or follows a space', () => {
  assert.deepEqual(line('# a: b'), [['comment', '# a: b']]);
  assert.deepEqual(line('  name: "web: 1" # note'),
      [['key', 'name'], ['punct', ':'], ['string', '"web: 1"'], ['comment', '# note']]);
  assert.deepEqual(line('url: http://x/#frag'), [['key', 'url'], ['punct', ':'], ['text', 'http://x/#frag']]);
});

test('a colon inside a trailing comment does not turn the text before it into a key', () => {
  assert.deepEqual(line('- item # note: here'), [['punct', '-'], ['text', 'item'], ['comment', '# note: here']]);
  assert.deepEqual(line('plain # a: b'), [['text', 'plain'], ['comment', '# a: b']]);
});

test('a colon only separates a key when followed by a space or the line end', () => {
  assert.deepEqual(line('image: nginx:1.27'), [['key', 'image'], ['punct', ':'], ['text', 'nginx:1.27']]);
  assert.deepEqual(line('- nginx:1.27'), [['punct', '-'], ['text', 'nginx:1.27']]);
});

test('list markers are punctuation', () => {
  assert.deepEqual(line('- name: app'), [['punct', '-'], ['key', 'name'], ['punct', ':'], ['text', 'app']]);
  assert.deepEqual(line('  - - 5'), [['punct', '-'], ['punct', '-'], ['number', '5']]);
  assert.deepEqual(line('-'), [['punct', '-']]);
});

test('quoted keys are keys', () => {
  assert.deepEqual(line(`'a: b': 1`), [['key', `'a: b'`], ['punct', ':'], ['number', '1']]);
  assert.deepEqual(line('"k": v'), [['key', '"k"'], ['punct', ':'], ['text', 'v']]);
});

test('flow collections are split into punctuation and scalars', () => {
  assert.deepEqual(line('args: ["a, b", 1, x]'), [
    ['key', 'args'], ['punct', ':'], ['punct', '['], ['string', '"a, b"'], ['punct', ','],
    ['number', '1'], ['punct', ','], ['text', 'x'], ['punct', ']'],
  ]);
  assert.deepEqual(line('labels: {}'), [['key', 'labels'], ['punct', ':'], ['punct', '{'], ['punct', '}']]);
});

test('the lines of a block scalar are strings, not keys or comments', () => {
  const lines = yaml.tokenize([
    'data:',
    '  script: |',
    '    key: value   # not a comment',
    '',
    '    - item',
    '  next: 1',
  ].join('\n'));

  assert.deepEqual(lines.map(visible), [
    [['key', 'data'], ['punct', ':']],
    [['key', 'script'], ['punct', ':'], ['punct', '|']],
    [['string', 'key: value   # not a comment']],
    [],
    [['string', '- item']],
    [['key', 'next'], ['punct', ':'], ['number', '1']],
  ]);
});

test('block scalar indicators with modifiers are recognized', () => {
  for (const indicator of ['|-', '>', '>+', '|2', '>-']) {
    const lines = yaml.tokenize(`a: ${indicator}\n  x: 1\nb: 2`);
    assert.deepEqual(lines.map(visible), [
      [['key', 'a'], ['punct', ':'], ['punct', indicator]],
      [['string', 'x: 1']],
      [['key', 'b'], ['punct', ':'], ['number', '2']],
    ], indicator);
  }
});

test('a block scalar inside a list item ends at the next sibling key', () => {
  const lines = yaml.tokenize([
    '- run: |',
    '    echo: hi',
    '  name: step',
  ].join('\n'));

  assert.deepEqual(lines.map(visible), [
    [['punct', '-'], ['key', 'run'], ['punct', ':'], ['punct', '|']],
    [['string', 'echo: hi']],
    [['key', 'name'], ['punct', ':'], ['text', 'step']],
  ]);
});

test('a trailing newline does not add a line, an empty text has no lines', () => {
  assert.equal(yaml.tokenize('a: 1\n').length, 1);
  assert.equal(yaml.tokenize('a: 1\n\nb: 2\n').length, 3);
  assert.deepEqual(yaml.tokenize(''), []);
  assert.deepEqual(yaml.tokenize(undefined), []);
});

test('tokens always reproduce the input exactly, whatever it contains', () => {
  const inputs = [
    'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\nspec:\n  containers:\n  - name: app\n    image: nginx:1.27\n',
    '<img src=x onerror=alert(1)>: <script>alert(1)</script>',
    '\t\ttabs: \there',
    ':',
    ': :',
    '- - - ',
    '   ',
    'a: "unterminated\nb: \'also',
    'k: [1, {a: b}, "c"] # tail',
    'windows: line\r\nendings: yes\r\n',
    'unicode: ✓ 日本語 # ok',
    'data: |\n   deep\n  shallow\n back',
    '"": ""',
    '#',
    'a:b:c: d',
    'k: |not-a-block',
    'a: |\n\n\n',
  ];
  for (const input of inputs) {
    const rebuilt = yaml.tokenize(input).map((tokens) => tokens.map((t) => t.text).join('')).join('\n');
    const expected = input.endsWith('\n') ? input.slice(0, -1) : input;
    assert.equal(rebuilt, expected, JSON.stringify(input));
    for (const tokens of yaml.tokenize(input)) {
      for (const token of tokens) {
        assert.ok(['key', 'punct', 'string', 'number', 'keyword', 'comment', 'text'].includes(token.type),
            `unexpected type ${token.type}`);
        assert.notEqual(token.text, '', 'tokens are never empty');
      }
    }
  }
});
