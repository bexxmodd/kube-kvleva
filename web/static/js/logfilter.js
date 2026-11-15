// The filter of the live logs view: what the user typed, turned into a test
// for the text of one log line. Nothing here touches the page; view.js
// applies the test.
//
// Two forms are understood:
//   keyword     kept when the line contains it; upper and lower case are the
//               same, and every character stands for itself
//   /pattern/   a regular expression; /pattern/i ignores case

/**
 * A leading slash, a pattern that is not empty, the last slash, and after it
 * nothing but letters that are regular-expression flags. Anything else that
 * starts with a slash, such as the path /var/log, is a keyword.
 */
const REGEXP_FORM = /^\/(.+)\/([dgimsuvy]*)$/;

/** No filter, and what an invalid filter does as well: it filters nothing. */
const everything = () => true;

/**
 * @param {string} text What was entered in the filter field.
 * @return {{active: boolean, valid: boolean, matches: function(string): boolean}}
 *     `active` says whether the filter can hide lines; `valid` is false for
 *     something that was meant as a regular expression and is not one;
 *     `matches` says whether the text of a log line is kept.
 */
export function compileLogFilter(text) {
  if (text.trim() === '') return {active: false, valid: true, matches: everything};

  // Spaces around a regular expression, from pasting for example, do not
  // change what the text means.
  const form = REGEXP_FORM.exec(text.trim());
  if (form === null) {
    // The spaces around a keyword are part of it: " 500 " is not "1500ms".
    const keyword = text.toLowerCase();
    return {active: true, valid: true, matches: (line) => line.toLowerCase().includes(keyword)};
  }

  const [, pattern, flags] = form;
  // Only `i` is offered. `g` and `y` in particular would make the answer
  // depend on the line that was tested before.
  if (flags !== '' && flags !== 'i') return {active: false, valid: false, matches: everything};
  try {
    const expression = new RegExp(pattern, flags);
    return {active: true, valid: true, matches: (line) => expression.test(line)};
  } catch {
    return {active: false, valid: false, matches: everything};
  }
}
