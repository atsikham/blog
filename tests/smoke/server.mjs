import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const port = Number(process.env.SMOKE_PORT || 0);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".adoc": "text/plain; charset=utf-8",
  ".asciidoc": "text/plain; charset=utf-8",
};

function safeJoin(base, reqPath) {
  const rel = decodeURIComponent(reqPath.split("?")[0]);
  const cleaned = rel === "/" ? "/index.html" : rel;
  const full = path.resolve(base, `.${cleaned}`);
  if (!full.startsWith(base)) throw new Error("path traversal");
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    const filePath = safeJoin(root, req.url || "/");
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");

    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": mime[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(port, () => {
  const actualPort = server.address()?.port;
  process.stdout.write(`SMOKE_SERVER_READY:${actualPort}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

