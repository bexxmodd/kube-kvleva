// Applies a remembered day theme before the page is drawn.
//
// This is the one script of the app that is not a module. index.html loads it
// in the <head>, where a plain script holds back rendering until it has run;
// the modules only run after the page was parsed, by which time a page that
// should be light would already have been shown dark for a moment.
//
// It only ever sets the fixed value "day". The storage key and the value are
// those of loadTheme / saveTheme in layout.js, which the app uses from then on
// (test/theme_boot.test.js keeps the two in step).
(() => {
  try {
    if (window.localStorage.getItem('kvleva.theme') === 'day') {
      document.documentElement.dataset.theme = 'day';
    }
  } catch {
    // Storage is forbidden or unavailable: the page stays in the night theme.
  }
})();
