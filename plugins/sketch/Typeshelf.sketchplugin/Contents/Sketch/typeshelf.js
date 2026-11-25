/*
 * Typeshelf for Sketch.
 *
 * When a document opens (OpenDocument action), lists the fonts of its text layers and asks
 * Typeshelf, running on this computer, to activate the ones Sketch lacks: from the library, or
 * downloaded from Google Fonts. Plugins ▸ Typeshelf ▸ Activate Missing Fonts does the
 * same on demand.
 *
 * It also takes orders from Typeshelf: applying a font to the selected text layers, and
 * sending their text there (also Plugins ▸ Typeshelf ▸ Preview in Typeshelf). A plugin cannot
 * be called, so a loop started with Sketch asks Typeshelf what it wants every second.
 *
 * Sketch keeps the PostScript name of a missing font in the text, so names are read from each
 * run of text; NSFont then tells whether this Sketch session can use the font. Sketch has no
 * fetch(): requests go through NSURLSession, answered on the main queue, while a fiber keeps
 * the script alive.
 */
var sketch = require("sketch");
var Settings = require("sketch/settings");
var UI = require("sketch/ui");

var BASE = "http://127.0.0.1:47391";
var DEFAULTS = { auto: true, google: true, persistent: false };
var POLL_MS = 1000;
var IDLE_MS = 5000; // while Typeshelf does not answer
var APPLY_RETRY_MS = 750;
var APPLY_RETRIES = 8;

function pref(key) {
  var value = Settings.settingForKey("typeshelf." + key);
  return typeof value === "boolean" ? value : DEFAULTS[key];
}

// English texts are the keys; French is used when the system language is French.
var FR = {
  "Typeshelf is not open or does not accept plugins ({error})": "Typeshelf n'est pas ouvert ou n'accepte pas les plugins ({error})",
  "Error {status}": "Erreur {status}",
  "No document open.": "Aucun document ouvert.",
  "All the fonts of the document are available.": "Toutes les polices du document sont disponibles.",
  "This document uses no fonts.": "Ce document n'utilise aucune police.",
  "Activating {n} font…": "Activation de {n} police…",
  "Activating {n} fonts…": "Activation de {n} polices…",
  "{n} font activated.": "{n} police activée.",
  "{n} fonts activated.": "{n} polices activées.",
  "no font activated.": "aucune police activée.",
  "Not found: {names}": "Introuvable : {names}",
  "Reopen the document to see them.": "Rouvrez le document pour les voir.",
  "Activate automatically when a document opens": "Activer automatiquement à l'ouverture d'un document",
  "Look for missing ones on Google Fonts": "Chercher les absentes sur Google Fonts",
  "Keep them active after Typeshelf quits": "Les garder actives après la fermeture de Typeshelf",
  "Typeshelf must be open to activate fonts.": "Typeshelf doit être ouvert pour activer les polices.",
  "Cancel": "Annuler",
  "Select some text first.": "Sélectionnez d'abord du texte.",
};
var french = /^fr/i.test(String(NSLocale.preferredLanguages().firstObject() || ""));

function t(text, vars) {
  var out = (french && FR[text]) || text;
  Object.keys(vars || {}).forEach(function (key) {
    out = out.split("{" + key + "}").join(String(vars[key]));
  });
  return out;
}

function say(text) {
  UI.message("Typeshelf: " + text);
}

/**
 * PostScript names of the fonts the document uses. When a font is neither installed nor
 * embedded in the file, Sketch draws its text with a system font and only its document data
 * remembers the name it was saved with (fontNames, not part of the documented API). Reading the
 * text runs is the fallback.
 */
function documentFonts(document) {
  var data = document.sketchObject.documentData().immutableModelObject();
  if (data.respondsToSelector(NSSelectorFromString("fontNames"))) {
    var stored = data.fontNames().allObjects();
    var list = [];
    for (var k = 0; k < stored.count(); k++) list.push(String(stored.objectAtIndex(k)));
    return list.sort();
  }
  var names = {};
  sketch.find("Text", document).forEach(function (layer) {
    var text = layer.sketchObject.attributedStringValue();
    var length = Number(text.length());
    if (!length) {
      var ps = layer.sketchObject.fontPostscriptName();
      if (ps) names[String(ps)] = true;
      return;
    }
    for (var i = 0; i < length; ) {
      var range = MOPointer.alloc().init();
      var font = text.attribute_atIndex_effectiveRange(NSFontAttributeName, i, range);
      if (font) names[String(font.fontName())] = true;
      var r = range.value();
      i = Number(r.location) + Math.max(Number(r.length), 1);
    }
  });
  return Object.keys(names).sort();
}

/** Whether this Sketch session can draw the font. */
function usable(name) {
  var font = NSFont.fontWithName_size(name, 12);
  return !!font && String(font.fontName()) === name;
}

function request(method, path, body, done, timeout) {
  var fiber = require("sketch/async").createFiber();
  var req = NSMutableURLRequest.requestWithURL(NSURL.URLWithString(BASE + path));
  req.setHTTPMethod(method);
  req.setTimeoutInterval(timeout || (method === "GET" ? 3 : 120)); // Google Fonts downloads can take a while
  req.setValue_forHTTPHeaderField("Sketch", "X-Typeshelf-Client");
  if (body) {
    req.setValue_forHTTPHeaderField("application/json", "Content-Type");
    req.setHTTPBody(NSString.stringWithString(JSON.stringify(body)).dataUsingEncoding(NSUTF8StringEncoding));
  }
  var session = NSURLSession.sessionWithConfiguration_delegate_delegateQueue(
    NSURLSessionConfiguration.ephemeralSessionConfiguration(),
    null,
    NSOperationQueue.mainQueue(),
  );
  var handler = __mocha__.createBlock_function("v32@?0@8@16@24", function (data, response, error) {
    var value = {};
    var failure = null;
    try {
      if (error) {
        failure = t("Typeshelf is not open or does not accept plugins ({error})", { error: error.localizedDescription() });
      } else {
        try {
          value = JSON.parse(String(NSString.alloc().initWithData_encoding(data, NSUTF8StringEncoding)));
        } catch (e) {
          /* empty body */
        }
        var status = Number(response.statusCode());
        if (status < 200 || status >= 300) failure = value.error || t("Error {status}", { status: status });
      }
      done(failure, value);
    } catch (e) {
      say(String(e));
    } finally {
      session.finishTasksAndInvalidate();
      fiber.cleanup();
    }
  });
  session.dataTaskWithRequest_completionHandler(req, handler).resume();
}

function check(document, manual) {
  if (!document) {
    if (manual) say(t("No document open."));
    return;
  }
  var names = documentFonts(document);
  var missing = names.filter(function (name) {
    return !usable(name);
  });
  if (!missing.length) {
    if (manual) say(names.length ? t("All the fonts of the document are available.") : t("This document uses no fonts."));
    return;
  }
  say(t(missing.length > 1 ? "Activating {n} fonts…" : "Activating {n} font…", { n: missing.length }));
  var body = { fonts: missing, scope: pref("persistent") ? "persistent" : "temporary", google: pref("google") };
  request("POST", "/v1/fonts/activate", body, function (error, res) {
    if (error) {
      say(error);
      return;
    }
    var activated = (res.results || [])
      .filter(function (r) {
        return r.status === "activated" || r.status === "active" || r.status === "system";
      })
      .map(function (r) {
        return r.name;
      });
    var left = missing.filter(function (name) {
      return activated.indexOf(name) < 0;
    });
    var text = activated.length ? t(activated.length > 1 ? "{n} fonts activated." : "{n} font activated.", { n: activated.length }) : t("no font activated.");
    if (left.length) text += " " + t("Not found: {names}", { names: left.join(", ") });
    var ready = activated.filter(usable).length > 0;
    if (ready && !reopen(document, "Typeshelf: " + text)) text += " " + t("Reopen the document to see them.");
    say(text);
  });
}

/**
 * Sketch keeps drawing a font that was missing when the document opened with its stand-in,
 * even once the font is active; reading the file again shows the real one. Closing a document
 * saves it in place, so only a document without unsaved changes is reopened, and at most once
 * a minute (the reopened document is checked again on opening).
 */
function reopen(document, message) {
  var native = document.sketchObject;
  var url = native.fileURL();
  if (!url || native.isDocumentEdited()) return false;
  var path = String(url.path());
  var guard = NSThread.mainThread().threadDictionary();
  var key = "typeshelf.reopened:" + path;
  var last = guard.objectForKey(key);
  if (last && Date.now() - Number(last) < 60000) return false;
  guard.setObject_forKey(String(Date.now()), key);
  native.close();
  sketch.Document.open(path, function () {
    UI.message(message);
  });
  return true;
}

/** The document in front; the first one open when Sketch itself is in the background. */
function frontDocument() {
  var native = NSDocumentController.sharedDocumentController().currentDocument() || NSApp.orderedDocuments().firstObject();
  return native ? sketch.fromNative(native) : null;
}

function documentName(document) {
  return document ? String(document.sketchObject.displayName()) : null;
}

/** The selected text layers, or why there are none. */
function selectedText() {
  var document = frontDocument();
  if (!document) return { error: "no_document" };
  var layers = document.selectedLayers.layers.filter(function (layer) {
    return layer.type === "Text" && layer.text.length > 0;
  });
  return layers.length ? { document: document, layers: layers } : { error: "no_selection" };
}

/** The selected text and the style of its first character. */
function readSelection() {
  var found = selectedText();
  if (found.error) return { ok: false, error: found.error };
  var layer = found.layers[0];
  var style = layer.style;
  var first = layer.sketchObject.attributedStringValue().attribute_atIndex_effectiveRange(NSFontAttributeName, 0, null);
  var color = String(style.textColor || "").slice(0, 7); // "#rrggbbaa"
  return {
    ok: true,
    count: found.layers.length,
    selection: {
      text: String(layer.text),
      font: first ? String(first.fontName()) : null,
      size: style.fontSize || null,
      color: color || null,
      // Sketch spaces letters in points, Typeshelf in thousandths of an em.
      tracking: style.kerning && style.fontSize ? (style.kerning / style.fontSize) * 1000 : 0,
      count: found.layers.length,
    },
  };
}

/** Whether the font has every letter of the text; spaces and emoji do not count. */
function covers(font, text) {
  var characters = font.coveredCharacterSet();
  return Array.from(String(text)).every(function (c) {
    var code = c.codePointAt(0);
    if (/\s/.test(c) || code < 32 || code > 0xffff || code === 0x200d || code === 0xfe0f) return true;
    return !!characters.longCharacterIsMember(code);
  });
}

/**
 * Changes the font of a whole layer, run of text by run: setFontPostscriptName would give all of
 * them the size of the first.
 */
function setFont(native, name) {
  var text = native.attributedStringValue();
  var length = Number(text.length());
  for (var i = 0; i < length; ) {
    var range = MOPointer.alloc().init();
    var old = text.attribute_atIndex_effectiveRange(NSFontAttributeName, i, range);
    var run = range.value();
    var end = Math.max(Number(run.location) + Number(run.length), i + 1);
    native.addAttribute_value_forRange(NSFontAttributeName, NSFont.fontWithName_size(name, old.pointSize()), NSMakeRange(i, end - i));
    i = end;
  }
}

/** Sets the font of whole layers; everything done at once is one undo step. */
function applyFont(name) {
  var found = selectedText();
  if (found.error) return { ok: false, error: found.error };
  if (!usable(name)) return { retry: true };
  var font = NSFont.fontWithName_size(name, 12);
  // Checked first: Sketch would draw the missing letters with another font.
  var refused = found.layers.some(function (layer) {
    return !covers(font, layer.text);
  });
  if (refused) return { ok: false, error: "font_refused" };
  // Names the entry of the Undo menu; Sketch records the history by itself.
  var history = found.document.sketchObject.historyMaker();
  if (history.respondsToSelector(NSSelectorFromString("registerHistoryMomentTitle:"))) history.registerHistoryMomentTitle("Typeshelf");
  found.layers.forEach(function (layer) {
    setFont(layer.sketchObject, name);
    layer.sketchObject.adjustFrameToFit();
  });
  return { ok: true, count: found.layers.length };
}

/** Carries out one command from Typeshelf, reports how it went, then calls `done`. */
function run(command, retries, done) {
  var outcome;
  try {
    outcome = command.kind === "apply" ? applyFont(command.font) : readSelection();
  } catch (e) {
    outcome = { ok: false, error: String(e) };
  }
  if (outcome.retry) {
    // A font activated a moment ago may not be listed yet.
    if (retries > 0) {
      setTimeout(function () {
        run(command, retries - 1, done);
      }, APPLY_RETRY_MS);
      return;
    }
    outcome = { ok: false, error: "font_unavailable" };
  }
  outcome.id = command.id;
  outcome.kind = command.kind;
  try {
    request("POST", "/v1/bridge/result", outcome, function () {}, 3);
  } finally {
    done();
  }
}

/**
 * Commands run one at a time, in order: one waiting for its font must not be overtaken, and then
 * undone, by the next.
 */
function commandQueue() {
  var pending = [];
  var busy = false;
  function next() {
    if (busy || !pending.length) return;
    busy = true;
    run(pending.shift(), APPLY_RETRIES, function () {
      busy = false;
      next();
    });
  }
  return function (command) {
    pending.push(command);
    next();
  };
}

/**
 * Starts the loop that asks Typeshelf for commands, unless one is already running. Each plugin
 * run has its own JavaScript context: the thread dictionary is what they share.
 */
function startBridge() {
  var shared = NSThread.mainThread().threadDictionary();
  var last = shared.objectForKey("typeshelf.polled");
  if (last && Date.now() - Number(last) < 2 * IDLE_MS) return;
  var me = String(Date.now()) + String(Math.random());
  shared.setObject_forKey(me, "typeshelf.loop");
  coscript.setShouldKeepAround(true);
  var enqueue = commandQueue();

  function poll() {
    // A newer loop took over.
    if (String(shared.objectForKey("typeshelf.loop")) !== me) return;
    shared.setObject_forKey(String(Date.now()), "typeshelf.polled");
    var name = null;
    try {
      name = documentName(frontDocument());
    } catch (e) {
      /* closing */
    }
    request(
      "POST",
      "/v1/bridge/poll",
      { document: name, can: ["apply", "selection"] },
      function (error, res) {
        setTimeout(poll, error ? IDLE_MS : POLL_MS);
        if (!error) {
          (res.commands || []).forEach(enqueue);
        }
      },
      3,
    );
  }
  poll();
}

function onStartup() {
  startBridge();
}

function onPreview() {
  startBridge();
  var outcome = readSelection();
  if (!outcome.ok) {
    say(t(outcome.error === "no_document" ? "No document open." : "Select some text first."));
    return;
  }
  request("POST", "/v1/bridge/selection", { selection: outcome.selection }, function (error) {
    if (error) say(error);
  });
}

function onOpenDocument(context) {
  // Sketch only runs the startup action when it launches: a plugin just installed starts here.
  startBridge();
  if (!pref("auto")) return;
  var native = context.actionContext && context.actionContext.document;
  if (native) check(sketch.fromNative(native), false);
}

function onActivate() {
  startBridge();
  check(sketch.getSelectedDocument(), true);
}

function onSettings() {
  var options = [
    ["auto", t("Activate automatically when a document opens")],
    ["google", t("Look for missing ones on Google Fonts")],
    ["persistent", t("Keep them active after Typeshelf quits")],
  ];
  var view = NSView.alloc().initWithFrame(NSMakeRect(0, 0, 380, options.length * 24));
  var boxes = options.map(function (option, index) {
    var box = NSButton.checkboxWithTitle_target_action(option[1], null, null);
    box.setFrame(NSMakeRect(0, (options.length - 1 - index) * 24, 380, 20));
    box.setState(pref(option[0]) ? NSControlStateValueOn : NSControlStateValueOff);
    view.addSubview(box);
    return box;
  });
  var alert = NSAlert.alloc().init();
  alert.setMessageText("Typeshelf");
  alert.setInformativeText(t("Typeshelf must be open to activate fonts."));
  alert.addButtonWithTitle("OK");
  alert.addButtonWithTitle(t("Cancel"));
  alert.setAccessoryView(view);
  if (alert.runModal() !== NSAlertFirstButtonReturn) return;
  options.forEach(function (option, index) {
    Settings.setSettingForKey("typeshelf." + option[0], boxes[index].state() === NSControlStateValueOn);
  });
}
