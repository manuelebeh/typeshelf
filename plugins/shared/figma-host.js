/*
 * Typeshelf for Figma, panel side (inlined into ui.html by plugins/shared/build-figma.mjs).
 * This iframe has no origin ("null"), so it talks to Typeshelf on its own routes, /v1/figma/…,
 * which accept it only with the token Typeshelf wrote into this file when it installed the plugin.
 */
(function () {
  "use strict";
  var TOKEN = "__TYPESHELF_TOKEN__";
  var BASES = ["http://localhost:47391", "http://127.0.0.1:47391"];
  var t = window.TypeshelfPanel.t;
  var base = 0;

  function once(index, method, path, body) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, method === "GET" ? 3000 : 120000); // Google Fonts downloads can take a while
    return fetch(BASES[index] + "/v1/figma" + path.replace(/^\/v1/, ""), {
      method: method,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Typeshelf-Client": "Figma", "X-Typeshelf-Token": TOKEN },
      body: body ? JSON.stringify(body) : undefined,
    }).then(
      function (res) {
        clearTimeout(timer);
        return res.json().then(
          function (data) {
            return { status: res.status, data: data };
          },
          function () {
            return { status: res.status, data: {} };
          },
        );
      },
      function (e) {
        clearTimeout(timer);
        e.network = true;
        throw e;
      },
    );
  }

  function call(method, path, body) {
    var order = [base, 1 - base];
    function attempt(i) {
      return once(order[i], method, path, body).then(
        function (r) {
          base = order[i];
          if (r.status >= 200 && r.status < 300) return r.data;
          if (r.status === 401) throw new Error(t("Typeshelf does not recognise this plugin: install it again from Typeshelf."));
          throw new Error((r.data && r.data.error) || t("Error {status}", { status: r.status }));
        },
        function (e) {
          if (e.network && i + 1 < order.length) return attempt(i + 1);
          throw new Error(t("Typeshelf is not open or does not accept plugins."));
        },
      );
    }
    return attempt(0);
  }

  var waiting = [];
  var listeners = [];
  window.onmessage = function (event) {
    var m = event.data && event.data.pluginMessage;
    if (!m) return;
    if (m.type === "fonts" || m.type === "error") {
      var done = waiting;
      waiting = [];
      done.forEach(function (w) {
        if (m.type === "error") w.reject(new Error(m.message));
        else
          w.resolve({
            name: m.name,
            fonts: m.fonts.map(function (f) {
              return { name: f.name, installed: f.installed };
            }),
          });
      });
    } else if (m.type === "changed") {
      listeners.forEach(function (cb) {
        cb();
      });
    }
  };

  var host = {
    name: "Figma",
    call: call,
    documentFonts: function () {
      return new Promise(function (resolve, reject) {
        waiting.push({ resolve: resolve, reject: reject });
        parent.postMessage({ pluginMessage: { type: "scan" } }, "*");
      });
    },
    onDocumentChange: function (cb) {
      listeners.push(cb);
    },
  };

  window.TypeshelfPanel(host, document.getElementById("app"));
})();
