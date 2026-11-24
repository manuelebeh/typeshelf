// Regenerates docs/screenshots/*-{light,dark}.png from the demo data of `npm run dev`.
//
//   npm run dev            (in one terminal)
//   npm run screenshots    (in another; needs Google Chrome)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEV_URL = process.env.TYPESHELF_DEV_URL ?? "http://localhost:5173/";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUT, { recursive: true });
const chrome = spawn(
  CHROME,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "typeshelf-shots-"))}`, "--headless=new", "--hide-scrollbars", "about:blank"],
  { stdio: "ignore" },
);

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = pages.find((p) => p.type === "page");
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      /* Chrome is still starting */
    }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const socket = await connect();
await new Promise((resolve) => socket.addEventListener("open", resolve));
let nextId = 0;
const waiting = new Map();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && waiting.has(message.id)) waiting.get(message.id)(message);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
const run = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)})?.click()`);

async function shoot(name, theme) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}-${theme}.png`), Buffer.from(data, "base64"));
  console.log(`${name}-${theme}.png`);
}

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  for (const theme of ["light", "dark"]) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await send("Page.navigate", { url: DEV_URL });
    await sleep(800);
    await run(`localStorage.clear(); localStorage.setItem("theme", "${theme}"); localStorage.setItem("language", "en"); localStorage.setItem("inspector", "false")`);
    await send("Page.navigate", { url: DEV_URL });
    await sleep(1500);

    await shoot("library", theme);

    await click('[data-nav="google"]');
    await sleep(1500);
    await shoot("google-fonts", theme);

    await click("#settings-button");
    await sleep(600);
    await shoot("settings", theme);
    await click("#settings-dialog [data-close], #settings-dialog button.primary");
    await sleep(300);
    await click('[data-nav="all"]');
    await sleep(500);
    await run(`document.querySelector('[data-family]')?.scrollIntoView()`);
    await run(`[...document.querySelectorAll('[data-family]')].find((el) => el.textContent.includes("Skia"))?.click()`);
    await click("#inspector-button");
    await sleep(800);
    await shoot("details", theme);

  }
} finally {
  socket.close();
  chrome.kill();
}
