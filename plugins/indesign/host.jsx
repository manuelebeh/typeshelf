/*
 * ExtendScript side of the Typeshelf panel for InDesign.
 *
 * typeshelfDocumentFonts() returns the document name on the first line, then one line per font:
 * "1<TAB>PostScriptName" when InDesign has the font, "0<TAB>…" when it is missing or substituted,
 * "?<TAB>…" for anything else (Typeshelf then asks the operating system).
 *
 * InDesign lists every font of a document in Document.fonts, including the missing ones, with a
 * status (FontStatus): that is exactly what a panel needs, whatever the document was last saved with.
 */
function typeshelfDocumentFonts() {
  if (app.documents.length === 0) return "";
  var doc = app.activeDocument;
  var lines = [doc.name];
  var seen = {};
  var fonts = doc.fonts;
  for (var i = 0; i < fonts.length && i < 1000; i++) {
    try {
      var font = fonts[i];
      var name = font.postscriptName;
      if (!name || seen[name]) continue;
      seen[name] = true;
      var status = font.status;
      var flag = "?";
      if (status === FontStatus.INSTALLED) flag = "1";
      else if (status === FontStatus.NOT_AVAILABLE || status === FontStatus.SUBSTITUTED) flag = "0";
      lines.push(flag + "\t" + name);
    } catch (e) {
      /* unreadable font: skipped */
    }
  }
  return lines.join("\n");
}

/** Changes when another document is opened or brought forward, so the panel can check it. */
function typeshelfDocumentKey() {
  if (app.documents.length === 0) return "";
  var doc = app.activeDocument;
  return doc.id + "|" + doc.name;
}
