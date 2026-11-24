/*
 * Typeshelf for Illustrator (CEP). The ExtendScript side (host.jsx) lists the fonts of the
 * active document; this page asks Typeshelf, running on this computer, to activate them.
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
    onDocumentChange: function (cb) {
      window.__adobe_cep__.addEventListener("documentAfterActivate", cb);
    },
  };

  window.TypeshelfPanel(host, document.getElementById("app"));
})();
