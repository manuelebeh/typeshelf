/*
 * ExtendScript side of the Typeshelf panel for Illustrator.
 * Returns the document name on the first line, then one line per font used:
 * "1<TAB>PostScriptName" when Illustrator renders it, "?<TAB>PostScriptName" otherwise.
 *
 * Illustrator raises an error ('GFKU') when a script reads the font of text whose font is
 * missing, so the list comes mainly from the document's XMP metadata, where Illustrator
 * records every font used (xmpTPg:Fonts → stFnt:fontName) when it saves. Fonts of live text
 * that Illustrator can read are added, which covers text typed since the last save.
 *
 * Whether a font is installed cannot be asked to Illustrator either: when a document uses a
 * missing font, app.textFonts gains a placeholder with that name. Only fonts read from live
 * text are known to be present ("1"); the panel asks Typeshelf about the others ("?").
 */
function typeshelfDocumentFonts() {
  if (app.documents.length === 0) return "";
  var doc = app.activeDocument;
  var seen = {};
  var names = [];

  var rendered = {};

  function add(name) {
    if (name && !seen[name]) {
      seen[name] = true;
      names.push(name);
    }
  }

  var xmp = "";
  try {
    xmp = doc.XMPString;
  } catch (e) {
    /* no metadata */
  }
  var re = /<stFnt:fontName>([^<]+)<\/stFnt:fontName>/g;
  var m;
  while ((m = re.exec(xmp)) !== null) add(m[1]);

  // One font per text frame is enough here: missing fonts are already in the metadata.
  var frames = doc.textFrames;
  for (var i = 0; i < frames.length && i < 2000; i++) {
    try {
      var name = frames[i].textRange.characterAttributes.textFont.name;
      rendered[name] = true;
      add(name);
    } catch (e) {
      /* missing or mixed font: covered by the metadata */
    }
  }

  var lines = [doc.name];
  for (var k = 0; k < names.length; k++) lines.push((rendered[names[k]] ? "1" : "?") + "\t" + names[k]);
  return lines.join("\n");
}
