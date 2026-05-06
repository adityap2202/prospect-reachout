// Load .env for local dev (Node does not do this automatically)
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const pinoHttp = require("pino-http");

const { openDb, migrate, getPaths } = require("./db");
const { upsertEpisode, listEpisodes, getEpisode, updateEpisode, deleteEpisode } = require("./episodesRepo");
const { subscribe, publish, closeAll } = require("./sseHub");
const { runPipeline, stage2Message } = require("./pipeline");
const { v4: uuidv4 } = require("uuid");
const { logger } = require("./logger");
const { addPipelineEvent, listPipelineEvents } = require("./pipelineEvents");

const app = express();
app.use(
  pinoHttp({
    logger,
    genReqId: (req) =>
      req.headers["x-request-id"] || req.headers["x-correlation-id"] || uuidv4(),
    customLogLevel: function (res, err) {
      if (res.statusCode >= 500 || err) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          query: req.query,
          headers: {
            "user-agent": req.headers["user-agent"],
            "x-request-id": req.headers["x-request-id"]
          }
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      }
    }
  })
);
app.use(express.json({ limit: "2mb" }));

const db = openDb();
migrate(db);

function ensureIimbContextFile() {
  const { dataDir, iimbContextPath } = getPaths();
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(iimbContextPath)) {
    fs.writeFileSync(
      iimbContextPath,
      "# IIMB — Development Office Context\n\n## Mission\n\n[Fill this in]\n",
      "utf8"
    );
  }
}
ensureIimbContextFile();

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/episodes", (req, res) => {
  // Manual-only mode: return only manual records
  const all = listEpisodes(db);
  res.json(all.filter((e) => e.source === "manual"));
});

app.get("/api/episodes/:id", (req, res) => {
  const ep = getEpisode(db, req.params.id);
  if (!ep) return res.status(404).json({ error: "Not found" });
  res.json(ep);
});

app.delete("/api/episodes/:id", (req, res) => {
  const r = deleteEpisode(db, req.params.id);
  if (!r.ok && r.reason === "not_found") return res.status(404).json({ error: "Not found" });
  if (!r.ok && r.reason === "not_manual")
    return res.status(400).json({ error: "Only manual entries can be deleted." });
  res.json({ ok: true });
});

// Podcast scraping intentionally removed. Endpoint kept but disabled for compatibility.
app.post("/api/episodes/refresh", (req, res) => {
  res.status(410).json({ error: "Podcast refresh disabled (manual-only mode)." });
});

app.get("/api/settings/iimb-context", (req, res) => {
  const { iimbContextPath } = getPaths();
  const content = fs.readFileSync(iimbContextPath, "utf8");
  res.type("text/plain").send(content);
});

app.put("/api/settings/iimb-context", (req, res) => {
  const { iimbContextPath } = getPaths();
  const content = (req.body && req.body.content) || "";
  fs.writeFileSync(iimbContextPath, content, "utf8");
  res.json({ ok: true });
});

// ---- Pipeline + SSE ----
const running = new Set(); // episode ids

function requireEnv(res) {
  const anthropic = (process.env.ANTHROPIC_API_KEY || "").trim();
  const tavily = (process.env.TAVILY_API_KEY || "").trim();
  if (!anthropic) {
    res.status(400).json({ error: "Missing ANTHROPIC_API_KEY" });
    return false;
  }
  if (!tavily) {
    res.status(400).json({ error: "Missing TAVILY_API_KEY" });
    return false;
  }
  return true;
}

async function startPipeline(id, { force = false } = {}) {
  const ep = getEpisode(db, id);
  if (!ep) throw new Error("Not found");
  if (!force && ep.status === "complete") return { skipped: true };
  if (running.has(id)) return { alreadyRunning: true };

  const run_id = uuidv4();
  running.add(id);
  updateEpisode(db, id, { status: "processing", error_message: null });
  publish(id, "status", { step: "fetching_sources", message: "Starting..." });
  logger.info(
    { episode_id: id, force, source: ep.source, moneycontrol_url: ep.moneycontrol_url },
    "pipeline started"
  );
  addPipelineEvent(db, {
    episode_id: id,
    run_id,
    level: "info",
    step: "start",
    message: "Pipeline started",
    data: { force, source: ep.source, moneycontrol_url: ep.moneycontrol_url }
  });
  const t0 = Date.now();

  try {
    const { insights, message } = await runPipeline({
      db,
      run_id,
      episode: ep,
      updateEpisode
    });

    updateEpisode(db, id, {
      status: "complete",
      profile_json: JSON.stringify(insights),
      linkedin_message: message,
      processed_at: new Date().toISOString()
    });

    publish(id, "complete", { profile_id: id });
    logger.info({ episode_id: id, ms: Date.now() - t0 }, "pipeline complete");
    addPipelineEvent(db, {
      episode_id: id,
      run_id,
      level: "info",
      step: "complete",
      message: "Pipeline complete",
      data: { ms: Date.now() - t0 }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateEpisode(db, id, { status: "error", error_message: msg });
    publish(id, "error", { message: msg });
    logger.error({ episode_id: id, ms: Date.now() - t0, err }, "pipeline error");
    addPipelineEvent(db, {
      episode_id: id,
      run_id,
      level: "error",
      step: "error",
      message: msg,
      data: { ms: Date.now() - t0 }
    });
  } finally {
    running.delete(id);
    closeAll(id);
    logger.debug({ episode_id: id }, "pipeline streams closed");
    addPipelineEvent(db, {
      episode_id: id,
      run_id,
      level: "debug",
      step: "done",
      message: "SSE streams closed"
    });
  }

  return { started: true };
}

app.post("/api/episodes/run/:id", async (req, res) => {
  if (!requireEnv(res)) return;
  const id = req.params.id;
  try {
    await startPipeline(id, { force: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "Not found" });
  }
});

app.get("/api/episodes/stream/:id", (req, res) => {
  req.log.info({ episode_id: req.params.id }, "SSE subscribe");
  subscribe(req.params.id, res);
});

app.get("/api/episodes/:id/logs", (req, res) => {
  const ep = getEpisode(db, req.params.id);
  if (!ep) return res.status(404).json({ error: "Not found" });
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
  const events = listPipelineEvents(db, { episode_id: req.params.id, limit });
  res.json(events);
});

app.post("/api/episodes/:id/reresearch", async (req, res) => {
  if (!requireEnv(res)) return;
  const id = req.params.id;
  const ep = getEpisode(db, id);
  if (!ep) return res.status(404).json({ error: "Not found" });
  req.log.info({ episode_id: id }, "reresearch requested");

  updateEpisode(db, id, {
    status: "pending",
    error_message: null,
    profile_json: null,
    linkedin_message: null,
    linkedin_message_v2: null,
    linkedin_message_v3: null,
    processed_at: null
  });

  await startPipeline(id, { force: true });
  res.json({ ok: true });
});

app.post("/api/episodes/:id/regenerate", async (req, res) => {
  if (!requireEnv(res)) return;
  const id = req.params.id;
  const ep = getEpisode(db, id);
  if (!ep) return res.status(404).json({ error: "Not found" });

  const insights = req.body && req.body.insights;
  if (!insights || typeof insights !== "object") {
    return res.status(400).json({ error: "Body must be { insights: {...} }" });
  }

  const { iimbContextPath } = getPaths();
  const iimbContext = fs.readFileSync(iimbContextPath, "utf8");

  try {
    const newMsg = await stage2Message({ insightsJson: insights, iimbContext });

    const patch = {};
    if (ep.linkedin_message) {
      if (!ep.linkedin_message_v2) patch.linkedin_message_v2 = ep.linkedin_message;
      else if (!ep.linkedin_message_v3) {
        patch.linkedin_message_v3 = ep.linkedin_message_v2;
        patch.linkedin_message_v2 = ep.linkedin_message;
      }
    }
    patch.linkedin_message = newMsg;
    updateEpisode(db, id, patch);

    res.json({ message: newMsg });
  } catch (err) {
    req.log.error({ episode_id: id, err }, "regenerate failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/manual", async (req, res) => {
  if (!requireEnv(res)) return;
  const name = (req.body && req.body.name && String(req.body.name).trim()) || "";
  if (!name) return res.status(400).json({ error: "name is required" });

  const id = uuidv4();
  upsertEpisode(db, {
    id,
    source: "manual",
    guest_name: name,
    organisation: null,
    moneycontrol_url: null,
    episode_title: name,
    episode_description: null,
    status: "pending"
  });

  // Start immediately
  startPipeline(id, { force: true }).catch(() => {});

  res.json({ id });
});

// Serve frontend (single-service deploy)
// Dev: Vite serves the UI; Express should be APIs-only.
// Prod: Express serves `client/dist` if present.
const clientDist = path.join(process.cwd(), "client", "dist");
const shouldServeClient =
  process.env.SERVE_CLIENT === "true" || process.env.NODE_ENV === "production";
if (shouldServeClient && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Startup behavior: auto-refresh if empty
async function startup() {
  // Manual-only mode: nothing to schedule.
}

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  logger.info(
    {
      port,
      node_env: process.env.NODE_ENV,
      serve_client: process.env.SERVE_CLIENT,
      has_anthropic_key: !!(process.env.ANTHROPIC_API_KEY || "").trim(),
      has_tavily_key: !!(process.env.TAVILY_API_KEY || "").trim()
    },
    "server started"
  );
  startup().catch((e) => console.error("[startup] failed", e));
});

