/*
 * Typeshelf panel shared by every Typeshelf plugin (Photoshop, Illustrator, After Effects, InDesign, Figma).
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

  // English texts are the keys; French is used when the system language is French.
  var FR = {
    "Installed": "Installée",
    "Missing": "Manquante",
    "Activated": "Activée",
    "Not found": "Introuvable",
    "Error": "Erreur",
    "To check": "À vérifier",
    "Connecting to Typeshelf…": "Connexion à Typeshelf…",
    "Typeshelf connected": "Typeshelf connecté",
    "Typeshelf is not open": "Typeshelf n'est pas ouvert",
    "No document open.": "Aucun document ouvert.",
    "This document uses no fonts.": "Ce document n'utilise aucune police.",
    "Document": "Document",
    "Activating…": "Activation…",
    "Activate {n} font": "Activer {n} police",
    "Activate {n} fonts": "Activer {n} polices",
    "Nothing to activate": "Rien à activer",
    "Check again": "Revérifier",
    "Activate automatically on open": "Activer automatiquement à l'ouverture",
    "Look for missing ones on Google Fonts": "Chercher les absentes sur Google Fonts",
    "Duration": "Durée",
    "Until Typeshelf quits": "Jusqu'à la fermeture de Typeshelf",
    "Permanently": "Durablement",
    "Could not read the document: {error}": "Lecture du document impossible : {error}",
    "{n} font activated": "{n} police activée",
    "{n} fonts activated": "{n} polices activées",
    "{n} not found": "{n} introuvable",
    "{n} not found (several)": "{n} introuvables",
    "None of these fonts is in Typeshelf": "Aucune de ces polices n'est dans Typeshelf",
    "None of these fonts is in Typeshelf or on Google Fonts": "Aucune de ces polices n'est dans Typeshelf ni sur Google Fonts",
    "Typeshelf is not responding": "Typeshelf ne répond pas",
    "Typeshelf is not open or does not accept plugins.": "Typeshelf n'est pas ouvert ou n'accepte pas les plugins.",
    "Error {status}": "Erreur {status}",
    "Typeshelf does not recognise this plugin: install it again from Typeshelf.": "Typeshelf ne reconnaît pas ce plugin : réinstallez-le depuis Typeshelf.",
    "the application script failed": "script de l'application en erreur",
  };
  var french = /^fr\b/i.test((typeof navigator !== "undefined" && navigator.language) || "");

  function t(text, vars) {
    var out = (french && FR[text]) || text.replace(/ \(several\)$/, "");
    for (var k in vars || {}) out = out.split("{" + k + "}").join(String(vars[k]));
    return out;
  }

  var STATUS_TEXT = {
    installed: "Installed",
    missing: "Missing",
    activated: "Activated",
    google: "Google Fonts",
    unavailable: "Not found",
    error: "Error",
    unknown: "To check",
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
          ? '<span class="dot"></span>' + t("Connecting to Typeshelf…")
          : state.connected
            ? '<span class="dot ok"></span>' + t("Typeshelf connected")
            : '<span class="dot off"></span>' + t("Typeshelf is not open");
      var list = !state.doc
        ? '<p class="muted">' + t("No document open.") + "</p>"
        : !fonts.length
          ? '<p class="muted">' + t("This document uses no fonts.") + "</p>"
          : '<ul class="fonts">' +
            fonts
              .map(function (f) {
                var s = statusOf(f);
                var r = state.results[f.name];
                var title = r && r.message ? ' title="' + esc(r.message) + '"' : "";
                return '<li><span class="name">' + esc(f.name) + '</span><span class="chip ' + s + '"' + title + ">" + t(STATUS_TEXT[s]) + "</span></li>";
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
        (state.doc ? '<div class="doc"><span class="muted">' + t("Document") + "</span> " + esc(state.doc.name) + "</div>" : "") +
        list +
        (state.message ? '<p class="message">' + esc(state.message) + "</p>" : "") +
        '<div class="actions">' +
        '<button id="ts-activate" class="primary' + (activateOff ? ' is-disabled" disabled' : '"') + ">" +
        (state.busy ? t("Activating…") : missing.length ? t(missing.length > 1 ? "Activate {n} fonts" : "Activate {n} font", { n: missing.length }) : t("Nothing to activate")) +
        "</button>" +
        '<button id="ts-check"' + (state.busy ? ' class="is-disabled" disabled' : "") + ">" + t("Check again") + "</button>" +
        "</div>" +
        '<div class="options">' +
        option("ts-auto", prefs.auto, t("Activate automatically on open")) +
        option("ts-google", prefs.google, t("Look for missing ones on Google Fonts")) +
        '<div class="opt"><span>' + t("Duration") + '</span><select id="ts-scope">' +
        '<option value="temporary"' + (prefs.scope === "temporary" ? " selected" : "") + ">" + t("Until Typeshelf quits") + "</option>" +
        '<option value="persistent"' + (prefs.scope === "persistent" ? " selected" : "") + ">" + t("Permanently") + "</option>" +
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
            state.message = t("Could not read the document: {error}", { error: e.message });
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
            /* stays "To check" */
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
              ? t(done > 1 ? "{n} fonts activated" : "{n} font activated", { n: done }) +
                (left ? ", " + t(left > 1 ? "{n} not found (several)" : "{n} not found", { n: left }) : "") +
                "."
              : t(prefs.google ? "None of these fonts is in Typeshelf or on Google Fonts" : "None of these fonts is in Typeshelf") + ".";
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
  create.t = t;
  if (typeof module !== "undefined" && module.exports) module.exports = create;
  if (root) root.TypeshelfPanel = create;
})(typeof window !== "undefined" ? window : this);
