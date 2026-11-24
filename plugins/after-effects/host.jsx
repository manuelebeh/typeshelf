/*
 * ExtendScript side of the Typeshelf panel for After Effects.
 *
 * typeshelfDocumentFonts() returns the project name on the first line, then one line per font:
 * "1<TAB>PostScriptName" when After Effects has the font, "0<TAB>…" when it substitutes it.
 * After Effects 24.5 and later list the fonts of a project (project.usedFonts) and flag the
 * ones it lacks (FontObject.isSubstitute). Older versions only give the font name of each text
 * layer ("?"), and Typeshelf asks the operating system.
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
