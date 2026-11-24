/*
 * Typeshelf for Photoshop (UXP). Lists the fonts used by the text layers of the active
 * document and asks Typeshelf, running on this computer, to activate the missing ones.
 */
const { app, action, constants } = require("photoshop");
const createPanel = require("./panel-core.js");

// Photoshop only allows host names declared in the manifest ("http://localhost"), not IPs.
const BASE = "http://localhost:47391";

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(createPanel.t("Typeshelf is not responding"))), ms)),
  ]);
}

async function call(method, path, body) {
  let res;
  try {
    res = await withTimeout(
      fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json", "X-Typeshelf-Client": "Photoshop" },
        body: body ? JSON.stringify(body) : undefined,
      }),
      // Downloads from Google Fonts can take a while.
      method === "GET" ? 3000 : 120000,
    );
  } catch (e) {
    throw new Error(`${createPanel.t("Typeshelf is not open or does not accept plugins.")} (${e && e.message ? e.message : e})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || createPanel.t("Error {status}", { status: res.status }));
  return data;
}

function textLayers(layers, out = []) {
  for (const layer of layers) {
    if (layer.layers && layer.layers.length) textLayers(layer.layers, out);
    if (layer.kind === constants.LayerKind.TEXT) out.push(layer);
  }
  return out;
}

/** PostScript names of every font run in the document's text layers. */
async function usedFonts(doc) {
  const layers = textLayers(doc.layers);
  if (!layers.length) return [];
  const descriptors = await action.batchPlay(
    layers.map((layer) => ({
      _obj: "get",
      _target: [{ _property: "textKey" }, { _ref: "layer", _id: layer.id }, { _ref: "document", _id: doc.id }],
    })),
    {},
  );
  const names = new Set();
  for (const d of descriptors) {
    const ranges = (d && d.textKey && d.textKey.textStyleRange) || [];
    for (const r of ranges) {
      const name = r.textStyle && r.textStyle.fontPostScriptName;
      if (name) names.add(name);
    }
  }
  return [...names];
}

function installedFonts() {
  const names = new Set();
  const fonts = app.fonts;
  for (let i = 0; i < fonts.length; i++) names.add(fonts[i].postScriptName);
  return names;
}

const host = {
  name: "Photoshop",
  call,
  async documentFonts() {
    const doc = app.activeDocument;
    if (!doc) return null;
    const used = await usedFonts(doc);
    const installed = installedFonts();
    // Photoshop keeps deactivated fonts in app.fonts: a listed font may still be missing.
    return {
      name: doc.title,
      fonts: used.map((name) => (installed.has(name) ? { name, installed: null, appLists: true } : { name, installed: false })),
    };
  },
  onDocumentChange(cb) {
    action.addNotificationListener(["open", "select"], (event, descriptor) => {
      // "select" also fires for layers and tools: only react to documents.
      const target = descriptor && descriptor._target && descriptor._target[0];
      if (event === "open" || (target && target._ref === "document")) cb();
    });
  },
};

createPanel(host, document.getElementById("app"));
