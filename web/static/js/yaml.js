// A deliberately small YAML tokenizer used only to color the manifests shown in
// the details drawer. It does not parse YAML: it splits each line into typed
// pieces. The pieces of a line always concatenate back to exactly that line, so
// coloring can never change what the user reads or copies.
//
// Token types: key, punct, string, number, keyword, comment, text.

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const KEYWORDS = new Set(['true', 'false', 'null', '~']);
const BLOCK_INDICATOR = /^[|>][-+0-9]*$/;
const FLOW_PUNCT = '[]{},';

/** @typedef {{type: string, text: string}} Token */

const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r';
const endsToken = (ch) => ch === undefined || isSpace(ch);

/**
 * @param {string} s
 * @param {number} from
 * @return {number} Index of the first non-space character at or after `from`.
 */
function skipSpaces(s, from) {
  let i = from;
  while (i < s.length && isSpace(s[i])) i++;
  return i;
}

/**
 * @param {string} s
 * @param {number} start Index of the opening quote.
 * @return {number} Index just past the closing quote, or the string length
 *     when the quote is never closed.
 */
function quoteEnd(s, start) {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (quote === '"' && s[i] === '\\') {
      i += 2;
    } else if (s[i] === quote) {
      if (quote === '\'' && s[i + 1] === '\'') {
        i += 2;
      } else {
        return i + 1;
      }
    } else {
      i++;
    }
  }
  return s.length;
}

/**
 * @param {string} rest A line without indentation and list markers.
 * @return {number} Length of the mapping key that starts `rest`, or -1.
 */
function keyLength(rest) {
  if (rest[0] === '"' || rest[0] === '\'') {
    const end = quoteEnd(rest, 0);
    return rest[end] === ':' && endsToken(rest[end + 1]) ? end : -1;
  }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ':' && endsToken(rest[i + 1])) return i;
    if (rest[i] === '#' && i > 0 && isSpace(rest[i - 1])) return -1;
  }
  return -1;
}

/**
 * Tokenizes the value part of a line (everything after `key:` or `- `).
 * @param {string} value
 * @param {function(string, string)} push Appends a token.
 * @return {boolean} Whether the value opens a block scalar.
 */
function scanValue(value, push) {
  const first = value[skipSpaces(value, 0)];
  const flow = first === '[' || first === '{';
  let opensBlock = false;
  let scalars = 0;
  let bare = '';

  const flushBare = (type) => {
    if (bare === '') return;
    const start = skipSpaces(bare, 0);
    let end = bare.length;
    while (end > start && isSpace(bare[end - 1])) end--;
    const core = bare.slice(start, end);
    push('text', bare.slice(0, start));
    if (core !== '') {
      scalars++;
      if (type) {
        push(type, core);
      } else if (NUMBER.test(core)) {
        push('number', core);
      } else if (KEYWORDS.has(core)) {
        push('keyword', core);
      } else if (!flow && scalars === 1 && BLOCK_INDICATOR.test(core)) {
        push('punct', core);
        opensBlock = true;
      } else {
        push('text', core);
      }
    }
    push('text', bare.slice(end));
    bare = '';
  };

  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if ((ch === '"' || ch === '\'') && bare.trim() === '') {
      flushBare();
      const end = quoteEnd(value, i);
      push('string', value.slice(i, end));
      scalars++;
      i = end;
    } else if (ch === '#' && (i === 0 || isSpace(value[i - 1]))) {
      flushBare();
      push('comment', value.slice(i));
      i = value.length;
    } else if (flow && FLOW_PUNCT.includes(ch)) {
      flushBare();
      push('punct', ch);
      i++;
    } else if (flow && ch === ':' && endsToken(value[i + 1])) {
      flushBare('key');
      push('punct', ch);
      i++;
    } else {
      bare += ch;
      i++;
    }
  }
  flushBare();
  return opensBlock && scalars === 1;
}

/**
 * @param {string} line One line outside of a block scalar.
 * @return {{tokens: !Array<!Token>, opensBlock: boolean, column: number}}
 *     `column` is where the line's content starts (after indentation and list
 *     markers); a block scalar opened here holds every deeper line.
 */
function tokenizeLine(line) {
  const tokens = [];
  const push = (type, text) => {
    if (text !== '') tokens.push({type, text});
  };

  let pos = skipSpaces(line, 0);
  push('text', line.slice(0, pos));
  while (line[pos] === '-' && endsToken(line[pos + 1])) {
    push('punct', '-');
    const next = skipSpaces(line, pos + 1);
    push('text', line.slice(pos + 1, next));
    pos = next;
  }
  const column = pos;

  let rest = line.slice(pos);
  if (rest[0] === '#') {
    push('comment', rest);
    return {tokens, opensBlock: false, column};
  }
  const keyLen = keyLength(rest);
  if (keyLen >= 0) {
    push('key', rest.slice(0, keyLen));
    push('punct', ':');
    rest = rest.slice(keyLen + 1);
  }
  const opensBlock = scanValue(rest, push);
  return {tokens, opensBlock, column};
}

/**
 * @param {string} line One line inside a block scalar.
 * @return {!Array<!Token>}
 */
function blockLine(line) {
  const start = skipSpaces(line, 0);
  const tokens = [];
  if (start > 0) tokens.push({type: 'text', text: line.slice(0, start)});
  if (start < line.length) tokens.push({type: 'string', text: line.slice(start)});
  return tokens;
}

/**
 * Splits YAML text into lines of typed tokens.
 * @param {string|undefined} text
 * @return {!Array<!Array<!Token>>} One token array per line. A single trailing
 *     newline does not produce an extra empty line.
 */
export function tokenize(text) {
  if (!text) return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  let blockColumn = -1;
  return body.split('\n').map((line) => {
    if (blockColumn >= 0) {
      if (line.trim() === '' || skipSpaces(line, 0) > blockColumn) return blockLine(line);
      blockColumn = -1;
    }
    const {tokens, opensBlock, column} = tokenizeLine(line);
    if (opensBlock) blockColumn = column;
    return tokens;
  });
}
