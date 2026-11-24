/*
 * Typeshelf panel shared by the Photoshop (UXP) and Illustrator (CEP) plugins.
 * Source of truth: plugins/shared/panel-core.js; `npm run plugins:sync` copies it
 * into each plugin folder, which must stay self-contained to be installed.
 *
 * The host adapter provides:
 *   name                      "Photoshop", "Illustrator"…
 *   call(method, path, body)  → Promise<parsed JSON>, rejects with an Error
 *   documentFonts()           → Promise<{ name, fonts: [{ name, installed }] } | null>
 *                               installed: true, false, or null when the host cannot tell
 *                               (Typeshelf then asks the operating system)
 *                               appLists: the app lists the font, but its list may be stale
 *                               (Photoshop keeps deactivated fonts); it then counts as
 *                               missing only if the system lacks it and Typeshelf holds it,
 *                               so fonts private to the app are not reported
 *   onDocumentChange(cb)      calls cb when a document is opened or brought forward
 */
(function (root) {
  "use strict";

  var STATUS_TEXT = {
    installed: "Installée",
    missing: "Manquante",
    activated: "Activée",
    google: "Google Fonts",
    unavailable: "Introuvable",
    error: "Erreur",
    unknown: "À vérifier",
  };

  function create(host, container) {
    var prefs = loadPrefs();
    var state = { connected: null, connectionError: "", doc: null, results: {}, busy: false, message: "" };
    var checking = false;

    function loadPrefs() {
      var p = { auto: true, google: true, scope: "temporary" };
      try {
        var saved = JSON.parse(localStorage.getItem("typeshelf-prefs") || "{}");
        if (typeof saved.auto === "boolean") p.auto = saved.auto;
        if (typeof saved.google === "boolean") p.google = saved.google;
        if (saved.scope === "persistent") p.scope = "persistent";
      } catch (e) {
        /* defaults */
      }
      return p;
    }

    function savePrefs() {
      try {
        localStorage.setItem("typeshelf-prefs", JSON.stringify(prefs));
      } catch (e) {
        /* storage unavailable */
      }
    }

    function esc(value) {
      return String(value).replace(/[&<>"']/g, function (c) {
        return "&#" + c.charCodeAt(0) + ";";
      });
    }

    function missingNames() {
      if (!state.doc) return [];
      return state.doc.fonts
        .filter(function (f) {
          return f.installed === false;
        })
        .map(function (f) {
          return f.name;
        });
    }

    function statusOf(font) {
      var r = state.results[font.name];
      if (typeof font.installed !== "boolean") return "unknown";
      if (font.installed) return r && r.status === "activated" ? (r.source === "google" ? "google" : "activated") : "installed";
      if (!r) return "missing";
      if (r.status === "error") return "error";
      if (r.status === "missing") return "unavailable";
      // Activated by Typeshelf but the app has not refreshed its font list yet.
      return r.source === "google" ? "google" : "activated";
    }

    function render() {
      var missing = missingNames();
      var fonts = state.doc ? state.doc.fonts.slice() : [];
      fonts.sort(function (a, b) {
        return Number(a.installed) - Number(b.installed) || a.name.localeCompare(b.name);
      });
      var connection =
        state.connected === null
          ? '<span class="dot"></span>Connexion à Typeshelf…'
          : state.connected
            ? '<span class="dot ok"></span>Typeshelf connecté'
            : '<span class="dot off"></span>Typeshelf n\'est pas ouvert';
      var list = !state.doc
        ? '<p class="muted">Aucun document ouvert.</p>'
        : !fonts.length
          ? '<p class="muted">Ce document n\'utilise aucune police.</p>'
          : '<ul class="fonts">' +
            fonts
              .map(function (f) {
                var s = statusOf(f);
                var r = state.results[f.name];
                var title = r && r.message ? ' title="' + esc(r.message) + '"' : "";
                return '<li><span class="name">' + esc(f.name) + '</span><span class="chip ' + s + '"' + title + ">" + STATUS_TEXT[s] + "</span></li>";
              })
              .join("") +
            "</ul>";
      var activateOff = state.busy || !missing.length || !state.connected;
      // Plain <div> rows: UXP does not lay out a checkbox inside a flex <label>.
      var option = function (id, on, text) {
        return '<div class="opt"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + " /><span>" + text + "</span></div>";
      };
      container.innerHTML =
        '<div class="connection">' + connection + "</div>" +
        (state.connected === false && state.connectionError ? '<p class="detail">' + esc(state.connectionError) + "</p>" : "") +
        (state.doc ? '<div class="doc"><span class="muted">Document</span> ' + esc(state.doc.name) + "</div>" : "") +
        list +
        (state.message ? '<p class="message">' + esc(state.message) + "</p>" : "") +
        '<div class="actions">' +
        '<button id="ts-activate" class="primary' + (activateOff ? ' is-disabled" disabled' : '"') + ">" +
        (state.busy ? "Activation…" : missing.length ? "Activer " + missing.length + " police" + (missing.length > 1 ? "s" : "") : "Rien à activer") +
        "</button>" +
        '<button id="ts-check"' + (state.busy ? ' class="is-disabled" disabled' : "") + ">Revérifier</button>" +
        "</div>" +
        '<div class="options">' +
        option("ts-auto", prefs.auto, "Activer automatiquement à l'ouverture") +
        option("ts-google", prefs.google, "Chercher les absentes sur Google Fonts") +
        '<div class="opt"><span>Durée</span><select id="ts-scope">' +
        '<option value="temporary"' + (prefs.scope === "temporary" ? " selected" : "") + ">Jusqu'à la fermeture de Typeshelf</option>" +
        '<option value="persistent"' + (prefs.scope === "persistent" ? " selected" : "") + ">Durablement</option>" +
        "</select></div>" +
        "</div>";
    }

    function ping() {
      return host.call("GET", "/v1/status").then(
        function () {
          state.connected = true;
          state.connectionError = "";
        },
        function (e) {
          state.connected = false;
          state.connectionError = e && e.message ? e.message : String(e);
        },
      );
    }

    function check(auto) {
      if (checking) return Promise.resolve();
      checking = true;
      return Promise.all([
        host.documentFonts().then(
          function (doc) {
            if (!state.doc || !doc || state.doc.name !== doc.name) state.results = {};
            state.doc = doc;
          },
          function (e) {
            state.doc = null;
            state.message = "Lecture du document impossible : " + e.message;
          },
        ),
        ping(),
      ])
        .then(resolveUnknown)
        .then(function () {
        checking = false;
        render();
        if (auto && prefs.auto && state.connected && missingNames().some(function (n) {
          return !state.results[n];
        })) {
          return activate();
        }
      });
    }

    /** Fonts the host cannot judge are checked by Typeshelf against the operating system. */
    function resolveUnknown() {
      var unknown = state.doc
        ? state.doc.fonts.filter(function (f) {
            return typeof f.installed !== "boolean";
          })
        : [];
      if (!unknown.length || !state.connected) return;
      return host
        .call("POST", "/v1/fonts/status", {
          fonts: unknown.map(function (f) {
            return f.name;
          }),
        })
        .then(
          function (res) {
            var byName = {};
            (res.results || []).forEach(function (r) {
              byName[r.name] = r;
            });
            unknown.forEach(function (f) {
              var r = byName[f.name];
              if (r) f.installed = !!r.available || (!!f.appLists && !r.inLibrary);
            });
          },
          function () {
            /* stays "À vérifier" */
          },
        );
    }

    function activate() {
      var names = missingNames();
      if (!names.length || state.busy) return Promise.resolve();
      state.busy = true;
      state.message = "";
      render();
      return host
        .call("POST", "/v1/fonts/activate", { fonts: names, scope: prefs.scope, google: prefs.google })
        .then(
          function (res) {
            (res.results || []).forEach(function (r) {
              state.results[r.name] = r;
            });
            var done = (res.results || []).filter(function (r) {
              return r.status === "activated" || r.status === "active" || r.status === "system";
            }).length;
            var left = names.length - done;
            state.message = done
              ? done + " police" + (done > 1 ? "s" : "") + " activée" + (done > 1 ? "s" : "") + (left ? ", " + left + " introuvable" + (left > 1 ? "s" : "") : "") + "."
              : "Aucune de ces polices n'est dans Typeshelf" + (prefs.google ? " ni sur Google Fonts" : "") + ".";
          },
          function (e) {
            state.connected = false;
            state.message = e.message;
          },
        )
        .then(function () {
          state.busy = false;
          render();
          // Give the application a moment to notice the new fonts, then refresh the list.
          setTimeout(function () {
            check(false);
          }, 1500);
        });
    }

    container.addEventListener("click", function (e) {
      var id = e.target && e.target.id;
      if (id === "ts-activate") activate();
      else if (id === "ts-check") check(false);
    });
    container.addEventListener("change", function (e) {
      var t = e.target;
      if (t.id === "ts-auto") prefs.auto = !!t.checked;
      else if (t.id === "ts-google") prefs.google = !!t.checked;
      else if (t.id === "ts-scope") prefs.scope = t.value === "persistent" ? "persistent" : "temporary";
      else return;
      savePrefs();
    });

    var pending = null;
    host.onDocumentChange(function () {
      // Hosts fire several events in a row when a document opens.
      clearTimeout(pending);
      pending = setTimeout(function () {
        check(true);
      }, 400);
    });

    render();
    check(true);
    return { check: check, activate: activate };
  }

  // UXP loads this file with require(); CEP with a <script> tag. With Node.js enabled, CEP
  // pages also see a global `module`, so the window export must not depend on its absence.
  if (typeof module !== "undefined" && module.exports) module.exports = create;
  if (root) root.TypeshelfPanel = create;
})(typeof window !== "undefined" ? window : this);
