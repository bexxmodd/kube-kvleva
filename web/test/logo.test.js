import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// The logo outside the app: the folder that offers it on its own, and the
// README of the project. The logo inside the app is covered by shell.test.js.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFileSync(ROOT + name, 'utf8');

/** The logo the app ships and shows. Every other copy must be this drawing. */
const SHIPPED = 'web/static/img/logo.svg';
const FOLDER = 'assets/logo/';
const SIZES = [16, 32, 48, 64, 128, 256, 512];

/** The opening <svg ...> tag of a picture. */
const rootTag = (svg) => /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';

test('the logo folder offers the logo of the app as a picture that scales to any size', () => {
  const offered = read(FOLDER + 'kvleva.svg');

  assert.equal(offered, read(SHIPPED), 'run `make logo`: the folder must offer the logo the app shows');
  assert.match(rootTag(offered), /\sviewBox="/, 'a viewBox is what lets it scale');
  assert.doesNotMatch(rootTag(offered), /\s(width|height)="/, 'no size of its own: it takes the size it is given');
});

test('the logo folder offers the same logo in a range of fixed sizes', () => {
  const shipped = read(SHIPPED);

  for (const size of SIZES) {
    const name = `${FOLDER}kvleva-${size}.svg`;
    assert.ok(existsSync(ROOT + name), `${name} is missing: run \`make logo\``);
    const sized = read(name);
    const tag = rootTag(sized);
    assert.match(tag, new RegExp(`\\swidth="${size}"`), `${name} must be ${size} wide`);
    assert.match(tag, new RegExp(`\\sheight="${size}"`), `${name} must be ${size} high`);
    // Apart from its size it is the logo of the app, line for line.
    assert.equal(sized.replace(tag, rootTag(shipped)), shipped, `${name} is not the logo the app shows: run \`make logo\``);
  }
});

test('the logo folder holds the logo, its sizes and their description, and nothing else', () => {
  const expected = ['README.md', 'kvleva.svg', ...SIZES.map((size) => `kvleva-${size}.svg`)].sort();

  assert.deepEqual(readdirSync(ROOT + FOLDER).sort(), expected);
  for (const size of SIZES) {
    assert.match(read(FOLDER + 'README.md'), new RegExp(`kvleva-${size}\\.svg`), `the description must list kvleva-${size}.svg`);
  }
});

test('the README of the project starts with the logo', () => {
  const readme = read('README.md');

  const image = /<img\b[^>]*>/.exec(readme);

  assert.ok(image, 'the README shows no picture');
  assert.equal(readme.slice(0, image.index).replace(/<[^>]*>/g, '').trim(), '', 'nothing is written before the logo');
  // A path inside the project, so that the picture shows on the project page
  // and in a local copy alike. It is the largest of the sized copies, shown
  // at the size that file has.
  assert.equal(/\ssrc="([^"]*)"/.exec(image[0])?.[1], `${FOLDER}kvleva-${Math.max(...SIZES)}.svg`);
  assert.doesNotMatch(image[0], /\s(width|height)="/, 'the file brings its size; the README must not shrink it');
  assert.match(image[0], /\salt="[^"]*kvleva[^"]*"/i, 'the picture must say what it is to those who cannot see it');
  assert.ok(readme.indexOf('# kube-kvleva') > image.index, 'the title follows the logo');
});
