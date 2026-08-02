// Local TCP Bridge — documentation page behavior.
// Kept in an external file (not inline) so index.html works as an MV3
// extension page too, where inline scripts are blocked by the default CSP.
(function () {
  'use strict';

  // ── Nav shadow on scroll ──────────────────────────────────────
  var nav = document.getElementById('nav');
  var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 12); };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── Reveal on scroll ──────────────────────────────────────────
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var reveals = document.querySelectorAll('.reveal:not(.in)');
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  // ── Tabs (usage / install / uninstall) ────────────────────────
  document.querySelectorAll('[data-tabs]').forEach(function (group) {
    var btns = group.querySelectorAll('.tab-btn');
    var panels = group.querySelectorAll('.tab-panel');
    function activate(key) {
      btns.forEach(function (b) { b.classList.toggle('active', b.dataset.tab === key); });
      panels.forEach(function (p) { p.classList.toggle('active', p.dataset.tab === key); });
    }
    btns.forEach(function (b) {
      b.addEventListener('click', function () { activate(b.dataset.tab); });
    });
  });

  // ── Auto-select the viewer's platform on the guide tabs ───────
  function detectOs() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (p.indexOf('win') !== -1) return 'win';
    if (p.indexOf('linux') !== -1 && p.indexOf('android') === -1) return 'linux';
    if (p.indexOf('android') !== -1) return 'linux';
    return 'mac';
  }

  // ── Label table cells so they can stack into cards on phones ──
  document.querySelectorAll('.table-wrap table').forEach(function (t) {
    var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
    t.querySelectorAll('tbody tr').forEach(function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, i) {
        if (heads[i]) td.setAttribute('data-label', heads[i]);
      });
    });
  });

  // ── Pull the live version from the extension manifest ─────────
  // The v2.1.1 text in the markup is only a fallback; this keeps every
  // version badge in sync with manifest.json's "version" field.
  fetch('manifest.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (m) {
      if (!m || !m.version) return;
      var v = 'v' + m.version;
      document.querySelectorAll('[data-version]').forEach(function (el) { el.textContent = v; });
    })
    .catch(function () { /* keep the fallback text already in the markup */ });

  var os = detectOs();
  document.querySelectorAll('[data-platform-tabs]').forEach(function (group) {
    var target = group.querySelector('.tab-btn[data-os="' + os + '"]') || group.querySelector('.tab-btn');
    if (!target) return;
    // mark "You" badge
    var badge = target.querySelector('.os-you');
    if (badge) badge.hidden = false;
    // activate matching button + panel
    var key = target.dataset.tab;
    group.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === key); });
    group.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.tab === key); });
  });
})();
