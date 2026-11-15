import test from 'node:test';
import assert from 'node:assert/strict';

import {compileLogFilter} from '../static/js/logfilter.js';

/** The lines of the feature file (features/live_logs.feature, rule "The lines that are shown can be filtered"). */
const LINES = ['GET /healthz 200', 'ERROR disk full', 'error: retrying a.b', 'saved axb'];

/** The lines a filter text lets through. */
const kept = (text, lines = LINES) => lines.filter((line) => compileLogFilter(text).matches(line));

// --- No filter ---------------------------------------------------------------

test('no text, or only spaces, is no filter: every line matches', () => {
  for (const text of ['', ' ', '   \t ']) {
    const filter = compileLogFilter(text);

    assert.equal(filter.active, false, JSON.stringify(text));
    assert.equal(filter.valid, true, JSON.stringify(text));
    assert.deepEqual(kept(text), LINES);
    assert.equal(filter.matches(''), true);
  }
});

// --- Keywords ----------------------------------------------------------------

test('a keyword keeps the lines that contain it, whatever their case', () => {
  const filter = compileLogFilter('error');

  assert.equal(filter.active, true);
  assert.equal(filter.valid, true);
  assert.deepEqual(kept('error'), ['ERROR disk full', 'error: retrying a.b']);
  assert.deepEqual(kept('ERROR'), ['ERROR disk full', 'error: retrying a.b']);
  assert.deepEqual(kept('Disk Full'), ['ERROR disk full']);
  assert.deepEqual(kept('no such text'), []);
});

test('a keyword is taken literally: characters that mean something in a regular expression are just characters', () => {
  assert.deepEqual(kept('a.b'), ['error: retrying a.b'], 'the dot is a dot, not any character');
  const lines = ['price (EUR) is 5$', 'a+b=c', 'x|y', 'path\\to', '[warn] *', 'q? ^caret', 'plain'];
  for (const [keyword, want] of [
    ['(eur)', ['price (EUR) is 5$']], ['5$', ['price (EUR) is 5$']], ['a+b', ['a+b=c']], ['x|y', ['x|y']],
    ['\\to', ['path\\to']], ['[warn]', ['[warn] *']], ['*', ['[warn] *']], ['q?', ['q? ^caret']],
    ['^caret', ['q? ^caret']], ['.', []],
  ]) {
    assert.deepEqual(kept(keyword, lines), want, keyword);
  }
  assert.equal(compileLogFilter('(').valid, true, 'what would be a broken pattern is a fine keyword');
  assert.deepEqual(kept('(', lines), ['price (EUR) is 5$']);
});

test('the spaces around a keyword are part of it', () => {
  const lines = ['status 500 sent', 'took 1500ms', '500'];

  assert.deepEqual(kept(' 500 ', lines), ['status 500 sent']);
  assert.deepEqual(kept('500', lines), lines);
  assert.deepEqual(kept(' 500', lines), ['status 500 sent']);
});

test('text that only looks like the start of a regular expression is a keyword', () => {
  const lines = ['GET /healthz 200', 'a // comment', 'see /abc for more', 'no slash'];
  for (const [keyword, want] of [
    ['/', ['GET /healthz 200', 'a // comment', 'see /abc for more']],
    ['//', ['a // comment']],
    ['/abc', ['see /abc for more']],
    ['/healthz 200', ['GET /healthz 200']],
  ]) {
    const filter = compileLogFilter(keyword);
    assert.equal(filter.valid, true, keyword);
    assert.equal(filter.active, true, keyword);
    assert.deepEqual(kept(keyword, lines), want, keyword);
  }
});

test('a path is a keyword, not a regular expression with unknown flags', () => {
  const lines = ['open /var/log/app.log', 'GET /api/v1/pods 200', 'GET /healthz/ready 200', 'variable logged'];
  for (const [keyword, want] of [
    ['/var/log', ['open /var/log/app.log']],
    ['/api/v1/pods', ['GET /api/v1/pods 200']],
    ['/HEALTHZ/ready', ['GET /healthz/ready 200']],
  ]) {
    const filter = compileLogFilter(keyword);
    assert.equal(filter.valid, true, keyword);
    assert.deepEqual(kept(keyword, lines), want, keyword);
  }
});

test('spaces around a regular expression do not turn it into a keyword', () => {
  // A stray space, from pasting for example, must not silently change what
  // the text means.
  assert.deepEqual(kept(' /error/i'), ['ERROR disk full', 'error: retrying a.b']);
  assert.deepEqual(kept('/^error/ '), ['error: retrying a.b']);
  assert.equal(compileLogFilter('/(/ ').valid, false);
  // Spaces inside the pattern stay part of it.
  assert.deepEqual(kept('/disk full/'), ['ERROR disk full']);
  assert.deepEqual(kept('/ disk /'), ['ERROR disk full']);
});

// --- Regular expressions -----------------------------------------------------

test('text between slashes is a regular expression', () => {
  const filter = compileLogFilter('/^ERROR|200$/');

  assert.equal(filter.active, true);
  assert.equal(filter.valid, true);
  assert.deepEqual(kept('/^ERROR|200$/'), ['GET /healthz 200', 'ERROR disk full']);
  assert.deepEqual(kept('/a.b/'), ['error: retrying a.b', 'saved axb'], 'here the dot is any character');
  assert.deepEqual(kept('/\\d{3}$/'), ['GET /healthz 200']);
  assert.deepEqual(kept('/^(GET|saved) /'), ['GET /healthz 200', 'saved axb']);
});

test('a regular expression tells upper from lower case, unless it ends in /i', () => {
  assert.deepEqual(kept('/error/'), ['error: retrying a.b']);
  assert.deepEqual(kept('/ERROR/'), ['ERROR disk full']);
  assert.deepEqual(kept('/error/i'), ['ERROR disk full', 'error: retrying a.b']);
  assert.deepEqual(kept('/^ERROR/i'), ['ERROR disk full', 'error: retrying a.b']);
});

test('a regular expression may contain slashes: the last one closes it', () => {
  const lines = ['GET /healthz/ready 200', 'GET /healthz 200', 'open /var/log/app.log'];

  assert.deepEqual(kept('/healthz/ready/', lines), ['GET /healthz/ready 200']);
  assert.deepEqual(kept('/\\/var\\/log\\//', lines), ['open /var/log/app.log']);
  assert.deepEqual(kept('/^GET .*/ready/i', lines), ['GET /healthz/ready 200']);
});

test('flags other than i make the filter invalid', () => {
  const unsupported = ['/error/g', '/error/m', '/error/gi', '/error/ig', '/error/y', '/error/s', '/error/u', '/error/ii'];
  for (const text of unsupported) {
    const filter = compileLogFilter(text);

    assert.equal(filter.valid, false, text);
    assert.equal(filter.active, false, text);
  }
});

test('a pattern that is not a regular expression makes the filter invalid', () => {
  for (const text of ['/(/', '/[a-/', '/a{2,1}/', '/*/', '/(?<n>a)(?<n>b)\\k<m>/', '/\\/']) {
    const filter = compileLogFilter(text);

    assert.equal(filter.valid, false, text);
    assert.equal(filter.active, false, text);
  }
});

test('an invalid filter filters nothing: every line matches', () => {
  assert.deepEqual(kept('/(/'), LINES);
  assert.deepEqual(kept('/error/g'), LINES);
  assert.equal(compileLogFilter('/(/').matches(''), true);
});

test('asking a filter again about the same line gives the same answer', () => {
  for (const text of ['/error/', '/error/i', '/r/', 'error']) {
    const filter = compileLogFilter(text);
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(filter.matches('error: retrying, error again'));
    answers.push(filter.matches('nothing'), filter.matches('error: retrying, error again'));

    assert.deepEqual(answers, [true, true, true, true, false, true], text);
  }
});

test('compiling never throws, whatever was typed', () => {
  const typed = ['/', '//', '///', '/\\', '\\', '/(?', '/+/', '/a/b/c', '/[/', '\u0000', '/\n/', 'a\nb', '/a/\n'];
  for (const text of typed) {
    const filter = compileLogFilter(text);

    assert.equal(typeof filter.active, 'boolean', JSON.stringify(text));
    assert.equal(typeof filter.valid, 'boolean', JSON.stringify(text));
    assert.equal(typeof filter.matches('some line'), 'boolean', JSON.stringify(text));
  }
});
