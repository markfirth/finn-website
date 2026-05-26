const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const chatHandler = require("./api/chat");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DASHBOARD_FILE = "f-finn-ai-os-dashboard.html";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function sendDashboard(res) {
  res.sendFile(path.join(__dirname, DASHBOARD_FILE));
}

app.get("/", (_req, res) => {
  sendDashboard(res);
});

app.get("/hq", (_req, res) => {
  sendDashboard(res);
});

app.get("/hq/", (_req, res) => {
  sendDashboard(res);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/chat", chatHandler);

app.listen(PORT, () => {
  const anthropicStatus = process.env.ANTHROPIC_API_KEY
    ? "configured"
    : "missing";
  const supabaseStatus =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? "configured"
      : "missing";

  console.log(
    `F. FINN AI server listening on http://localhost:${PORT} (ANTHROPIC_API_KEY: ${anthropicStatus}, SUPABASE: ${supabaseStatus})`
  );
});
