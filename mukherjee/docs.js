/* SHARMATRACK — Job Documents tab renderer (Phase 1 v2, 2026-11-19).
   Architecture (Sanjay's direction, 2026-11-19: "We want GITHUB"):
   document contents live in THIS repo, but only encrypted — the same
   sharma-enc-v1 scheme as the bid boards and Sharma AR (AES-GCM 256,
   key from PBKDF2-HMAC-SHA256, 600k iterations, shared office code).

     mukherjee/documents.enc.json          encrypted index (names, sections,
                                           who added, when, sizes, hashes)
     mukherjee/documents/<section>/*.enc   one encrypted envelope per file;
                                           decryption reproduces the original
                                           file byte-for-byte.

   Until the tab is unlocked it shows ONLY a code prompt — no file names,
   no section contents. The derived key (never the code) is kept in
   sessionStorage for this tab, like the other Sharma apps. All envelopes
   for a job share one salt, so the one key opens the index and every file.
   If documents.enc.json does not exist yet, the tab renders a clean
   "no documents on file yet" state — the page never breaks. */
(function () {
  var root = document.getElementById("docs-root");
  if (!root) return;

  var INDEX_URL = "documents.enc.json";
  var STORE = "sharma-docs-key:v1";
  var subtle = window.crypto && window.crypto.subtle;
  var textEnc = new TextEncoder(), textDec = new TextDecoder();

  var SECTIONS = [
    { key: "plans", label: "Plans" },
    { key: "permits", label: "Permits" },
    { key: "inspections", label: "Inspections" },
    { key: "cois", label: "COIs" },
    { key: "energy", label: "Energy calc / Manual J" }
  ];

  var MIME = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", txt: "text/plain", json: "application/json",
    csv: "text/csv", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };
  var VIEWABLE = { pdf: 1, png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, txt: 1 };

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

  /* ---- base64 (chunked: file envelopes can be megabytes) ---- */
  function unb64(s) {
    var b = atob(s), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }
  function b64(buf) {
    var a = new Uint8Array(buf), s = "", i;
    for (i = 0; i < a.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  /* ---- sharma-enc-v1 envelope handling (same checks as lock.js) ---- */
  function checkEnvelope(e) {
    if (!e || e.format !== "sharma-enc-v1" || e.kdf !== "PBKDF2-SHA256" || e.cipher !== "AES-GCM-256" ||
        typeof e.salt !== "string" || typeof e.iv !== "string" || typeof e.ciphertext !== "string" ||
        !(e.iterations >= 600000)) {
      throw new Error("not a sharma-enc-v1 envelope");
    }
    return e;
  }
  function deriveKey(code, e) {
    return subtle.importKey("raw", textEnc.encode(code), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: unb64(e.salt), iterations: e.iterations },
        base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
    });
  }
  function decryptBytes(key, e) {
    return subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv) }, key, unb64(e.ciphertext));
  }
  function savedKey(e) {
    try {
      var s = JSON.parse(sessionStorage.getItem(STORE) || "null");
      if (!s || s.salt !== e.salt || s.iterations !== e.iterations || !s.k) return null;
      return subtle.importKey("raw", unb64(s.k), { name: "AES-GCM" }, false, ["decrypt"]);
    } catch (x) { return null; }
  }
  function rememberKey(key, e) {
    return subtle.exportKey("raw", key).then(function (raw) {
      try { sessionStorage.setItem(STORE, JSON.stringify({ salt: e.salt, iterations: e.iterations, k: b64(raw) })); } catch (x) {}
    });
  }
  function forgetKey() { try { sessionStorage.removeItem(STORE); } catch (x) {} }

  /* ---- rendering ---- */
  var indexEnv = null;   // envelope of documents.enc.json
  var liveKey = null;    // CryptoKey for this session, once unlocked

  function sectionsHtml(entries) {
    var bySection = {};
    SECTIONS.forEach(function (s) { bySection[s.key] = []; });
    (Array.isArray(entries) ? entries : []).forEach(function (e) {
      if (e && bySection.hasOwnProperty(e.section)) bySection[e.section].push(e);
    });
    return SECTIONS.map(function (s) {
      var rows = bySection[s.key].slice().sort(function (a, b) {
        return new Date(b.added_at || 0) - new Date(a.added_at || 0);
      });
      var body;
      if (!rows.length) {
        body = '<p class="docs-empty">No documents on file yet</p>';
      } else {
        body = rows.map(function (e, i) {
          var meta = esc(e.name || "") + fmtSize(e.bytes) +
            "<br>Added by " + esc(e.added_by || "Jarvis") + " · " + fmtDate(e.added_at);
          return '<button type="button" class="docs-item" data-sec="' + esc(s.key) + '" data-idx="' + i + '">' +
            '<span class="docs-title">' + esc(e.title || e.name || "Document") + "</span>" +
            '<span class="docs-meta">' + meta + "</span></button>";
        }).join("");
      }
      return '<div class="docs-sec"><h3 class="docs-sec-h">' + esc(s.label) + "</h3>" + body + "</div>";
    }).join("");
  }

  function renderUnlocked(index) {
    var entries = (index && Array.isArray(index.entries)) ? index.entries : [];
    root.innerHTML =
      '<div class="docs-lockrow"><button type="button" class="docs-lockbtn" id="docs-lock">Lock</button></div>' +
      sectionsHtml(entries);
    document.getElementById("docs-lock").addEventListener("click", function () {
      liveKey = null; forgetKey(); showLock("");
    });
    var bySection = {};
    SECTIONS.forEach(function (s) { bySection[s.key] = []; });
    entries.forEach(function (e) { if (e && bySection.hasOwnProperty(e.section)) bySection[e.section].push(e); });
    SECTIONS.forEach(function (s) {
      bySection[s.key].sort(function (a, b) { return new Date(b.added_at || 0) - new Date(a.added_at || 0); });
    });
    Array.prototype.forEach.call(root.querySelectorAll(".docs-item"), function (btn) {
      btn.addEventListener("click", function () {
        var entry = bySection[btn.getAttribute("data-sec")][Number(btn.getAttribute("data-idx"))];
        if (entry) openEntry(entry, btn);
      });
    });
  }

  function renderSetup() {
    root.innerHTML =
      '<p class="docs-note">No documents on file yet — document storage for this job is being set up.</p>' +
      sectionsHtml([]);
  }

  function showLock(errMsg) {
    root.innerHTML =
      '<form class="docs-lock" id="docs-lockform" autocomplete="off" novalidate>' +
      '<p class="docs-lock-p">Documents for this job are locked. Enter the office code to view them.</p>' +
      '<label class="docs-lock-label" for="docs-code">Office code</label>' +
      '<input class="docs-lock-input" id="docs-code" name="docs-code" type="password" inputmode="numeric" ' +
      'pattern="[0-9]*" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" maxlength="12" required>' +
      '<button class="docs-unlock" type="submit">Unlock documents</button>' +
      '<div class="docs-err" role="alert"' + (errMsg ? "" : " hidden") + ">" + esc(errMsg || "") + "</div>" +
      "</form>";
    var form = document.getElementById("docs-lockform");
    var input = document.getElementById("docs-code");
    var btn = form.querySelector(".docs-unlock");
    var err = form.querySelector(".docs-err");
    setTimeout(function () { try { input.focus(); } catch (x) {} }, 50);
    input.addEventListener("input", function () { err.hidden = true; });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = input.value.trim();
      if (!code) { err.textContent = "Enter the code"; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = "Checking…"; err.hidden = true;
      deriveKey(code, indexEnv).then(function (key) {
        return decryptBytes(key, indexEnv).then(function (pt) {
          var index = JSON.parse(textDec.decode(pt));
          code = ""; input.value = "";
          liveKey = key;
          return rememberKey(key, indexEnv).then(function () { renderUnlocked(index); });
        });
      }).catch(function () {
        code = ""; input.value = "";
        err.textContent = "Wrong code"; err.hidden = false;
        btn.disabled = false; btn.textContent = "Unlock documents";
        input.focus();
      });
    });
  }

  function openEntry(entry, btn) {
    if (!liveKey || !entry.stored) return;
    var titleEl = btn.querySelector(".docs-title");
    var old = titleEl.textContent;
    btn.disabled = true; titleEl.textContent = "Opening…";
    function done() { btn.disabled = false; titleEl.textContent = old; }
    fetch(entry.stored, { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("fetch " + r.status); return r.json(); })
      .then(function (raw) {
        var e = checkEnvelope(raw);
        if (e.salt !== indexEnv.salt) throw new Error("salt mismatch");
        return decryptBytes(liveKey, e);
      })
      .then(function (pt) {
        var name = entry.name || "document";
        var ext = (name.split(".").pop() || "").toLowerCase();
        var blob = new Blob([pt], { type: MIME[ext] || "application/octet-stream" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        if (VIEWABLE[ext]) { a.target = "_blank"; a.rel = "noopener"; }
        else { a.download = name; }
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        done();
      })
      .catch(function () {
        titleEl.textContent = "Could not open — try again";
        setTimeout(done, 2500);
      });
  }

  /* ---- boot ---- */
  if (!subtle) {
    root.innerHTML = '<p class="docs-note">This browser cannot unlock job documents (it needs HTTPS and WebCrypto).</p>';
    return;
  }
  root.innerHTML = '<p class="docs-empty">Loading documents…</p>';
  fetch(INDEX_URL + "?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("index " + r.status); return r.json(); })
    .then(function (raw) {
      indexEnv = checkEnvelope(raw);
      var k = savedKey(indexEnv);
      var attempt = k ? k.then(function (key) {
        return decryptBytes(key, indexEnv).then(function (pt) {
          liveKey = key;
          renderUnlocked(JSON.parse(textDec.decode(pt)));
          return true;
        });
      }) : Promise.reject(new Error("no saved key"));
      return attempt.catch(function () {
        forgetKey();
        showLock("");
      });
    })
    .catch(function () { renderSetup(); });
})();
