const crypto = require("crypto");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const CHAT_TABLE = process.env.SUPABASE_CHAT_TABLE || "finn_agent_messages";
const MAX_HISTORY_MESSAGES = 50;

const AGENTS = {
  "finn-executive-operator": {
    id: "finn-executive-operator",
    label: "FINN Executive Operator",
    defaultProvider: "openai",
    providerEnv: "FINN_EXECUTIVE_PROVIDER",
    openaiModelEnv: "FINN_EXECUTIVE_OPENAI_MODEL",
    anthropicModelEnv: "FINN_EXECUTIVE_ANTHROPIC_MODEL",
    openaiDefaultModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    anthropicDefaultModel:
      process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
    systemPrompt:
      "You are FINN Executive Operator. Operate as a focused executive command layer for FINN. Prioritize revenue-impacting execution, provider reliability, and booking throughput. Be concise, decisive, and operationally specific. Always convert requests into clear actions, ownership, and immediate next steps."
  }
};

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function parsePayload(req, res) {
  let payload = req.body || {};

  if (typeof req.body === "string") {
    try {
      payload = JSON.parse(req.body || "{}");
    } catch {
      res.status(400).json({ error: "Invalid JSON payload." });
      return null;
    }
  }

  return payload;
}

function resolveAgent(agentId) {
  const fallbackAgent = AGENTS["finn-executive-operator"];
  const agent = AGENTS[agentId] || fallbackAgent;
  const provider =
    (process.env[agent.providerEnv] || agent.defaultProvider || "openai")
      .toLowerCase()
      .trim();

  const model =
    provider === "anthropic"
      ? process.env[agent.anthropicModelEnv] || agent.anthropicDefaultModel
      : process.env[agent.openaiModelEnv] || agent.openaiDefaultModel;

  return {
    ...agent,
    provider,
    model
  };
}

async function fetchHistory(supabase, sessionId, agentId) {
  const { data, error } = await supabase
    .from(CHAT_TABLE)
    .select("role, content")
    .eq("session_id", sessionId)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY_MESSAGES);

  if (error) {
    throw new Error(
      `Failed to read chat history from Supabase (${CHAT_TABLE}): ${error.message}`
    );
  }

  return (data || [])
    .filter(
      (row) =>
        row &&
        typeof row.content === "string" &&
        (row.role === "user" || row.role === "assistant")
    )
    .map((row) => ({ role: row.role, content: row.content.slice(0, 8000) }));
}

async function persistMessage(supabase, { sessionId, agentId, role, content }) {
  const { error } = await supabase.from(CHAT_TABLE).insert({
    session_id: sessionId,
    agent_id: agentId,
    role,
    content
  });

  if (error) {
    throw new Error(
      `Failed to write chat message to Supabase (${CHAT_TABLE}): ${error.message}`
    );
  }
}

async function streamWithOpenAI({ model, systemPrompt, messages, res }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing on the server.");
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  const stream = await openai.chat.completions.create({
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    stream: true
  });

  let fullText = "";

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (delta) {
      fullText += delta;
      writeSse(res, "delta", { text: delta });
    }
  }

  return fullText;
}

async function streamWithAnthropic({ model, systemPrompt, messages, res }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is missing on the server.");
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const stream = anthropic.messages.stream({
    model,
    max_tokens: 1200,
    system: systemPrompt,
    messages
  });

  let fullText = "";

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta &&
      event.delta.type === "text_delta"
    ) {
      const delta = event.delta.text || "";
      if (delta) {
        fullText += delta;
        writeSse(res, "delta", { text: delta });
      }
    }
  }

  await stream.finalMessage();
  return fullText;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const payload = parsePayload(req, res);
  if (!payload) {
    return;
  }

  const agentId =
    typeof payload.agentId === "string" && payload.agentId.trim()
      ? payload.agentId.trim()
      : "finn-executive-operator";
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";
  const sessionId =
    typeof payload.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId.trim().slice(0, 128)
      : crypto.randomUUID();

  if (!message) {
    res.status(400).json({ error: "message is required." });
    return;
  }

  const agent = resolveAgent(agentId);

  if (agent.provider !== "openai" && agent.provider !== "anthropic") {
    res.status(400).json({
      error: `Unsupported provider '${agent.provider}' for agent '${agent.id}'.`
    });
    return;
  }

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  let history;
  try {
    history = await fetchHistory(supabase, sessionId, agent.id);
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const userMessage = { role: "user", content: message.slice(0, 8000) };
  const modelMessages = [...history, userMessage].slice(-MAX_HISTORY_MESSAGES);

  try {
    await persistMessage(supabase, {
      sessionId,
      agentId: agent.id,
      role: "user",
      content: userMessage.content
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  writeSse(res, "session", {
    sessionId,
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model,
    agentLabel: agent.label
  });

  try {
    const assistantText =
      agent.provider === "anthropic"
        ? await streamWithAnthropic({
            model: agent.model,
            systemPrompt: agent.systemPrompt,
            messages: modelMessages,
            res
          })
        : await streamWithOpenAI({
            model: agent.model,
            systemPrompt: agent.systemPrompt,
            messages: modelMessages,
            res
          });

    const safeAssistantText = (assistantText || "").trim() ||
      "I have no output yet. Please rephrase and try again.";

    await persistMessage(supabase, {
      sessionId,
      agentId: agent.id,
      role: "assistant",
      content: safeAssistantText
    });

    writeSse(res, "done", { ok: true, sessionId, agentId: agent.id });
    res.end();
  } catch (error) {
    writeSse(res, "error", {
      message: error?.message || "Model request failed."
    });
    res.end();
  }
};
