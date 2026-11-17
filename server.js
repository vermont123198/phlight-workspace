// Phlight Global Inc. AI Workspace - local backend
// Requires Node.js 18+. The OpenRouter key is read from an environment variable.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const VIDEO_MODEL = process.env.OPENROUTER_VIDEO_MODEL || "google/gemini-2.5-flash";
const AUDIT_PROMPT = "You are a quality assurance second reader for ESL lesson audits. You receive the auditor's filled audit sheet and a recording of the lesson. For EACH criterion on the sheet give: the criterion name; the auditor's rating; your suggested rating (Keep, Higher, Lower, or Cannot determine); the evidence from the recording with approximate timestamps (mm:ss); and your confidence (High, Medium, Low). Use only what is visible or audible in the recording. If something is unclear or not observable, say Cannot determine. Never invent quotes or timestamps. Finish with a short summary of which ratings should change and why, and remind the reader that the human auditor makes the final decision. Reply in plain text only, without markdown symbols.";
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const PLAN_PROMPT = "You are a quality assurance second reader. You receive a teacher's lesson plan and a recording of the lesson. Compare what was planned with what actually happened. Report: (1) for each objective, stage or activity in the plan: Done as planned, Done differently, Not seen, or Cannot determine, with the evidence and approximate timestamps (mm:ss) and your confidence (High, Medium, Low); (2) timing, planned versus actual per stage, when the plan gives times; (3) anything significant in the recording that was not in the plan; (4) a short summary of how closely the lesson followed the plan, with 2-3 strengths and 2-3 suggestions, in a warm and professional tone. Use only what is visible or audible in the recording. Never invent quotes or timestamps, and say Cannot determine when something is unclear. Remind the reader that a human reviewer should verify the findings. Reply in plain text only, without markdown symbols.";
const VIDEO_ROUTES = {
  "/api/audit": { field: "sheet", label: "AUDIT SHEET (filled by the auditor)", prompt: AUDIT_PROMPT },
  "/api/plancheck": { field: "plan", label: "LESSON PLAN", prompt: PLAN_PROMPT }
};
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

  if (req.method === "POST" && VIDEO_ROUTES[url.pathname]) {
    const cfg = VIDEO_ROUTES[url.pathname];
    if (!GEMINI_KEY && !API_KEY) return sendJson(res, 500, { error: "No AI key is configured on the server." });
    try {
      const body = await readJson(req, 45_000_000);
      const text = String(body[cfg.field] || "").slice(0, 20000);
      const video = String(body.videoUrl || body.videoData || "");
      if (!text.trim() || !video) return sendJson(res, 400, { error: "Please provide the document text and a video." });
      if (!video.startsWith("https://") && !video.startsWith("data:video/")) return sendJson(res, 400, { error: "The video must be an https link or an uploaded video file." });
      const reply = await askVideo(cfg.prompt, cfg.label + ":\n" + text, video);
      return sendJson(res, 200, { reply });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || "Unexpected server error." });
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
          "Reply in plain text only. Do not use markdown symbols such as ** or #. For lists, use simple numbers or hyphens.",
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

async function askVideo(system, text, video) {
  const fail = (msg, status) => Object.assign(new Error(msg), { status });
  if (GEMINI_KEY) {
    const part = video.startsWith("data:")
      ? { inlineData: { mimeType: video.slice(5, video.indexOf(";")), data: video.slice(video.indexOf(",") + 1) } }
      : { fileData: { fileUri: video } };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text }, part] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8000 }
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(d?.error?.message || `Gemini returned HTTP ${r.status}.`, r.status === 401 || r.status === 403 ? 502 : r.status);
    const out = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    if (!out) throw fail("The model returned an empty response.", 502);
    return out;
  }
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Phlight Global Inc. AI Workspace" },
    body: JSON.stringify({
      model: VIDEO_MODEL, temperature: 0.2, max_tokens: 3500,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [{ type: "text", text }, { type: "video_url", video_url: { url: video } }] }
      ]
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(d?.error?.message || `OpenRouter returned HTTP ${r.status}.`, r.status);
  const out = d?.choices?.[0]?.message?.content;
  if (!out) throw fail("The model returned an empty response.", 502);
  return out;
}
function readJson(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > max) {
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
