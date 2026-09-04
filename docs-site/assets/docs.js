/* NotionForge Engineering Dossier — page runtime.
   Builds the in-page table of contents, heading anchors, scroll-spy,
   wraps wide tables, and reports hash changes to the index shell. */
(function () {
  'use strict';
  function slug(t) { return t.toLowerCase().replace(/[`'"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
  function init(root) {
    root = root || document;
    var content = root.querySelector('.content');
    if (!content) return;
    var seen = {};
    var heads = content.querySelectorAll('h2, h3, h4');
    heads.forEach(function (h) {
      if (!h.id) {
        var s = slug(h.textContent) || 'section';
        var n = s, i = 2;
        while (seen[n] || document.getElementById(n)) { n = s + '-' + i++; }
        h.id = n;
      }
      seen[h.id] = true;
      if (!h.querySelector('.anchor')) {
        var a = document.createElement('a');
        a.className = 'anchor'; a.href = '#' + h.id; a.textContent = '#'; a.setAttribute('aria-label', 'Link to section');
        h.appendChild(a);
      }
    });
    var toc = root.querySelector('.toc');
    if (toc && !toc.dataset.built) {
      toc.dataset.built = '1';
      var title = document.createElement('div'); title.className = 'toc-title'; title.textContent = 'On this page'; toc.appendChild(title);
      content.querySelectorAll('h2, h3').forEach(function (h) {
        var a = document.createElement('a');
        a.href = '#' + h.id; a.textContent = h.textContent.replace(/#$/, '').trim();
        if (h.tagName === 'H3') a.className = 'l3';
        toc.appendChild(a);
      });
      var links = toc.querySelectorAll('a');
      var spy = function () {
        var y = window.scrollY + 90, cur = null;
        content.querySelectorAll('h2, h3').forEach(function (h) { if (h.offsetTop <= y) cur = h.id; });
        links.forEach(function (l) { l.classList.toggle('active', cur && l.getAttribute('href') === '#' + cur); });
      };
      window.addEventListener('scroll', spy, { passive: true }); spy();
    }
    content.querySelectorAll('table').forEach(function (t) {
      if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
      var w = document.createElement('div'); w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t); w.appendChild(t);
    });
    // Links to other dossier pages open in the shell when framed, otherwise as plain pages.
    if (window.parent !== window) {
      document.querySelectorAll('a[data-route]').forEach(function (a) {
        a.addEventListener('click', function (e) { e.preventDefault(); window.parent.postMessage({ type: 'nf-route', route: a.dataset.route }, '*'); });
      });
      window.addEventListener('hashchange', function () { window.parent.postMessage({ type: 'nf-hash', hash: location.hash.slice(1) }, '*'); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(); }); else init();
  window.nfInitPage = init;
})();
