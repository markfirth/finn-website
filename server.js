const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DASHBOARD_FILE = "f-finn-ai-os-dashboard.html";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, DASHBOARD_FILE));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-16)
    .map((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string"
      ) {
        return null;
      }

      return {
        role: message.role,
        content: message.content.slice(0, 8000)
      };
    })
    .filter(Boolean);
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.post("/api/chat", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({
      error: "OPENAI_API_KEY is missing on the server."
    });
    return;
  }

  const { systemPrompt, message, history = [] } = req.body || {};

  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    res.status(400).json({ error: "systemPrompt is required." });
    return;
  }

  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  const userMessage = message.trim().slice(0, 8000);
  const safeHistory = sanitizeHistory(history);
  const lastHistory = safeHistory[safeHistory.length - 1];

  if (
    !lastHistory ||
    lastHistory.role !== "user" ||
    lastHistory.content !== userMessage
  ) {
    safeHistory.push({ role: "user", content: userMessage });
  }

  const messages = [
    { role: "system", content: systemPrompt.trim() },
    ...safeHistory
  ];

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages,
      stream: true
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        writeSse(res, "delta", { text: delta });
      }
    }

    writeSse(res, "done", { ok: true });
    res.end();
  } catch (error) {
    const messageText =
      error?.message || "Model request failed. Check server logs.";
    writeSse(res, "error", { message: messageText });
    res.end();
  }
});

app.listen(PORT, () => {
  const keyStatus = process.env.OPENAI_API_KEY ? "configured" : "missing";
  console.log(
    `F. FINN AI server listening on http://localhost:${PORT} (OPENAI_API_KEY: ${keyStatus})`
  );
});
