import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.mjs");

async function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, SMOKE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let resolvedPort = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const started = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`smoke server did not start\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)), 5000);
    child.stdout.on("data", () => {
      const match = stdout.match(/SMOKE_SERVER_READY:(\d+)/);
      if (match) {
        resolvedPort = Number(match[1]);
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`smoke server exited early: ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });

  await started;
  return { child, baseUrl: `http://127.0.0.1:${resolvedPort}` };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});
}

test("smoke — home, about and post modal render and stay interactive", { timeout: 30000 }, async () => {
  const { child: server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForFunction(() => document.documentElement.style.visibility === "visible", { timeout: 10000 });

    await page.waitForSelector("#postsGrid .post-card", { timeout: 10000 });
    const heroText = await page.textContent(".hero h1");
    assert.match(heroText || "", /Build\. Break\. Write it down\./);

    const aboutLink = page.getByRole("link", { name: "About" });
    await aboutLink.click({ timeout: 5000 });
    await page.waitForSelector("#page-about.active .about-name", { timeout: 5000 });
    const aboutName = await page.textContent("#page-about.active .about-name");
    assert.equal(aboutName?.trim(), "Anatoli Tsikhamirau");

    // There are two elements that navigate home: the logo and the Blog link.
    // Use the visible Blog nav link so Playwright strict mode stays happy.
    await page.getByRole("link", { name: "Blog" }).click({ timeout: 5000 });
    await page.waitForSelector("#page-home.active #postsGrid .post-card", { timeout: 5000 });
    await page.locator("#postsGrid .post-card").first().click({ timeout: 5000 });
    await page.waitForSelector("#modalOverlay.open .modal-title", { timeout: 5000 });

    const toggleComments = page.getByRole("button", { name: /show \/ hide comments|show comments|hide comments/i });
    await toggleComments.click({ timeout: 5000 });
    await page.waitForSelector("#commentsSection:not(.comments-hidden)", { timeout: 5000 });

    const closeBtn = page.getByRole("button", { name: /close post|close/i }).first();
    await closeBtn.click({ timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById("modalOverlay")?.classList.contains("open"), { timeout: 5000 });

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser.close();
    await stopServer(server);
  }
});
