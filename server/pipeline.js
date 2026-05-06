const cheerio = require("cheerio");
const { tavily } = require("tavily");
const Anthropic = require("@anthropic-ai/sdk");

const { getPaths } = require("./db");
const { publish, closeAll } = require("./sseHub");
const { logger } = require("./logger");

function capTextByChars(s, maxChars) {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n\n[TRUNCATED]";
}

function extractReadableText(html) {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,canvas").remove();
  $("nav,header,footer,aside").remove();
  // remove common ad containers
  $("[class*='ad'],[id*='ad'],[class*='Ads'],[id*='Ads']").remove();

  const body = $("body");
  const text = (body.length ? body : $.root()).text();
  return text.replace(/\s+/g, " ").trim();
}

async function safeFetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; IIMB-ProspectingBot/1.0; +https://iimb.ac.in)"
    }
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
  const html = await res.text();
  return extractReadableText(html);
}

function stageSteps() {
  return {
    fetching_sources: "Gathering research sources...",
    searching: "Running web searches...",
    reading: "Reading 5 key sources...",
    extracting: "Extracting insights...",
    drafting: "Drafting LinkedIn message..."
  };
}

async function anthropicJson({ system, prompt, maxTokens }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }]
  });
  const text = (resp.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
  return text;
}

async function runTavilyQueries(name, org) {
  const client = tavily({ apiKey: process.env.TAVILY_API_KEY });
  const q = [
    `"${name}" philanthropy India giving foundation`,
    `"${name}" "${org || ""}" interview OR profile OR speech`,
    `"${name}" LinkedIn profile`,
    `"${name}" board trustee advisory nonprofit`,
    `"${name}" IIM OR alumni OR education India`
  ];

  const results = await Promise.all(
    q.map(async (query) => {
      try {
        const r = await client.search(query, {
          maxResults: 20,
          includeAnswer: false,
          includeRawContent: false
        });
        return { query, results: r.results || [] };
      } catch (e) {
        return { query, results: [], error: e instanceof Error ? e.message : String(e) };
      }
    })
  );

  const snippets = [];
  for (const bucket of results) {
    if (bucket.error) {
      logger.warn({ episode_id: name, query: bucket.query, error: bucket.error }, "tavily query failed");
    }
    for (const item of bucket.results) {
      snippets.push({
        url: item.url,
        title: item.title,
        content: item.content,
        score: item.score,
        query: bucket.query
      });
    }
  }
  return snippets;
}

async function triageUrls(name, moneycontrolUrl, snippets) {
  const system = "You are selecting URLs for donor research.";
  const prompt = `You are selecting URLs to fetch in full for donor research on ${name}.
From the search result snippets below, return a JSON array of exactly 5 URLs.
Prioritise: (1) the Moneycontrol episode page if not already fetched,
(2) long-form profile articles in reputable outlets,
(3) the guest's organisation About/Impact page,
(4) a news article with direct quotes,
(5) their LinkedIn public profile if accessible.
Return only: ["url1", "url2", "url3", "url4", "url5"]

Moneycontrol URL (if any): ${moneycontrolUrl || "N/A"}

Snippets:
${JSON.stringify(snippets)}
`;
  const raw = await anthropicJson({ system, prompt, maxTokens: 256 });
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.slice(0, 5);
  } catch {
    // ignore
  }
  // Fallback: pick top 5 unique urls by score
  const urls = [];
  for (const s of snippets) {
    if (!s.url || urls.includes(s.url)) continue;
    urls.push(s.url);
    if (urls.length >= 5) break;
  }
  return urls;
}

async function stage1Extract({ name, org, episodeDescription, researchContent, iimbContext }) {
  const system = `You are a philanthropic research analyst for IIMB's development office.
Extract structured insights about this person for donor prospecting.
Be specific. Reference actual things they said or did — no generalisations.
If something is not evidenced in the sources, say "not found" — do not invent.
Return only valid JSON. No preamble, no markdown fences, no explanation.`;

  const prompt = `Name: ${name}
Organisation: ${org || "unknown — infer from sources"}
Episode description: ${episodeDescription || "N/A — manual entry"}

Research content from sources:
${researchContent}

IIMB context:
${iimbContext}

Return this JSON exactly:
{
  "full_name": "Verified full name from sources",
  "current_role": "Current job title",
  "organisation": "Current organisation",
  "location": "City, Country",
  "linkedin_url": "URL or null",
  "education": ["Degree/Institution list"],
  "career_arc": "3-5 word arc e.g. Finance → Family Philanthropy",
  "origin_story": "One sentence: the specific moment or reason they moved into this work",
  "core_thesis": "Their specific viewpoint or belief — not a sector, a perspective",
  "best_quote": "Most specific quotable thing they actually said. Exact if available, paraphrased if not.",
  "apparent_skepticisms": ["Things they seem frustrated with or would push back on"],
  "vocabulary": ["6-8 specific words/phrases they actually use"],
  "giving_style": "One of: personal giving | family foundation | institution-building | knowledge philanthropy | diaspora giving | corporate CSR | board-level strategy",
  "estimated_capacity": "One of: exploratory | mid-tier | major donor potential",
  "capacity_reasoning": "2 sentences. What evidence supports this estimate?",
  "iimb_alignment_score": 7,
  "iimb_alignment_reasoning": "2-3 sentences. Which IIMB centre, programme, or initiative connects to their work?",
  "relevant_iimb_touchpoints": ["List of specific IIMB programmes/centres relevant to them"],
  "alumni_connection": false,
  "warm_path": "Specific shared network, mutual contact, or connection point. 'None found' if absent.",
  "entities": {
    "organisations": [{"name": "", "relationship": ""}],
    "causes": [],
    "people_mentioned": []
  },
  "conversation_prep": {
    "three_talking_points": [
      "Specific, concrete talking point grounded in their actual work",
      "A second distinct talking point",
      "A third, ideally connecting their work to IIMB"
    ],
    "questions_to_ask": [
      "An open question based on a gap or tension in their work",
      "A second question that shows you've engaged with their specific thesis",
      "A third question about their giving journey or future plans"
    ],
    "things_to_avoid": ["Topics or framings that would land badly based on their profile"],
    "shared_context": "Any current events, reports, or sector trends they would find relevant right now",
    "their_ask": "What they are likely looking for from networks like IIMB — not a donor ask, their ask of you"
  },
  "sources_used": [{"url": "", "type": "episode_page|profile_article|org_website|linkedin|news"}]
}`;

  const raw = await anthropicJson({ system, prompt, maxTokens: 4096 });
  const stripJsonFences = (s) => {
    const t = (s || "").trim();
    const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return m ? m[1].trim() : t;
  };

  const tryParse = (s) => JSON.parse(stripJsonFences(s));

  try {
    return tryParse(raw);
  } catch (e) {
    // Retry once per spec
    const retry = await anthropicJson({
      system,
      prompt: `${prompt}\n\nYour previous response was not valid JSON. Return only valid JSON (no markdown fences).`,
      maxTokens: 4096
    });
    return tryParse(retry);
  }
}

async function stage2Message({ insightsJson, iimbContext }) {
  const system = `You are drafting a LinkedIn outreach message for IIMB's development office.
The message must sound like a thoughtful human who actually listened to the episode or researched this person — not a CRM template.
Style constraints:
- Write in the tone of Michael Lewis: concrete, curious, sharp.
- Short sentences. Free prose.
- No em dash characters (— or –). Use commas or periods instead.
Hard rules:
- Under 150 words
- First sentence must reference something specific the person said or did — not a compliment
- Do not use: inspire, inspiring, passionate, journey, impactful, thrilled, excited, honoured, resonate
- Do not open with "I"
- Do not mention "philanthropy" in the first sentence
- Mirror 1-2 words from their vocabulary naturally
- The IIMB connection must feel earned and specific, not bolted on
- Close with a low-friction ask: a conversation, not a meeting request`;

  const prompt = `Insights about this person:
${JSON.stringify(insightsJson)}

IIMB context:
${iimbContext}

Draft the LinkedIn message. Return only the message text. Nothing else.`;

  const raw = await anthropicJson({ system, prompt, maxTokens: 512 });
  return raw.trim();
}

const { addPipelineEvent } = require("./pipelineEvents");

async function runPipeline({ db, run_id, episode, updateEpisode }) {
  const id = episode.id;
  const steps = stageSteps();

  const { iimbContextPath } = getPaths();
  const iimbContext = require("fs").readFileSync(iimbContextPath, "utf8");

  const name = episode.guest_name || episode.episode_title || "Unknown";
  const org = episode.organisation || null;

  const sourcesUsed = [];
  let moneycontrolText = "";

  publish(id, "status", { step: "fetching_sources", message: steps.fetching_sources });
  logger.info({ episode_id: id, step: "fetching_sources" }, "pipeline step");
  addPipelineEvent(db, { episode_id: id, run_id, level: "info", step: "fetching_sources", message: steps.fetching_sources });

  if (episode.moneycontrol_url) {
    try {
      logger.debug({ episode_id: id, url: episode.moneycontrol_url }, "fetching moneycontrol");
      moneycontrolText = await safeFetchText(episode.moneycontrol_url);
      moneycontrolText = capTextByChars(moneycontrolText, 32000);
      sourcesUsed.push({ url: episode.moneycontrol_url, type: "episode_page" });
    } catch {
      sourcesUsed.push({ url: episode.moneycontrol_url, type: "episode_page" });
    }
  }

  publish(id, "status", { step: "searching", message: steps.searching });
  logger.info({ episode_id: id, step: "searching" }, "pipeline step");
  addPipelineEvent(db, { episode_id: id, run_id, level: "info", step: "searching", message: steps.searching });
  const snippets = await runTavilyQueries(name, org);
  logger.debug({ episode_id: id, snippets: snippets.length }, "tavily results");
  addPipelineEvent(db, { episode_id: id, run_id, level: "debug", step: "searching", message: "Tavily results", data: { snippets: snippets.length } });

  const selectedUrls = (await triageUrls(name, episode.moneycontrol_url || null, snippets))
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  logger.info({ episode_id: id, selected_urls: selectedUrls }, "triage selected urls");
  addPipelineEvent(db, { episode_id: id, run_id, level: "info", step: "triage", message: "Selected URLs", data: { selected_urls: selectedUrls } });

  publish(id, "status", { step: "reading", message: steps.reading });
  logger.info({ episode_id: id, step: "reading" }, "pipeline step");
  addPipelineEvent(db, { episode_id: id, run_id, level: "info", step: "reading", message: steps.reading });
  const fetched = [];
  for (const url of selectedUrls) {
    try {
      logger.debug({ episode_id: id, url }, "fetching source");
      const text = await safeFetchText(url);
      fetched.push({ url, text: capTextByChars(text, 32000) });
      sourcesUsed.push({ url, type: url.includes("linkedin.com") ? "linkedin" : "profile_article" });
    } catch {
      sourcesUsed.push({ url, type: "news" });
    }
  }
  addPipelineEvent(db, { episode_id: id, run_id, level: "debug", step: "reading", message: "Fetched sources", data: { fetched: fetched.map((f) => f.url) } });

  const researchContent = capTextByChars(
    [
      episode.episode_description ? `EPISODE DESCRIPTION\n${episode.episode_description}` : "",
      snippets.length ? `SEARCH SNIPPETS (TAVILY)\n${JSON.stringify(snippets)}` : "",
      moneycontrolText ? `SOURCE: ${episode.moneycontrol_url}\n${moneycontrolText}` : "",
      ...fetched.map((f) => `SOURCE: ${f.url}\n${f.text}`)
    ]
      .filter(Boolean)
      .join("\n\n---\n\n"),
    96000
  );

  publish(id, "status", { step: "extracting", message: steps.extracting });
  logger.info({ episode_id: id, step: "extracting" }, "pipeline step");
  addPipelineEvent(db, { episode_id: id, run_id, level: "info", step: "extracting", message: steps.extracting });
  const insights = await stage1Extract({
    name,
    org,
    episodeDescription: episode.episode_description || null,
    researchContent,
    iimbContext
  });
  if (!insights.sources_used || !Array.isArray(insights.sources_used)) {
    insights.sources_used = sourcesUsed;
  }

  publish(id, "status", { step: "drafting", message: steps.drafting });
  logger.info({ episode_id: id, step: "drafting" }, "pipeline step");
  addPipelineEvent(db, { episode_id: id, run_id, level: "info", step: "drafting", message: steps.drafting });
  const message = await stage2Message({ insightsJson: insights, iimbContext });
  addPipelineEvent(db, { episode_id: id, run_id, level: "debug", step: "drafting", message: "Drafted message", data: { chars: message.length } });

  return { insights, message };
}

module.exports = { runPipeline, stage2Message };

