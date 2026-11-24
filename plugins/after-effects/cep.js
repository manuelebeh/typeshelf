/*
 * Plumbing shared by the CEP plugins (Illustrator, After Effects).
 * Source of truth: plugins/shared/cep.js; `npm run plugins:sync` copies it into each CEP folder.
 *
 * CEP pages are served from file:// without web security, so a plain XMLHttpRequest reaches
 * Typeshelf; Node.js sockets, by contrast, never connect inside CEP 12.
 */
(function (root) {
  "use strict";
  var cep = root.__adobe_cep__;

  /** Follows the panel colour chosen in the application's preferences. */
  function applySkin() {
    try {
      var skin = JSON.parse(cep.getHostEnvironment()).appSkinInfo.panelBackgroundColor.color;
      document.body.style.background = "rgb(" + [skin.red, skin.green, skin.blue].map(Math.round).join(",") + ")";
      if (skin.red > 128) document.body.classList.add("light");
    } catch (e) {
      /* default colours */
    }
  }

  /** Returns the `call(method, path, body)` of the host adapter, tagged with the client name. */
  function client(name) {
    return function call(method, path, body) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, "http://127.0.0.1:47391" + path);
        xhr.timeout = method === "GET" ? 3000 : 120000; // Google Fonts downloads can take a while
        xhr.setRequestHeader("X-Typeshelf-Client", name);
        if (body) xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onload = function () {
          var value = {};
          try {
            value = JSON.parse(xhr.responseText);
          } catch (e) {
            /* empty body */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(value);
          else reject(new Error(value.error || "Erreur " + xhr.status));
        };
        xhr.ontimeout = function () {
          reject(new Error("Typeshelf ne répond pas"));
        };
        xhr.onerror = function () {
          reject(new Error("Typeshelf n'est pas ouvert ou n'accepte pas les plugins."));
        };
        xhr.send(body ? JSON.stringify(body) : null);
      });
    };
  }

  /** Runs ExtendScript in the application; resolves with its result as a string. */
  function evalScript(code) {
    return new Promise(function (resolve, reject) {
      cep.evalScript(code, function (result) {
        if (result === "EvalScript error.") reject(new Error("script de l'application en erreur"));
        else resolve(result);
      });
    });
  }

  /**
   * Reads the answer of the host scripts: the document name on the first line, then one line
   * per font, "1" (installed), "0" (missing) or "?" (unknown), a tab, and the PostScript name.
   */
  function parseFonts(result) {
    if (!result) return null;
    var lines = result.split("\n");
    var name = lines.shift();
    return {
      name: name,
      fonts: lines.filter(Boolean).map(function (line) {
        var flag = line.charAt(0);
        return { installed: flag === "1" ? true : flag === "0" ? false : null, name: line.slice(2) };
      }),
    };
  }

  root.TypeshelfCep = { applySkin: applySkin, client: client, evalScript: evalScript, parseFonts: parseFonts };
})(window);
