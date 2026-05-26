const OpenAI = require("openai");

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({
      error: "OPENAI_API_KEY is missing on the server."
    });
    return;
  }

  let payload = req.body || {};
  if (typeof req.body === "string") {
    try {
      payload = JSON.parse(req.body || "{}");
    } catch {
      res.status(400).json({ error: "Invalid JSON payload." });
      return;
    }
  }
  const { systemPrompt, message, history = [] } = payload;

  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    res.status(400).json({ error: "systemPrompt is required." });
    return;
  }

  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

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

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

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
    writeSse(res, "error", {
      message: error?.message || "Model request failed. Check server logs."
    });
    res.end();
  }
};
