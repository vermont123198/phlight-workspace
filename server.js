// Phlight Global Inc. AI Workspace - local backend
// Requires Node.js 18+. The OpenRouter key is read from an environment variable.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const ROOT = __dirname;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") return sendText(res, 200, "ok");
  if (process.env.APP_PASSWORD) {
    const expected = "Basic " + Buffer.from("phlight:" + process.env.APP_PASSWORD).toString("base64");
    if ((req.headers.authorization || "") !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Phlight"' });
      return res.end("Login required");
    }
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (!API_KEY) {
      return sendJson(res, 500, { error: "OPENROUTER_API_KEY is not configured on the server." });
    }
    try {
      const body = await readJson(req);
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return sendJson(res, 400, { error: "Please provide at least one message." });
      }
      const messages = body.messages.slice(-16).map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 12000)
      }));
      const kb = Array.isArray(body.context) ? body.context.slice(0, 20) : [];
      let kbText = "";
      if (kb.length) kbText = " Approved company documents supplied by the user follow. Use them to answer company-specific questions and say which document you used; if the answer is not in them, say so.\n\n" + kb.map(d => "### " + String((d && d.title) || "Untitled").slice(0, 120) + "\n" + String((d && d.text) || "").slice(0, 8000)).join("\n\n").slice(0, 24000);
      messages.unshift({
        role: "system",
        content: [
          "You are Phlight Assistant, the internal AI assistant for Phlight Global Inc.",
          "Be professional, clear, practical, and concise.",
          "Help with company operations, quality assurance, teaching support, training, HR guidance, and workplace communication.",
          "Do not invent company policies, records, or facts. If company-specific information is not supplied, say so and ask for the relevant approved document.",
          "Treat employee, student, and company information as confidential. Do not ask users to share passwords, API keys, or unnecessary sensitive personal information."
        ].join(" ") + kbText
      });

      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "Phlight Global Inc. AI Workspace"
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.4,
          max_tokens: 900
        })
      });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const detail = data?.error?.message || `OpenRouter returned HTTP ${upstream.status}.`;
        return sendJson(res, upstream.status, { error: detail });
      }
      const reply = data?.choices?.[0]?.message?.content;
      if (!reply) return sendJson(res, 502, { error: "The selected model returned an empty response." });
      return sendJson(res, 200, { reply });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || "Unexpected server error." });
    }
  }

  // Serve the standalone interface from this folder.
  if (url.pathname !== "/" && url.pathname !== "/index.html") return sendText(res, 404, "Not found");
  const filePath = path.join(ROOT, "index.html");
  fs.readFile(filePath, (err, content) => {
    if (err) return sendText(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    res.end(content);
  });
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("Invalid JSON request.")); }
    });
    req.on("error", reject);
  });
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

server.listen(PORT, () => {
  console.log(`Phlight Global Inc. AI Workspace: http://localhost:${PORT}`);
  console.log(`OpenRouter model: ${MODEL}`);
  if (!API_KEY) console.log("WARNING: Set OPENROUTER_API_KEY before using the AI chat.");
});
