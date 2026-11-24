/*
 * Typeshelf for After Effects (CEP). The ExtendScript side (host.jsx) lists the fonts of the
 * open project; this page asks Typeshelf, running on this computer, to activate them.
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
