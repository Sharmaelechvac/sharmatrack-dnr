/* SHARMATRACK — Job Documents tab renderer (Phase 1, 2026-11-19).
   Reads docs.json relative to this job page (GitHub Pages-safe, same
   pattern as seed-photos.json) and renders the five document sections,
   newest first. If docs.json is missing or unreadable, every section
   renders its empty state — the rest of the page is never affected. */
(function () {
  var root = document.getElementById("docs-root");
  if (!root) return;

  var SECTIONS = [
    { key: "plans", label: "Plans" },
    { key: "permits", label: "Permits" },
    { key: "inspections", label: "Inspections" },
    { key: "cois", label: "COIs" },
    { key: "energy", label: "Energy calc / Manual J" }
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso || "");
    try {
      return d.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }) + " ET";
    } catch (e) {
      return d.toLocaleString("en-US");
    }
  }

  function fmtSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 1048576) return " · " + (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return " · " + Math.round(n / 1024) + " KB";
    return " · " + n + " B";
  }

  function render(entries) {
    var bySection = {};
    SECTIONS.forEach(function (s) { bySection[s.key] = []; });
    (Array.isArray(entries) ? entries : []).forEach(function (e) {
      if (e && bySection.hasOwnProperty(e.section)) bySection[e.section].push(e);
    });
    root.innerHTML = SECTIONS.map(function (s) {
      var rows = bySection[s.key].slice().sort(function (a, b) {
        return new Date(b.added_at || 0) - new Date(a.added_at || 0);
      });
      var body;
      if (!rows.length) {
        body = '<p class="docs-empty">No documents on file yet</p>';
      } else {
        body = rows.map(function (e) {
          var href = "docs/" + encodeURIComponent(s.key) + "/" +
            encodeURIComponent(e.filename || "");
          var meta = esc(e.filename || "") + fmtSize(e.bytes) +
            "<br>Added by " + esc(e.added_by || "Jarvis") + " · " + fmtDate(e.added_at);
          return '<a class="docs-item" href="' + href + '" target="_blank" rel="noopener">' +
            '<span class="docs-title">' + esc(e.title || e.filename || "Document") + "</span>" +
            '<span class="docs-meta">' + meta + "</span></a>";
        }).join("");
      }
      return '<div class="docs-sec"><h3 class="docs-sec-h">' + esc(s.label) + "</h3>" + body + "</div>";
    }).join("");
  }

  render([]); // empty states first, so the tab is never blank or broken
  fetch("docs.json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (rows) { render(Array.isArray(rows) ? rows : []); })
    .catch(function () { /* keep the empty states */ });
})();
