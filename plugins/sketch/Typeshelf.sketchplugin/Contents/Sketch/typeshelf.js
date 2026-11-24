/*
 * Typeshelf for Sketch.
 *
 * When a document opens (OpenDocument action), lists the fonts of its text layers and asks
 * Typeshelf, running on this computer, to activate the ones Sketch lacks: from the library, or
 * downloaded from Google Fonts. Plugins ▸ Typeshelf ▸ Activate Missing Fonts does the
 * same on demand.
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

function request(method, path, body, done) {
  var fiber = require("sketch/async").createFiber();
  var req = NSMutableURLRequest.requestWithURL(NSURL.URLWithString(BASE + path));
  req.setHTTPMethod(method);
  req.setTimeoutInterval(method === "GET" ? 3 : 120); // Google Fonts downloads can take a while
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

function onOpenDocument(context) {
  if (!pref("auto")) return;
  var native = context.actionContext && context.actionContext.document;
  if (native) check(sketch.fromNative(native), false);
}

function onActivate() {
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
