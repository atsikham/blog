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
  const forcedExit = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await forcedExit;
}

test("smoke — home, about and post modal render and stay interactive", { timeout: 30000 }, async () => {
  const { child: server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    let step = "boot";
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    step = "goto";
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForFunction(() => document.documentElement.style.visibility === "visible", { timeout: 10000 });

    step = "home posts";
    await page.waitForSelector("#postsGrid .post-card", { timeout: 10000 });
    const heroText = await page.textContent(".hero h1");
    assert.match(heroText || "", /Build\. Break\. Write it down\./);

    step = "about nav";
    const aboutLink = page.getByRole("link", { name: "About" });
    await aboutLink.click({ timeout: 5000 });
    await page.waitForSelector("#page-about.active .about-name", { timeout: 5000 });
    const aboutName = await page.textContent("#page-about.active .about-name");
    assert.equal(aboutName?.trim(), "Anatoli Tsikhamirau");

    step = "back home";
    await page.getByRole("link", { name: "Blog" }).click({ timeout: 5000 });
    await page.waitForSelector("#page-home.active #postsGrid .post-card", { timeout: 5000 });

    step = "open post";
    await page.locator("#postsGrid .post-card").first().click({ timeout: 5000 });
    await page.waitForSelector("#modalOverlay.open .modal-title", { timeout: 5000 });

    step = "open comments";
    const toggleComments = page.locator("#toggleComments");
    await toggleComments.click({ timeout: 5000 });
    await page.waitForSelector("#commentsSection:not(.comments-hidden)", { timeout: 5000 });

    step = "close modal";
    const closeBtn = page.locator("#modalClose");
    await closeBtn.click({ timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById("modalOverlay")?.classList.contains("open"), { timeout: 5000 });
    assert.deepEqual(pageErrors, [], `page errors at step ${step}: ${pageErrors.join(" | ")}`);
    assert.deepEqual(consoleErrors, [], `console errors at step ${step}: ${consoleErrors.join(" | ")}`);
  } catch (error) {
    error.message = `[smoke step: ${step}] ${error.message}\npageErrors=${JSON.stringify(pageErrors)}\nconsoleErrors=${JSON.stringify(consoleErrors)}`;
    throw error;
  } finally {
    await browser.close();
    await stopServer(server);
  }
});
