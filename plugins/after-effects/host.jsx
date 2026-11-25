/*
 * ExtendScript side of the Typeshelf panel for After Effects.
 *
 * typeshelfDocumentFonts() returns the project name on the first line, then one line per font:
 * "1<TAB>PostScriptName" when After Effects has the font, "0<TAB>…" when it substitutes it.
 * After Effects 24.5 and later list the fonts of a project (project.usedFonts) and flag the
 * ones it lacks (FontObject.isSubstitute). Older versions only give the font name of each text
 * layer ("?"), and Typeshelf asks the operating system.
 *
 * typeshelfSelection() and typeshelfApplyFont(psName) work on the text layers selected in the
 * active composition: scripts cannot read which characters are highlighted.
 */
function typeshelfProjectName() {
  var project = app.project;
  if (!project) return "";
  return project.file ? decodeURI(project.file.name) : "Projet sans titre";
}

/** Changes when another project is opened, so the panel can check it. */
function typeshelfProjectKey() {
  var project = app.project;
  if (!project) return "";
  return project.file ? project.file.fsName : "untitled:" + project.numItems;
}

function typeshelfDocumentFonts() {
  var project = app.project;
  if (!project) return "";
  var lines = [typeshelfProjectName()];
  var seen = {};

  function add(flag, name) {
    if (name && !seen[name]) {
      seen[name] = true;
      lines.push(flag + "\t" + name);
    }
  }

  var used = null;
  try {
    used = project.usedFonts;
  } catch (e) {
    /* before After Effects 24.5 */
  }

  if (used) {
    for (var i = 0; i < used.length; i++) {
      var font = used[i].font;
      add(font.isSubstitute ? "0" : "1", font.postScriptName);
    }
    return lines.join("\n");
  }

  for (var c = 1; c <= project.numItems; c++) {
    var item = project.item(c);
    if (!(item instanceof CompItem)) continue;
    for (var l = 1; l <= item.numLayers; l++) {
      var layer = item.layer(l);
      if (!(layer instanceof TextLayer)) continue;
      try {
        add("?", layer.property("ADBE Text Properties").property("ADBE Text Document").value.font);
      } catch (e) {
        /* unreadable text layer */
      }
    }
  }
  return lines.join("\n");
}

/* The active composition and its selected text layers, or why there are none. */
function typeshelfSelectedText() {
  var project = app.project;
  if (!project || !project.numItems) return { error: "no_document" };
  var comp = project.activeItem;
  var layers = [];
  if (comp instanceof CompItem) {
    var selected = comp.selectedLayers;
    for (var i = 0; i < selected.length; i++) {
      if (selected[i] instanceof TextLayer && typeshelfSourceText(selected[i]).value.text.length > 0) layers.push(selected[i]);
    }
  }
  return layers.length ? { layers: layers } : { error: "no_selection" };
}

function typeshelfSourceText(layer) {
  return layer.property("ADBE Text Properties").property("ADBE Text Document");
}

/* "#rrggbb" from [r, g, b] between 0 and 1. */
function typeshelfHex(color) {
  var out = "#";
  for (var i = 0; i < 3; i++) out += (256 + Math.max(0, Math.min(255, Math.round(color[i] * 255)))).toString(16).slice(1);
  return out;
}

/* "key<TAB>value" lines, values percent-encoded: the text may hold tabs and line breaks. */
function typeshelfSelection() {
  var found = typeshelfSelectedText();
  if (found.error) return "error\t" + found.error;
  var doc = typeshelfSourceText(found.layers[0]).value;
  var lines = ["text\t" + encodeURIComponent(doc.text), "count\t" + found.layers.length];
  function add(key, read) {
    // Some values cannot be read (the fill colour of a stroked-only text): they are left out.
    try {
      lines.push(key + "\t" + encodeURIComponent(read()));
    } catch (e) {
      /* unknown */
    }
  }
  add("font", function () {
    return doc.font;
  });
  add("size", function () {
    return doc.fontSize;
  });
  add("tracking", function () {
    return doc.tracking;
  });
  if (doc.applyFill) {
    add("color", function () {
      return typeshelfHex(doc.fillColor);
    });
  }
  return lines.join("\n");
}

/* The installed font of that PostScript name, or null when After Effects does not list it yet. */
function typeshelfFont(name) {
  var matches = app.fonts.getFontsByPostScriptName(name);
  // The first one is the font that setting TextDocument.font picks.
  return matches.length && !matches[0].isSubstitute ? matches[0] : null;
}

/* Each text a layer holds: one, or one per Source Text keyframe. */
function typeshelfTexts(prop) {
  if (!prop.numKeys) return [{ key: 0, doc: prop.value }];
  var texts = [];
  for (var k = 1; k <= prop.numKeys; k++) texts.push({ key: k, doc: prop.keyValue(k) });
  return texts;
}

/* False when the font lacks one of the characters (After Effects 25.1 and later can tell). */
function typeshelfCovers(font, layers) {
  if (!font.hasGlyphsFor) return true;
  for (var i = 0; i < layers.length; i++) {
    var prop = typeshelfSourceText(layers[i]);
    // With an expression, what it returns is what shows.
    var texts = prop.expressionEnabled ? [{ doc: prop.value }] : typeshelfTexts(prop);
    for (var k = 0; k < texts.length; k++) {
      // Spaces, line breaks and emoji (never in a text font) do not count.
      var chars = texts[k].doc.text.replace(/[\s\u0000-\u001f\ud800-\udfff\ufe0f\u200d]/g, "");
      if (chars && !font.hasGlyphsFor(chars)) return false;
    }
  }
  return true;
}

/*
 * Sets the font; false when After Effects did not take it. Counts the changes in progress.writes.
 * While an expression is enabled, `value` is what it returns: writing that back would replace the
 * layer's own text, so the expression is off for the time of the change.
 */
function typeshelfSetFont(prop, name, progress) {
  if (!prop.expressionEnabled) return typeshelfSetTexts(prop, name, progress);
  var taken;
  prop.expressionEnabled = false;
  progress.writes++;
  try {
    taken = typeshelfSetTexts(prop, name, progress);
  } finally {
    prop.expressionEnabled = true;
  }
  // An expression may set the font itself: the layer then still shows the old one.
  return taken && prop.value.font === name;
}

function typeshelfSetTexts(prop, name, progress) {
  var taken = true;
  var texts = typeshelfTexts(prop);
  for (var i = 0; i < texts.length; i++) {
    var doc = texts[i].doc;
    doc.font = name;
    if (texts[i].key) prop.setValueAtKey(texts[i].key, doc);
    else prop.setValue(doc);
    progress.writes++;
    if ((texts[i].key ? prop.keyValue(texts[i].key) : prop.value).font !== name) taken = false;
  }
  return taken;
}

/* Applies a font, by PostScript name, to the selected text layers, as one undo step. */
function typeshelfApplyFont(name) {
  var found = typeshelfSelectedText();
  if (found.error) return "error\t" + found.error;
  var font = typeshelfFont(name);
  if (!font) return "retry\t1";
  // Checked before touching anything: After Effects would draw the missing letters in another font.
  if (!typeshelfCovers(font, found.layers)) return "error\tfont_refused";
  var taken = true;
  var failure = "";
  var progress = { writes: 0 };
  app.beginUndoGroup("Typeshelf");
  try {
    for (var i = 0; i < found.layers.length; i++) {
      if (!typeshelfSetFont(typeshelfSourceText(found.layers[i]), name, progress)) taken = false;
    }
  } catch (e) {
    failure = String(e.message || e);
  }
  app.endUndoGroup();
  if (taken && !failure) return "count\t" + found.layers.length;
  // Nothing written means nothing to undo: Undo would then revert the user's own last step.
  if (progress.writes) app.executeCommand(16); // Edit > Undo
  return "error\t" + (failure ? encodeURIComponent(failure) : "font_refused");
}
