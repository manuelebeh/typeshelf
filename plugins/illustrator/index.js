/*
 * Typeshelf for Illustrator (CEP). The ExtendScript side (host.jsx) lists the fonts of the
 * active document; this page asks Typeshelf, running on this computer, to activate them.
 * It also applies a font chosen in Typeshelf to the selected text, and sends that text there.
 */
(function () {
  "use strict";
  var cep = window.TypeshelfCep;
  cep.applySkin();

  var host = {
    name: "Illustrator",
    call: cep.client("Illustrator"),
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
    onDocumentChange: function (cb) {
      window.__adobe_cep__.addEventListener("documentAfterActivate", cb);
    },
  };

  window.TypeshelfPanel(host, document.getElementById("app"));
})();
