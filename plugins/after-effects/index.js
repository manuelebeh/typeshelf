/*
 * Typeshelf for After Effects (CEP). The ExtendScript side (host.jsx) lists the fonts of the
 * open project; this page asks Typeshelf, running on this computer, to activate them.
 * It also applies a font chosen in Typeshelf to the selected text layers, and sends their text there.
 */
(function () {
  "use strict";
  var cep = window.TypeshelfCep;
  cep.applySkin();

  var host = {
    name: "After Effects",
    call: cep.client("After Effects"),
    documentFonts: function () {
      return cep.evalScript("typeshelfDocumentFonts()").then(cep.parseFonts);
    },
    selection: function () {
      return cep.evalScript("typeshelfSelection()").then(function (result) {
        var v = cep.parsePairs(result);
        if (v.error) return { error: v.error };
        return {
          text: v.text,
          font: v.font || null,
          size: v.size ? Number(v.size) : null,
          color: v.color || null,
          tracking: v.tracking ? Number(v.tracking) : null,
          count: Number(v.count),
        };
      });
    },
    applyFont: function (name) {
      return cep.evalScript("typeshelfApplyFont(" + JSON.stringify(name) + ")").then(function (result) {
        var v = cep.parsePairs(result);
        if (v.error) return { error: v.error };
        return v.retry ? { retry: true } : { count: Number(v.count) };
      });
    },
    // After Effects sends CEP no event when a project opens: the panel watches the project file.
    onDocumentChange: function (cb) {
      var last = null;
      setInterval(function () {
        cep.evalScript("typeshelfProjectKey()").then(
          function (key) {
            if (last !== null && key !== last) cb();
            last = key;
          },
          function () {
            /* After Effects busy: next tick */
          },
        );
      }, 2000);
    },
  };

  window.TypeshelfPanel(host, document.getElementById("app"));
})();
