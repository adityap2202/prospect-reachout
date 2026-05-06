# GivingPi Donor Prospecting Tool — Product Spec v2.0
**For:** Coding Agent  
**Owner:** IIMB Development Office  
**Stack:** Node.js/Express on Railway + React/Vite frontend  
**AI Model:** Claude Haiku 
**Status:** Ready for Build
build .env file with for me to put in all the API keys etc.

---

## 1. Purpose & Goal

A shareable, browser-based web tool that automates IIMB's donor prospecting workflow using the GivingPi "Catalyzing Change" podcast as the primary lead source — with an additional manual entry path for any person.

The tool must:
1. On first load, automatically fetch and display all available podcast episodes
2. Poll for new episodes and append them to the list without user action
3. When a user clicks any episode (or submits a manual name), automatically run the full pipeline: research → insight extraction → LinkedIn message
4. Surface a "Conversation Prep" panel with additional intelligence useful for face-to-face interaction
5. Feel like a premium internal tool — editorial, unhurried, deliberate

---

## 2. The Lead Source

### 2.1 Podcast Overview

**"Catalyzing Change: The Power of Philanthropy"** is a series within Moneycontrol's "Unusual Suspects" podcast, produced in collaboration with GivingPi. Host: Gaurav Choudhury. Currently Season 5, 23 total episodes.

**GivingPi curated episode index:**
```
https://givingpi.org/catalyzing-change-podcast
```
Pagination: `https://givingpi.org/catalyzing-change-podcast/filter?page=2` (9 episodes/page, 3 pages)

**Audioboom RSS feed (full Moneycontrol podcast):**
```
https://audioboom.com/channels/4937727.rss
```

Each episode links to a Moneycontrol article page with full summary and sometimes transcript excerpts.

### 2.2 Episode Data Per Card (from GivingPi page)

- Episode title (contains guest name + topic framing)
- Season number
- 2–3 sentence description
- Moneycontrol article URL

### 2.3 Startup Behaviour — Load All Episodes

**On first application load**, the backend must:
1. Scrape all pages of `https://givingpi.org/catalyzing-change-podcast` (pages 1–3, or until no more results)
2. Parse every episode card into a record: title, season, description, Moneycontrol URL, thumbnail
3. Store all records in SQLite (`episodes` table)
4. Return the full list to the frontend immediately

This means when a user first opens the tool, they see all 23 (or however many exist) episodes — no manual "import" step needed. The list is sorted: newest season/episode first.

**On subsequent loads / polling:**
- Every 24 hours (server cron), re-scrape page 1 of the GivingPi index
- Compare against stored episodes by Moneycontrol URL (dedup key)
- Append any new episodes to the list
- Frontend polls `GET /api/episodes/check` every 30 minutes to detect additions and update the list without a page refresh

**GivingPi page rendering note:** The episode cards are rendered in the initial HTML (confirmed via fetch). A static `node-fetch` + `cheerio` parse is sufficient. Do not use Playwright unless a static fetch returns empty episode data.

**RSS feed as secondary validator:** Also poll Audioboom RSS daily, filter items where description contains `"GivingPi"` or title contains `"Unusual Suspects"`. Use this to catch episodes that may appear in RSS before the GivingPi page is updated. Deduplicate by Moneycontrol URL.

---

## 3. Two Entry Paths

### 3.1 Path A — Podcast Episode (Primary)

User clicks an episode card in the left panel. The full research pipeline fires automatically with:
- Guest name (parsed from episode title)
- Organisation (parsed from episode description)
- Moneycontrol episode URL (pre-known)
- Episode summary text (pre-fetched from the GivingPi card description)

No confirmation dialog. No "Run Research" button. Clicking the card IS the trigger.

If the episode has already been processed (profile exists in SQLite), load the stored profile instantly — do not re-run the pipeline.

A "Re-research" button appears on completed profiles to force a fresh pipeline run.

### 3.2 Path B — Manual Name Entry (Secondary)

A text input at the top of the left panel. User types any person's name (need not be a podcast guest) and presses Enter or clicks a search icon.

The pipeline runs with:
- Guest name: user-supplied
- Organisation: blank (AI must infer from search results)
- Moneycontrol URL: none
- Episode summary: none

Manual entries are stored in SQLite under a `manual_entries` flag so they can be displayed separately from podcast episodes in the list (grouped at top under "Manual Searches").

Manual entries are not re-run automatically — only on explicit "Re-research".

---

## 4. Full Pipeline (Triggered by Either Entry Path)

### 4.1 Step 1 — Source Collection

**A. Fetch Moneycontrol episode page** (podcast path only)
- `node-fetch` the Moneycontrol URL
- `cheerio` parse: extract full article text, any pull quotes, guest bio if present
- Cap at 8,000 tokens of extracted body text

**B. Tavily search — run 5 queries in parallel**

| Query template | Purpose |
|---|---|
| `"[Name]" philanthropy India giving foundation` | Philanthropic profile |
| `"[Name]" "[Org]" interview OR profile OR speech` | Long-form quotes |
| `"[Name]" LinkedIn profile` | Professional background |
| `"[Name]" board trustee advisory nonprofit` | Affiliations |
| `"[Name]" IIM OR alumni OR education India` | IIMB relevance signal |

Each query returns 10 results. Total: ~50 snippets.

**C. AI triage — select 5 best URLs**

Send all 50 snippets to Claude Haiku with a triage prompt:

```
You are selecting URLs to fetch in full for donor research on [Name].
From the 50 search result snippets below, return a JSON array of exactly 5 URLs.
Prioritise: (1) the Moneycontrol episode page if not already fetched,
(2) long-form profile articles in reputable outlets,
(3) the guest's organisation About/Impact page,
(4) a news article with direct quotes,
(5) their LinkedIn public profile if accessible.
Return only: ["url1", "url2", "url3", "url4", "url5"]

Snippets:
[SNIPPETS_JSON]
```

**D. Fetch 5 selected pages**
- `node-fetch` each URL
- `cheerio` parse: strip nav, footer, ads, scripts. Extract body text only.
- Cap each page at 8,000 tokens
- Collect all content into a single string (`RESEARCH_CONTENT`)

### 4.2 Step 2 — Stage 1: Insight Extraction (Claude Haiku)

**System prompt:**
```
You are a philanthropic research analyst for IIMB's development office.
Extract structured insights about this person for donor prospecting.
Be specific. Reference actual things they said or did — no generalisations.
If something is not evidenced in the sources, say "not found" — do not invent.
Return only valid JSON. No preamble, no markdown fences, no explanation.
```

**User prompt:**
```
Name: [NAME]
Organisation: [ORG or "unknown — infer from sources"]
Episode description: [MONEYCONTROL_SUMMARY or "N/A — manual entry"]

Research content from sources:
[RESEARCH_CONTENT — up to 24,000 tokens]

IIMB context:
[IIMB_KNOWLEDGE_BASE]

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
}
```

### 4.3 Step 3 — Stage 2: LinkedIn Message (Claude Haiku)

**System prompt:**
```
You are drafting a LinkedIn outreach message for IIMB's development office.
The message must sound like a thoughtful human who actually listened to the episode or researched this person — not a CRM template.
Hard rules:
- Under 150 words
- First sentence must reference something specific the person said or did — not a compliment
- Do not use: inspire, inspiring, passionate, journey, impactful, thrilled, excited, honoured, resonate
- Do not open with "I"
- Do not mention "philanthropy" in the first sentence
- Mirror 1-2 words from their vocabulary naturally
- The IIMB connection must feel earned and specific, not bolted on
- Close with a low-friction ask: a conversation, not a meeting request
```

**User prompt:**
```
Insights about this person:
[STAGE_1_JSON]

IIMB context:
[IIMB_KNOWLEDGE_BASE]

Draft the LinkedIn message. Return only the message text. Nothing else.
```

### 4.4 Pipeline Status Events

The backend emits Server-Sent Events (SSE) during pipeline execution so the frontend can show a live progress indicator:

```
event: status
data: {"step": "fetching_sources", "message": "Gathering research sources..."}

event: status
data: {"step": "searching", "message": "Running web searches..."}

event: status
data: {"step": "reading", "message": "Reading 5 key sources..."}

event: status
data: {"step": "extracting", "message": "Extracting insights..."}

event: status
data: {"step": "drafting", "message": "Drafting LinkedIn message..."}

event: complete
data: {"profile_id": "uuid"}
```

Frontend subscribes to SSE on pipeline start and updates the UI progress indicator in real time.

---

## 5. Conversation Prep Panel

When a profile is loaded in the centre panel, a **"Conversation Prep"** button appears at the bottom of the research column.

Clicking it slides open a fourth panel (or replaces the right panel temporarily) showing:

### Contents

**Three Talking Points**
Pre-generated, specific, grounded in the person's actual work. Not generic philanthropy talking points.  
Example: *"The India Energy and Climate Center's focus on translating research into policy briefings mirrors what IIMB's Centre for Public Policy is trying to build — worth exploring if there's a collaboration angle."*

**Questions to Ask Them**
Three open questions the user can ask in a real conversation. Tailored to show genuine engagement with the person's specific work.  
Example: *"You've described institution-building as the giving itself — do you find that framing resonates with other philanthropists in your network, or is it still a minority view?"*

**Things to Avoid**
Topics, framings, or assumptions that would land badly with this person based on their profile.  
Example: *"Avoid framing IIMB's ask as project-based funding — she has explicitly criticised short grant cycles."*

**Shared Context**
Current sector trends, reports, or news items that this person would find immediately relevant. Gives the user something timely to mention.

**Their Likely Ask**
What this person is probably looking for from networks like IIMB — not what IIMB wants from them, but what they want. Repositions the conversation as mutual.

### UX Behaviour

- Conversation Prep content is generated as part of Stage 1 (it's a field in the extraction JSON — `conversation_prep`) — no additional API call needed
- The panel opens with a slide-in animation
- Content is not editable (read-only reference)
- A "Close" button returns to the standard three-panel view
- Print / Copy All button exports the talking points as plain text

---

## 6. Guest Profile Schema (SQLite)

```sql
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- 'podcast' | 'manual'
  rss_guid TEXT,
  moneycontrol_url TEXT,
  givingpi_url TEXT,
  episode_title TEXT,
  episode_description TEXT,
  season INTEGER,
  published_date TEXT,
  thumbnail_url TEXT,
  guest_name TEXT,
  organisation TEXT,
  status TEXT DEFAULT 'pending',     -- 'pending' | 'processing' | 'complete' | 'error'
  error_message TEXT,
  profile_json TEXT,                 -- Full Stage 1 JSON (stringified)
  linkedin_message TEXT,             -- Stage 2 output
  linkedin_message_v2 TEXT,
  linkedin_message_v3 TEXT,
  processed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_moneycontrol_url ON episodes(moneycontrol_url);
CREATE INDEX idx_status ON episodes(status);
CREATE INDEX idx_source ON episodes(source);
```

---

## 7. AI Model

**All AI calls use Claude Haiku:**
```
Model: claude-haiku-4-5-20251001
Max tokens: 4096 (Stage 1 extraction), 512 (Stage 2 message), 256 (URL triage)
```

Use the Anthropic Node.js SDK (`@anthropic-ai/sdk`). Never hardcode the API key — read from `process.env.ANTHROPIC_API_KEY`.

Haiku is fast and cheap for this workload. The two-stage prompt architecture (extract then draft) compensates for Haiku's lower reasoning depth by giving it structured input at each step.

---

## 8. Backend — Node.js/Express on Railway

### 8.1 Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express 4 |
| Database | SQLite via `better-sqlite3` |
| RSS parsing | `rss-parser` |
| Web fetching | `node-fetch` + `cheerio` |
| Search | Tavily API (`tavily` npm package) |
| AI | `@anthropic-ai/sdk` |
| Scheduling | `node-cron` |
| SSE | Native Express response streaming |
| Hosting | Railway (Node.js service) |

### 8.2 Environment Variables

```
ANTHROPIC_API_KEY=
TAVILY_API_KEY=
PORT=3001
NODE_ENV=production
```

These are set in the Railway dashboard — never in code.

### 8.3 API Endpoints

```
GET  /api/episodes
     Returns all episodes (id, source, season, episode_title, guest_name,
     organisation, status, iimb_alignment_score, thumbnail_url, published_date)
     Sorted: manual entries first, then by season DESC, episode DESC

GET  /api/episodes/:id
     Returns full profile including profile_json and all linkedin_message versions

POST /api/episodes/refresh
     Triggers scrape of GivingPi pages 1–3 + RSS poll.
     Inserts new episodes with status='pending'. Returns count of new episodes found.

POST /api/episodes/run/:id
     Triggers full research pipeline for episode :id.
     Returns 200 immediately. Progress via SSE.

GET  /api/episodes/stream/:id
     SSE endpoint. Client subscribes here after calling /run/:id.
     Emits status events during pipeline. Closes on 'complete' or 'error'.

POST /api/episodes/:id/regenerate
     Body: { insights: {...edited Stage 1 JSON} }
     Re-runs Stage 2 only with provided insights.
     Returns { message: "new message text" }

POST /api/episodes/:id/reresearch
     Re-runs full pipeline from scratch for this episode.

POST /api/manual
     Body: { name: "Person Name" }
     Creates a manual entry record and triggers pipeline.
     Returns { id: "new-episode-id" } — client then subscribes to SSE.

GET  /api/settings/iimb-context
     Returns iimb-context.md file content as plain text.

PUT  /api/settings/iimb-context
     Body: { content: "markdown string" }
     Overwrites iimb-context.md.
```

### 8.4 Startup Behaviour

On server start (`app.listen`):
1. Run database migrations (create tables if not exist)
2. Check if `episodes` table is empty
3. If empty: immediately trigger `POST /api/episodes/refresh` internally to populate all episodes
4. Schedule daily cron: `0 6 * * *` → trigger refresh (6am daily)

### 8.5 Railway Deploy Config

`railway.json`:
```json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node server.js",
    "healthcheckPath": "/api/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

SQLite file path: `/app/data/db.sqlite` — use Railway's persistent volume or ephemeral storage (note: Railway ephemeral storage resets on deploy; for persistence use Railway Volumes or migrate to Turso/libSQL).

`iimb-context.md` path: `/app/data/iimb-context.md` — same volume.

---

## 9. Frontend — React/Vite

### 9.1 Tech Stack

| Layer | Choice |
|---|---|
| Framework | React 18 + Vite |
| Styling | Tailwind CSS v4 |
| Fonts | Google Fonts: Playfair Display + Inter |
| Icons | Lucide React (sparingly, thin stroke) |
| HTTP | Native fetch / EventSource |
| State | React useState + useReducer (no external state library) |
| Hosting | Railway (static build or second service) or serve via Express |

**Simplest deploy:** Serve the built React app from the Express backend using `express.static('dist')`. Single Railway service, single deploy. Vite builds to `dist/`, Express serves it.

### 9.2 Design System — Luxury/Editorial

The UI follows the Luxury/Editorial design language. Every design decision references these tokens:

**Color tokens (CSS variables in `index.css`):**
```css
:root {
  --bg:         #F9F8F6;  /* Warm Alabaster */
  --fg:         #1A1A1A;  /* Rich Charcoal */
  --muted-bg:   #EBE5DE;  /* Pale Taupe */
  --muted-fg:   #6C6863;  /* Warm Grey */
  --gold:       #D4AF37;  /* Metallic Gold — accent only */
  --white:      #FFFFFF;
}
```

**Typography:**
- Headlines: `font-['Playfair_Display']`, regular 400, italic for emphasis
- UI labels, body, buttons: `font-['Inter']`
- Overlines/labels: `text-xs uppercase tracking-[0.25em]`
- Buttons: `text-xs uppercase tracking-[0.2em] font-medium`
- No rounded corners anywhere (`rounded-none` or `border-radius: 0`)
- Borders: always `1px` width, charcoal at full or 10-20% opacity

**Motion:**
- UI interactions: `duration-500` ease-out
- Image hover: `duration-[1500ms]` grayscale to color
- Never faster than 300ms for anything decorative

**Images:**
- Default: `grayscale` filter
- Hover: `grayscale-0` with `scale-105` — ultra-slow transition

### 9.3 Layout

Three-panel layout (plus optional Conversation Prep panel):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HEADER                                                                     │
│  [decorative gridline]                                                      │
│  Catalyzing Change          [overline: IIMB DEVELOPMENT OFFICE]             │
│  Prospect Intelligence      [Refresh Episodes btn — minimal]                │
├─────────────────┬───────────────────────────────┬───────────────────────────┤
│                 │                               │                           │
│  EPISODE LIST   │  RESEARCH PROFILE             │  OUTREACH COMPOSER        │
│  [left panel]   │  [centre panel]               │  [right panel]            │
│                 │                               │                           │
│  ┌─────────┐   │  ● Shruti Deorah              │  [message textarea]       │
│  │ Manual  │   │  Founding Exec Director       │                           │
│  │ search  │   │  India Energy & Climate Ctr   │  [word count]             │
│  └─────────┘   │                               │                           │
│                 │  ─────────────────────        │  [Regenerate]             │
│  — MANUAL —     │                               │  [Copy]                  │
│  Person A       │  Origin Story                 │  [Open LinkedIn ↗]        │
│                 │  [editable field]             │                           │
│  — SEASON 5 —   │                               │                           │
│  Shruti D ●     │  Core Thesis                  │                           │
│  Raj & Anna     │  [editable field]             │                           │
│  Ramesh S       │                               │                           │
│  Rashi M        │  Best Quote                   │                           │
│  Sunny G        │  [field]                      │                           │
│                 │                               │                           │
│  — SEASON 4 —   │  Vocabulary                   │                           │
│  ...            │  [gold tag chips]             │                           │
│                 │                               │                           │
│                 │  Alignment: 8/10 ━━━━━━━━     │                           │
│                 │  [reasoning]                  │                           │
│                 │                               │                           │
│                 │  Capacity: Mid-tier           │                           │
│                 │  [reasoning]                  │                           │
│                 │                               │                           │
│                 │  Warm Path                    │                           │
│                 │  [field]                      │                           │
│                 │                               │                           │
│                 │  ─────────────────────        │                           │
│                 │  [Conversation Prep ↓]        │                           │
│                 │  [Re-research]                │                           │
└─────────────────┴───────────────────────────────┴───────────────────────────┘
```

On mobile: stack panels vertically. Show episode list first, collapse to show profile + composer once an episode is selected. Back button to return to list.

### 9.4 Left Panel — Episode List

**Manual search input (top of panel):**
- Underline-only input (no box border): `border-b border-[#1A1A1A] bg-transparent px-0 py-2 w-full`
- Placeholder text: Playfair Display italic, warm grey — *"Search any name..."*
- On Enter or search icon click: `POST /api/manual` → subscribe to SSE → show progress
- Input text: Inter, `text-sm`, charcoal

**Episode groups:**
- Section overline: `text-[10px] uppercase tracking-[0.3em] text-[#6C6863]` — "MANUAL SEARCHES", "SEASON 5", "SEASON 4", etc.
- Thin gold divider line (`h-px bg-[#D4AF37]/40`) between season groups

**Episode card:**
- No background, no box. Defined by `border-t border-[#1A1A1A]/10` only.
- On hover: subtle `bg-[#EBE5DE]/30` fill, `duration-500`
- Active/selected: `border-t border-[#1A1A1A]` (full opacity), `bg-[#EBE5DE]/50`
- Left: guest name in Inter medium 14px, organisation in Inter 12px warm grey
- Right: alignment score badge — colour coded: green `#2D6A4F` for 7–10, amber `#B7791F` for 4–6, grey for 1–3. Tiny `text-[10px]` number.
- Status indicator: pulsing gold dot when pipeline is running, checkmark when complete, x when error
- New/unprocessed episodes (status=pending): shown with a hollow dot

**Clicking an episode:**
1. If status=`complete` → load stored profile instantly from state
2. If status=`pending` → automatically trigger `POST /api/episodes/run/:id` → subscribe to SSE → show inline progress within the centre panel

No confirmation step. Click = run.

**Refresh button (header area):**
- Minimal secondary button: `border border-[#1A1A1A] text-[10px] uppercase tracking-[0.2em] px-6 h-8`
- On click: `POST /api/episodes/refresh` → show toast "Checking for new episodes..."
- If new episodes found: list updates, toast shows count

### 9.5 Centre Panel — Research Profile

**Loading state (pipeline running):**
- Full-height centre panel shows:
  - Guest name (if known) in large Playfair Display
  - Live status text in Inter light, warm grey: *"Gathering research sources..."*
  - A thin horizontal progress bar using the gold accent, filling from left across the panel width
  - Status updates from SSE update the text in real time
  - Motion: text fades in/out with `duration-700`

**Loaded state:**
- Guest name: Playfair Display, `text-3xl`, charcoal — largest text in the panel
- Role and org: Inter, `text-sm`, warm grey, separated by a thin `·` character
- Thin `h-px bg-[#1A1A1A]/10` divider line below header

**Fields (all editable inline):**

Each field follows the same pattern:
- Label: `text-[10px] uppercase tracking-[0.25em] text-[#6C6863]`  
- Content: `text-sm leading-relaxed text-[#1A1A1A]`  
- On focus/click: bottom border appears `border-b border-[#D4AF37]` — input mode  
- On blur: saves to local state (not to server — server save happens on "Regenerate" or explicit save)

Fields in order:
1. **Origin Story** — single line or short paragraph
2. **Core Thesis** — 1-2 sentences
3. **Best Quote** — displayed in Playfair italic, slightly indented, with a thin left gold border `border-l-2 border-[#D4AF37] pl-4`
4. **Vocabulary** — rendered as small tag chips: `text-[10px] uppercase tracking-[0.15em] border border-[#1A1A1A]/20 px-2 py-1`. Click chip to remove. Click `+` to add.
5. **Giving Style** — dropdown (styled as underline-select)
6. **IIMB Alignment** — score displayed as `8/10` in Inter medium + thin progress bar in gold. Below: editable reasoning textarea.
7. **Estimated Capacity** — dropdown: Exploratory / Mid-tier / Major Donor Potential
8. **Capacity Reasoning** — short textarea
9. **Warm Path** — text field. If "none found", display in warm grey italic.
10. **Career Arc** — small label tag, not editable

**Beneath fields:**
- Thin divider
- **"Conversation Prep"** button: secondary button style, full width
- **"Re-research"** link button: `text-[10px] uppercase tracking-[0.2em] text-[#6C6863] hover:text-[#D4AF37] duration-500`

**Sources used** — collapsed by default, expand to show list of URLs with type labels.

### 9.6 Right Panel — Outreach Composer

**Message textarea:**
- Full-width, no border box — just bottom border `border-b border-[#1A1A1A]/20`
- Font: Inter, `text-sm leading-relaxed`
- Background: transparent
- Min-height: 200px
- Auto-grows with content
- Fully editable

**Word count:**
- `text-[10px] text-[#6C6863]` — e.g. "127 / 150 words"
- Turns gold if over 150: `text-[#D4AF37]`

**Buttons (stacked vertically with generous spacing):**

1. **Regenerate Message** — Primary button with gold slide animation
   - Background: charcoal (`#1A1A1A`)
   - Hover: gold layer (`#D4AF37`) slides in from left
   - Full width, `h-12`, uppercase, `tracking-[0.2em]`, `text-xs`
   - Disabled state (no edits made): `opacity-50 pointer-events-none`
   - On click: `POST /api/episodes/:id/regenerate` with current insight JSON → replace message text

2. **Copy to Clipboard** — Secondary button
   - Transparent background, charcoal border, `h-12`
   - On click: copies message text, button text briefly changes to "Copied ✓" for 2 seconds
   - Hover: fills to charcoal, text inverts to white

3. **Open LinkedIn** — Link button
   - Text only, no border/background
   - `text-xs uppercase tracking-[0.2em] text-[#6C6863] hover:text-[#D4AF37] duration-500`
   - Opens: `https://www.linkedin.com/search/results/people/?keywords=[encodeURIComponent(guestName)]` in new tab

**Version history:**
- Below buttons: thin overline "PREVIOUS VERSIONS"
- Small text links to v2 and v3 if they exist: click to load that version into textarea
- Current version indicated with gold underline

### 9.7 Conversation Prep Panel

Triggered by clicking "Conversation Prep" button in centre panel.

**UX:** Slides in from the right, pushing the composer panel off-screen (or slides over it on mobile). Maintains the three-panel skeleton. Back arrow returns to composer.

**Layout:**
- Panel header: "Conversation Prep" in Playfair Display italic, `text-2xl`
- Overline: `text-[10px] uppercase tracking-[0.3em] text-[#6C6863]`

**Sections (separated by thin `h-px` dividers):**

**TALKING POINTS**  
Three numbered items. Each is a full sentence, specific to this person's actual work.  
Number in gold `text-[#D4AF37]`, Playfair Display, `text-3xl`. Item text in Inter `text-sm leading-relaxed`.

**QUESTIONS TO ASK**  
Three questions displayed as styled blockquotes — Playfair italic, left-indented, thin gold left border.

**THINGS TO AVOID**  
Red-flag items. Displayed with a thin `−` prefix in warm grey. Inter `text-sm`.

**SHARED CONTEXT**  
A short paragraph in Inter `text-sm leading-relaxed`. This is the "timely news hook" they can reference.

**THEIR LIKELY ASK**  
Bold emphasis field. Displayed with a subtle taupe background block (`bg-[#EBE5DE] p-6`), Playfair Display italic for the main statement.

**Actions:**
- **Copy All** — secondary button, copies all sections as formatted plain text
- **Print** — link button, triggers browser print (panel is print-optimised)
- **Close** — text link, slides panel back off-screen

### 9.8 Header

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [decorative vertical gridlines — 4 lines at column boundaries, opacity 20%]│
│                                                                             │
│  CATALYZING CHANGE                                    IIMB DEVELOPMENT      │
│  [overline: text-[10px] tracking-[0.3em] gold]       OFFICE                │
│                                                                             │
│  Prospect                                             [Refresh Episodes]    │
│  Intelligence                                                               │
│  [Playfair Display, text-4xl, charcoal]                                     │
│                                                                             │
│  [full-width h-px divider, charcoal 20%]                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9.9 Global Visual Elements

**Paper noise texture:**
```css
.noise-overlay {
  position: fixed; inset: 0; z-index: 50;
  pointer-events: none; opacity: 0.02;
  background-image: url("data:image/svg+xml,..."); /* SVG fractal noise */
}
```

**Visible vertical gridlines (desktop only):**
Four `w-px bg-[#1A1A1A]/20 fixed h-screen pointer-events-none` divs at 25%, 50%, 75% of viewport width.

**Body background:** `#F9F8F6` — never pure white.

**Font imports (in `index.html`):**
```html
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
```

---

## 10. IIMB Knowledge Base

A static markdown file at `/app/data/iimb-context.md`. Editable in-app via Settings. Injected verbatim into every AI prompt.

**Required sections for the IIMB team to fill in:**
- IIMB's mission (1 paragraph)
- Named centres and programmes with 1-sentence descriptions
- Current funding priorities
- Notable existing donors and their focus areas
- The alumni angle in outreach
- What IIMB is NOT asking in first contact (keep it light)

**Starter template (team must personalise before first use):**
```markdown
# IIMB — Development Office Context

## Mission
IIM Bangalore is committed to [mission statement].

## Key Centres & Programmes
- **NSR Centre for Entrepreneurship**: Supports early-stage ventures and entrepreneurship education
- **[Other centre]**: [Description]

## Current Funding Priorities
[List what IIMB is actively raising for]

## Existing Donor Network
[Brief notes on existing donors and their focus areas — helps AI find warm paths]

## Alumni Angle
[How alumni connection is typically leveraged in outreach]

## What First Contact Is NOT
First outreach is not a funding ask. It is an introduction and a conversation request.
```

---

## 11. Error Handling

| Failure | Behaviour |
|---|---|
| GivingPi page returns empty episodes | Log warning, fall back to RSS-only episode detection |
| Moneycontrol URL blocked / 404 | Skip source, note in `sources_used` as `"blocked"`, continue with search results |
| Tavily returns no results | Skip that query, continue with remaining 4 |
| Claude returns malformed JSON (Stage 1) | Retry once with appended note: "Your previous response was not valid JSON. Return only valid JSON." If fails again, store raw text as `error_message`, set status=`error`, surface to user. |
| Stage 2 message sounds too generic | User edits insights and regenerates — this is the designed recovery path, not a bug |
| Minimal web presence for manual entry | Profile notes "Limited public information found." `estimated_capacity` = `"exploratory"`. Message draft includes warning: "⚠ Low data confidence — verify before sending." |
| Railway ephemeral storage reset | Show banner: "Database was reset on redeploy. Click Refresh to reload episodes." Re-running pipeline on any episode recreates its profile. |

---

## 12. Build Order for Coding Agent

Build in this sequence to allow testing at each stage:

1. **Database + migrations** — SQLite setup, schema, seed with empty tables
2. **Episode scraper** — GivingPi page scraper + RSS parser, dedup logic, `GET /api/episodes`
3. **Startup auto-load** — On first start, scrape all pages, populate DB
4. **Research pipeline** — Tavily search, URL triage (Haiku), selective fetch, Stage 1 extraction (Haiku), Stage 2 message (Haiku)
5. **SSE streaming** — Pipeline progress events
6. **Regenerate endpoint** — Stage 2 only with edited insights
7. **Manual entry** — `POST /api/manual`, pipeline integration
8. **Settings endpoints** — IIMB context read/write
9. **React app skeleton** — Three-panel layout, routing
10. **Episode list panel** — With groups, search input, status indicators
11. **Research profile panel** — Editable fields, loading state with SSE subscription
12. **Outreach composer panel** — Message display, regenerate, copy, LinkedIn link
13. **Conversation prep panel** — Slide-in with all sections
14. **Design system** — Luxury/Editorial tokens, fonts, noise texture, gridlines, animations
15. **Serve React from Express** — `express.static('dist')`, Vite build
16. **Railway deploy** — `railway.json`, environment variables, health check

---

## 13. V2 Upgrade Path (Do Not Build Now)

- **Knowledge graph** — Entity nodes (people, orgs, causes) and edges across all profiles. Cross-episode queries: "Which guests share board members with existing IIMB donors?"
- **Vector similarity** — Embed profiles; find "guests most similar to our best existing donors"
- **Email digest** — Weekly email to the team with new episodes and their alignment scores
- **LinkedIn integration** — Pre-fill and send messages via LinkedIn API if access is obtained
- **Multi-feed** — Extend to other philanthropy podcasts (Let's Talk Philanthropy, Dasra conversations)
- **Turso/libSQL** — Replace ephemeral SQLite with a persistent cloud database for Railway deploys

---

## 14. Pre-Build Checklist

Before the coding agent starts:

- [ ] `ANTHROPIC_API_KEY` — Anthropic console, Claude Haiku access confirmed
- [ ] `TAVILY_API_KEY` — Free account at tavily.com (1,000 searches/month free)
- [ ] Railway account created, project and service set up
- [ ] IIMB team has drafted initial `iimb-context.md` content (1–2 hours)
- [ ] Confirm `givingpi.org/catalyzing-change-podcast` returns episode data on static fetch (test: `curl https://givingpi.org/catalyzing-change-podcast | grep -i "season"`)
- [ ] Confirm Railway volume is configured for `/app/data` persistence

---

*End of Spec v2.0*
