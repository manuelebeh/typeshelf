/*
 * Typeshelf for InDesign (CEP). The ExtendScript side (host.jsx) lists the fonts of the
 * active document; this page asks Typeshelf, running on this computer, to activate them.
 */
(function () {
  "use strict";
  var cep = window.TypeshelfCep;
  cep.applySkin();

  var host = {
    name: "InDesign",
    call: cep.client("InDesign"),
    documentFonts: function () {
      return cep.evalScript("typeshelfDocumentFonts()").then(cep.parseFonts);
    },
    // InDesign's CEP events are not reliable across versions: the panel watches the active document.
    onDocumentChange: function (cb) {
      var last = null;
      setInterval(function () {
        cep.evalScript("typeshelfDocumentKey()").then(
          function (key) {
            if (last !== null && key !== last) cb();
            last = key;
          },
          function () {
            /* InDesign busy: next tick */
          },
        );
      }, 2000);
    },
  };

  window.TypeshelfPanel(host, document.getElementById("app"));
})();
