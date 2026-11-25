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

/*
 * The selected text: the range highlighted with the Type tool, or the whole content of each
 * text object selected with the Selection tool. Empty ranges are left out.
 */
function typeshelfSelectedRanges() {
  var selected = app.activeDocument.selection;
  var ranges = [];
  if (!selected) return ranges;
  // A highlighted range is not an array, although it has a length.
  if (selected.typename === "TextRange") {
    if (selected.length > 0) ranges.push(selected);
    return ranges;
  }
  for (var i = 0; i < selected.length; i++) {
    if (selected[i].typename === "TextFrame" && selected[i].characters.length > 0) ranges.push(selected[i].textRange);
  }
  return ranges;
}

/* "#rrggbb" from a fill colour, converted roughly from CMYK and grey; "" for the others. */
function typeshelfHex(color) {
  var rgb;
  if (color.typename === "RGBColor") rgb = [color.red, color.green, color.blue];
  else if (color.typename === "CMYKColor") {
    var k = 1 - color.black / 100;
    rgb = [255 * (1 - color.cyan / 100) * k, 255 * (1 - color.magenta / 100) * k, 255 * (1 - color.yellow / 100) * k];
  } else if (color.typename === "GrayColor") {
    var level = 255 * (1 - color.gray / 100);
    rgb = [level, level, level];
  } else return "";
  var out = "#";
  for (var i = 0; i < 3; i++) out += (256 + Math.max(0, Math.min(255, Math.round(rgb[i])))).toString(16).slice(1);
  return out;
}

/* "key<TAB>value" lines, values percent-encoded: the text may hold tabs and line breaks. */
function typeshelfSelection() {
  if (app.documents.length === 0) return "error\tno_document";
  var ranges = typeshelfSelectedRanges();
  if (!ranges.length) return "error\tno_selection";
  var lines = ["text\t" + encodeURIComponent(ranges[0].contents), "count\t" + ranges.length];
  function add(key, read) {
    // Reading the style of a missing font raises an error: that value is simply left out.
    try {
      var value = read(ranges[0].characters[0].characterAttributes);
      if (value !== "") lines.push(key + "\t" + encodeURIComponent(value));
    } catch (e) {
      /* unknown */
    }
  }
  add("font", function (a) {
    return a.textFont.name;
  });
  add("size", function (a) {
    return a.size;
  });
  add("tracking", function (a) {
    return a.tracking;
  });
  add("color", function (a) {
    return typeshelfHex(a.fillColor);
  });
  return lines.join("\n");
}

/* False when the first letter of the range did not get the font. */
function typeshelfTookFont(range, name) {
  var letter = range.contents.search(/\S/);
  if (letter < 0) return true;
  try {
    return range.characters[letter].characterAttributes.textFont.name === name;
  } catch (e) {
    return false;
  }
}

/* Applies a font, by PostScript name, to the selected text. */
function typeshelfApplyFont(name) {
  if (app.documents.length === 0) return "error\tno_document";
  var ranges = typeshelfSelectedRanges();
  if (!ranges.length) return "error\tno_selection";
  var font;
  try {
    font = app.textFonts.getByName(name);
  } catch (e) {
    return "retry\t1";
  }
  for (var i = 0; i < ranges.length; i++) ranges[i].characterAttributes.textFont = font;
  app.redraw();
  // A font without these letters is silently left off them, but not off the spaces: undo it all.
  for (var r = 0; r < ranges.length; r++) {
    if (!typeshelfTookFont(ranges[r], name)) {
      app.undo();
      app.redraw();
      return "error\tfont_refused";
    }
  }
  return "count\t" + ranges.length;
}
