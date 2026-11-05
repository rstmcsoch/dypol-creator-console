/* DYPOL Creator Console — light/dark theme toggle.
 * Loaded as a classic (non-module) script in <head> so the saved theme is
 * applied before first paint (no flash). Choice persists in localStorage;
 * first visit follows the device's prefers-color-scheme. */
(function (root) {
  'use strict';
  var KEY = 'dypol-theme';
  var META = { light: '#F5F4EE', dark: '#171715' };

  function systemTheme(win) {
    try { return win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  function saved(win) {
    try { var v = win.localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; }
    catch (e) { return null; }
  }
  function initial(win) { return saved(win) || systemTheme(win); }

  function apply(theme, doc) {
    theme = theme === 'dark' ? 'dark' : 'light';
    doc.documentElement.setAttribute('data-theme', theme);
    doc.documentElement.style.colorScheme = theme;
    var m = doc.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', META[theme]);
    var btns = doc.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var dark = theme === 'dark';
      btns[i].setAttribute('aria-pressed', dark ? 'true' : 'false');
      btns[i].setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      btns[i].setAttribute('title', dark ? 'Light mode' : 'Dark mode');
    }
    return theme;
  }

  function toggle(win, doc) {
    var next = doc.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { win.localStorage.setItem(KEY, next); } catch (e) { /* private mode: still switch */ }
    return apply(next, doc);
  }

  function bind(win, doc) {
    apply(doc.documentElement.getAttribute('data-theme') || initial(win), doc);
    doc.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest && ev.target.closest('[data-theme-toggle]');
      if (t) { ev.preventDefault(); toggle(win, doc); }
    });
    // Follow the device setting live only while the user hasn't chosen.
    try {
      var mq = win.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (!saved(win)) apply(systemTheme(win), doc); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    } catch (e) { /* old browsers */ }
  }

  var api = { KEY: KEY, META: META, systemTheme: systemTheme, saved: saved, initial: initial, apply: apply, toggle: toggle, bind: bind };
  root.DypolTheme = api;
  if (root.document && root.document.documentElement) {
    apply(initial(root), root.document);           // before paint
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', function () { bind(root, root.document); });
    else bind(root, root.document);
  }
})(typeof window !== 'undefined' ? window : globalThis);
