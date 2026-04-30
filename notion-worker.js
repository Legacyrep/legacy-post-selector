/**
 * notion-worker.js
 * Cloudflare Worker — Legacy Real Estate Partners
 *
 * Live at: https://notion-worker.brett-bea.workers.dev
 *
 * Proxy between the weekly post selector at https://legacyrep.github.io/legacy-post-selector/
 * and per-agent Notion databases. No email functionality — emails go through
 * Cowork/Gmail separately.
 *
 * --------------------------------------------------------------------------
 * ENDPOINTS
 * --------------------------------------------------------------------------
 *   POST   /submit      Write weekly submission (one row per selected day).
 *                       Body: { agentSlug, agentName, weekStart, weekRange,
 *                               days[], weeklyNotes }
 *
 *   POST   /skip        Write a "Week Skipped" entry.
 *                       Body: { agentSlug, agentName, weekStart, weekRange }
 *
 *   POST   /draft       Save in-progress draft (called on inactivity timeout).
 *                       Body: { agentSlug, agentName, weekStart, weekRange,
 *                               days[], weeklyNotes, savedAt }
 *
 *   GET    /draft?agentSlug=&weekStart=
 *                       Restore most recent draft for this agent + week.
 *                       Returns: { ok: true, draft: {...}|null }
 *
 *   DELETE /draft?agentSlug=&weekStart=
 *                       Archive draft after successful submit.
 *
 *   GET    /submissions?agentSlug=&weekStart=
 *                       Returns submitted rows for a given week + post statuses
 *                       from the Output DB (if NOTION_<SLUG>_OUTPUT_DB is set).
 *
 *   OPTIONS *           CORS preflight.
 *
 * --------------------------------------------------------------------------
 * ENVIRONMENT VARIABLES (Cloudflare → Workers → Settings → Variables)
 * --------------------------------------------------------------------------
 *   NOTION_API_KEY                  Internal Notion integration secret.
 *   NOTION_<SLUG>_DB                Weekly Submissions database ID per agent.
 *   NOTION_<SLUG>_OUTPUT_DB         (optional) Post-status database ID per agent.
 *
 *   Slug → env name conversion:
 *     "sabrina-thompson"  →  NOTION_SABRINA_THOMPSON_DB
 *     "darrin-t-miller"   →  NOTION_DARRIN_T_MILLER_DB
 *
 * --------------------------------------------------------------------------
 * EXPECTED NOTION SCHEMA — Weekly Submissions DB (one per agent)
 * --------------------------------------------------------------------------
 *   Name                   Title
 *   Status                 Select        (Draft | Submitted | Week Skipped)
 *   Agent                  Rich text
 *   Day                    Select        (Monday | Tuesday | … | Sunday)
 *   Date                   Date
 *   Week Of                Rich text     (e.g. "May 4 – May 10")
 *   Week Start             Date
 *   Post Topic             Select
 *   Tone                   Select
 *   Template               Rich text
 *   Listing URL            URL
 *   Special Notes          Rich text
 *   Submitted At           Date
 *   Market Feeling         Rich text
 *   Weekly Context         Rich text
 *   Phrase Preferences     Rich text
 *   Post Type Request      Rich text
 *   Active Season          Rich text
 *   Season Emojis          Rich text
 *   Season Tone            Rich text
 *   Holiday Template Used  Checkbox
 *   Draft Saved At         Date
 *
 * EXPECTED NOTION SCHEMA — Output DB (one per agent, for post statuses)
 *   Name                   Title
 *   Date                   Date
 *   Day                    Rich text
 *   Week Start             Date
 *   Status                 Select        (Ready to Post | Updated | Approved | …)
 *
 * --------------------------------------------------------------------------
 * SECURITY NOTE
 * --------------------------------------------------------------------------
 * This worker has no authentication beyond CORS — anyone who knows the URL
 * can submit on behalf of any agent. CORS only blocks BROWSER-based calls
 * from disallowed origins; curl/Postman/etc. ignore CORS entirely.
 *
 * Acceptable for a pre-launch test. Before going live with real agent data,
 * add either: (a) a shared secret header checked here, (b) Cloudflare Access
 * in front of the worker, or (c) per-agent JWT.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ============================================================
// CORS
// ============================================================
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/legacyrep\.github\.io$/i,
  /^https:\/\/[a-z0-9-]+\.github\.io$/i,
  /^https:\/\/[a-z0-9-]+\.pages\.dev$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i
];

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://legacyrep.github.io",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResp(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

function errorResp(message, status, origin, extra) {
  console.error(`[error ${status}] ${message}`, extra ? JSON.stringify(extra) : "");
  return jsonResp({ ok: false, error: message, ...(extra ? { detail: extra } : {}) }, status, origin);
}

// ============================================================
// SLUG → ENV VAR LOOKUP
// ============================================================
function slugToEnvBase(slug) {
  if (!slug || typeof slug !== "string") return "";
  return slug.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function getDbId(env, slug) {
  return env["NOTION_" + slugToEnvBase(slug) + "_DB"] || null;
}
function getOutputDbId(env, slug) {
  return env["NOTION_" + slugToEnvBase(slug) + "_OUTPUT_DB"] || null;
}

// ============================================================
// NOTION HTTP HELPER
// ============================================================
async function notion(env, method, path, body) {
  if (!env.NOTION_API_KEY) throw new Error("NOTION_API_KEY env var is missing");
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(NOTION_API + path, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const msg = (json && json.message) ? json.message : text || res.statusText;
    const err = new Error(`Notion ${method} ${path} → ${res.status} ${msg}`);
    err.status = res.status;
    err.notion = json;
    throw err;
  }
  return json;
}

// ============================================================
// PROPERTY BUILDERS
// ============================================================
function rt(text) {
  if (text === undefined || text === null || text === "") return [];
  const s = String(text);
  // Notion rich_text per block max ≈ 2000 chars; chunk if longer.
  const chunks = [];
  for (let i = 0; i < s.length; i += 1900) chunks.push(s.slice(i, i + 1900));
  return chunks.map((c) => ({ type: "text", text: { content: c } }));
}
const titleProp = (text) => ({ title: rt(text) });
const richTextProp = (text) => ({ rich_text: rt(text) });
const selectProp = (name) =>
  name && String(name).trim()
    ? { select: { name: String(name).slice(0, 100) } }
    : { select: null };
const dateProp = (iso) => (iso ? { date: { start: iso } } : { date: null });
const urlProp = (u) => (u && String(u).trim() ? { url: String(u).slice(0, 1900) } : { url: null });
const checkboxProp = (b) => ({ checkbox: !!b });

// ============================================================
// DATE HELPERS
// ============================================================
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function addDaysISO(weekStartISO, idx) {
  const [y, m, d] = String(weekStartISO).split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + idx);
  return dt.toISOString().slice(0, 10);
}

// ============================================================
// PAGE BUILDERS
// ============================================================
function buildSubmittedDayPage(dbId, agentName, dayIdx, weekStartISO, weekRange, day, weeklyNotes, submittedAtISO) {
  const dateISO = addDaysISO(weekStartISO, dayIdx);
  const dayName = DAY_NAMES[dayIdx] || "";
  const title = `${dayName} ${dateISO} — ${day.topic || ""}`.trim();
  const wn = weeklyNotes || {};
  return {
    parent: { database_id: dbId },
    properties: {
      "Name":                  titleProp(title),
      "Status":                selectProp("Submitted"),
      "Agent":                 richTextProp(agentName),
      "Day":                   selectProp(dayName),
      "Date":                  dateProp(dateISO),
      "Week Of":               richTextProp(weekRange),
      "Week Start":            dateProp(weekStartISO),
      "Post Topic":            selectProp(day.topic),
      "Tone":                  selectProp(day.tone),
      "Template":              richTextProp(day.selectedTemplate),
      "Listing URL":           urlProp(day.url),
      "Special Notes":         richTextProp(day.notes),
      "Submitted At":          dateProp(submittedAtISO),
      "Market Feeling":        richTextProp(wn.marketFeeling),
      "Weekly Context":        richTextProp(wn.weeklyContext),
      "Phrase Preferences":    richTextProp(wn.phrasePreferences),
      "Post Type Request":     richTextProp(wn.postTypeRequest),
      "Active Season":         richTextProp(wn.activeSeason),
      "Season Emojis":         richTextProp(wn.seasonEmojis),
      "Season Tone":           richTextProp(wn.seasonTone),
      "Holiday Template Used": checkboxProp(wn.holidayTemplateUsed)
    }
  };
}

function buildSkipPage(dbId, agentName, weekStartISO, weekRange, submittedAtISO) {
  return {
    parent: { database_id: dbId },
    properties: {
      "Name":         titleProp(`Week of ${weekRange || weekStartISO} — Skipped`),
      "Status":       selectProp("Week Skipped"),
      "Agent":        richTextProp(agentName),
      "Week Of":      richTextProp(weekRange),
      "Week Start":   dateProp(weekStartISO),
      "Submitted At": dateProp(submittedAtISO)
    }
  };
}

function buildDraftPage(dbId, agentName, weekStartISO, weekRange, savedAtISO, draftJsonString) {
  return {
    parent: { database_id: dbId },
    properties: {
      "Name":           titleProp(`Draft — ${weekRange || weekStartISO}`),
      "Status":         selectProp("Draft"),
      "Agent":          richTextProp(agentName),
      "Week Of":        richTextProp(weekRange),
      "Week Start":     dateProp(weekStartISO),
      "Draft Saved At": dateProp(savedAtISO)
    },
    children: [
      {
        object: "block",
        type: "code",
        code: { language: "json", rich_text: rt(draftJsonString) }
      }
    ]
  };
}

// ============================================================
// DRAFT HELPERS
// ============================================================
async function archiveDraftPages(env, dbId, weekStartISO) {
  const data = await notion(env, "POST", `/databases/${dbId}/query`, {
    filter: {
      and: [
        { property: "Status",     select: { equals: "Draft" } },
        { property: "Week Start", date:   { equals: weekStartISO } }
      ]
    },
    page_size: 25
  });
  const ids = ((data && data.results) || []).map((p) => p.id);
  for (const id of ids) {
    try {
      await notion(env, "PATCH", `/pages/${id}`, { archived: true });
    } catch (e) {
      console.error("archive draft failed", e.message);
    }
  }
  return ids.length;
}

async function readDraftFromPage(env, page) {
  const blocks = await notion(env, "GET", `/blocks/${page.id}/children?page_size=10`);
  const codeBlock = ((blocks && blocks.results) || []).find((b) => b.type === "code");
  if (!codeBlock) return null;
  const text = (codeBlock.code.rich_text || [])
    .map((t) => t.plain_text || (t.text && t.text.content) || "")
    .join("");
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ============================================================
// PROPERTY READERS
// ============================================================
function readSelect(page, propName) {
  const p = page.properties && page.properties[propName];
  return p && p.select ? p.select.name : null;
}
function readDate(page, propName) {
  const p = page.properties && page.properties[propName];
  return p && p.date ? p.date.start : null;
}
function readRichText(page, propName) {
  const p = page.properties && page.properties[propName];
  if (!p) return "";
  const arr = p.rich_text || p.title || [];
  return arr.map((x) => x.plain_text || (x.text && x.text.content) || "").join("");
}
function readUrl(page, propName) {
  const p = page.properties && page.properties[propName];
  return p ? p.url || null : null;
}
function readCheckbox(page, propName) {
  const p = page.properties && page.properties[propName];
  return !!(p && p.checkbox);
}

function extractDayRow(page) {
  return {
    date:                 readDate(page, "Date"),
    day:                  readSelect(page, "Day"),
    topic:                readSelect(page, "Post Topic"),
    tone:                 readSelect(page, "Tone"),
    selectedTemplate:     readRichText(page, "Template"),
    url:                  readUrl(page, "Listing URL"),
    notes:                readRichText(page, "Special Notes"),
    submittedAt:          readDate(page, "Submitted At"),
    marketFeeling:        readRichText(page, "Market Feeling"),
    weeklyContext:        readRichText(page, "Weekly Context"),
    phrasePreferences:    readRichText(page, "Phrase Preferences"),
    postTypeRequest:      readRichText(page, "Post Type Request"),
    activeSeason:         readRichText(page, "Active Season"),
    seasonEmojis:         readRichText(page, "Season Emojis"),
    seasonTone:           readRichText(page, "Season Tone"),
    holidayTemplateUsed:  readCheckbox(page, "Holiday Template Used")
  };
}

// ============================================================
// ENDPOINT HANDLERS
// ============================================================
async function handleSubmit(env, body, origin) {
  const { agentSlug, agentName, weekStart, weekRange, days, weeklyNotes } = body || {};
  if (!agentSlug)             return errorResp("Missing agentSlug", 400, origin);
  if (!agentName)             return errorResp("Missing agentName", 400, origin);
  if (!weekStart)             return errorResp("Missing weekStart (YYYY-MM-DD Monday)", 400, origin);
  if (!Array.isArray(days))   return errorResp("days must be an array of day objects", 400, origin);
  const dbId = getDbId(env, agentSlug);
  if (!dbId) return errorResp(
    `No Notion DB configured for ${agentSlug} — set env var NOTION_${slugToEnvBase(agentSlug)}_DB`,
    500, origin
  );

  const submittedAtISO = new Date().toISOString();
  const written = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!d || !d.topic) continue; // skip blank/skipped days
    try {
      const page = buildSubmittedDayPage(dbId, agentName, i, weekStart, weekRange || "", d, weeklyNotes, submittedAtISO);
      const result = await notion(env, "POST", "/pages", page);
      written.push({ day: DAY_NAMES[i], pageId: result.id });
    } catch (e) {
      return errorResp(`Failed to write ${DAY_NAMES[i]}: ${e.message}`, 502, origin, { partial: written });
    }
  }
  if (written.length === 0) {
    return errorResp("Submission contained no selected days. Use POST /skip to skip a whole week.", 400, origin);
  }

  // Clean up any draft for this week now that it's submitted
  try { await archiveDraftPages(env, dbId, weekStart); } catch (e) { console.error("draft cleanup failed", e.message); }

  return jsonResp({ ok: true, daysWritten: written.length, written }, 200, origin);
}

async function handleSkip(env, body, origin) {
  const { agentSlug, agentName, weekStart, weekRange } = body || {};
  if (!agentSlug) return errorResp("Missing agentSlug", 400, origin);
  if (!agentName) return errorResp("Missing agentName", 400, origin);
  if (!weekStart) return errorResp("Missing weekStart", 400, origin);
  const dbId = getDbId(env, agentSlug);
  if (!dbId) return errorResp(`No Notion DB configured for ${agentSlug}`, 500, origin);

  try {
    const page = buildSkipPage(dbId, agentName, weekStart, weekRange || "", new Date().toISOString());
    const result = await notion(env, "POST", "/pages", page);
    try { await archiveDraftPages(env, dbId, weekStart); } catch (_) {}
    return jsonResp({ ok: true, pageId: result.id }, 200, origin);
  } catch (e) {
    return errorResp(`Skip-week write failed: ${e.message}`, 502, origin);
  }
}

async function handleDraftSave(env, body, origin) {
  const { agentSlug, agentName, weekStart, weekRange, days, weeklyNotes, savedAt } = body || {};
  if (!agentSlug) return errorResp("Missing agentSlug", 400, origin);
  if (!agentName) return errorResp("Missing agentName", 400, origin);
  if (!weekStart) return errorResp("Missing weekStart", 400, origin);
  const dbId = getDbId(env, agentSlug);
  if (!dbId) return errorResp(`No Notion DB configured for ${agentSlug}`, 500, origin);

  const draftPayload = {
    weekStart,
    weekRange: weekRange || "",
    days: days || [],
    weeklyNotes: weeklyNotes || null,
    savedAt: savedAt || Date.now()
  };
  const draftJson = JSON.stringify(draftPayload);
  const savedAtISO = new Date(savedAt || Date.now()).toISOString();

  try {
    // Replace any existing draft for this (agent, week) by archiving them first
    try { await archiveDraftPages(env, dbId, weekStart); } catch (_) {}
    const page = buildDraftPage(dbId, agentName, weekStart, weekRange || "", savedAtISO, draftJson);
    const result = await notion(env, "POST", "/pages", page);
    return jsonResp({ ok: true, pageId: result.id }, 200, origin);
  } catch (e) {
    return errorResp(`Draft save failed: ${e.message}`, 502, origin);
  }
}

async function handleDraftRestore(env, url, origin) {
  const agentSlug = url.searchParams.get("agentSlug");
  const weekStart = url.searchParams.get("weekStart"); // optional
  if (!agentSlug) return errorResp("Missing agentSlug", 400, origin);
  const dbId = getDbId(env, agentSlug);
  if (!dbId) return errorResp(`No Notion DB configured for ${agentSlug}`, 500, origin);

  const filterParts = [{ property: "Status", select: { equals: "Draft" } }];
  if (weekStart) filterParts.push({ property: "Week Start", date: { equals: weekStart } });

  try {
    const data = await notion(env, "POST", `/databases/${dbId}/query`, {
      filter: filterParts.length > 1 ? { and: filterParts } : filterParts[0],
      sorts: [{ property: "Draft Saved At", direction: "descending" }],
      page_size: 1
    });
    const page = ((data && data.results) || [])[0];
    if (!page) return jsonResp({ ok: true, draft: null }, 200, origin);
    const draft = await readDraftFromPage(env, page);
    return jsonResp({ ok: true, draft }, 200, origin);
  } catch (e) {
    return errorResp(`Draft restore failed: ${e.message}`, 502, origin);
  }
}

async function handleDraftDelete(env, url, origin) {
  const agentSlug = url.searchParams.get("agentSlug");
  const weekStart = url.searchParams.get("weekStart");
  if (!agentSlug) return errorResp("Missing agentSlug", 400, origin);
  if (!weekStart) return errorResp("Missing weekStart", 400, origin);
  const dbId = getDbId(env, agentSlug);
  if (!dbId) return errorResp(`No Notion DB configured for ${agentSlug}`, 500, origin);
  try {
    const archived = await archiveDraftPages(env, dbId, weekStart);
    return jsonResp({ ok: true, archived }, 200, origin);
  } catch (e) {
    return errorResp(`Draft delete failed: ${e.message}`, 502, origin);
  }
}

async function handleSubmissions(env, url, origin) {
  const agentSlug = url.searchParams.get("agentSlug");
  const weekStart = url.searchParams.get("weekStart");
  if (!agentSlug) return errorResp("Missing agentSlug", 400, origin);
  if (!weekStart) return errorResp("Missing weekStart (YYYY-MM-DD Monday of the week to fetch)", 400, origin);
  const dbId = getDbId(env, agentSlug);
  if (!dbId) return errorResp(`No Notion DB configured for ${agentSlug}`, 500, origin);

  // Submitted rows for the requested week
  let submission = null;
  try {
    const data = await notion(env, "POST", `/databases/${dbId}/query`, {
      filter: {
        and: [
          { property: "Status",     select: { equals: "Submitted" } },
          { property: "Week Start", date:   { equals: weekStart } }
        ]
      },
      sorts: [{ property: "Date", direction: "ascending" }],
      page_size: 14
    });
    const days = ((data && data.results) || []).map((p) => extractDayRow(p));
    submission = { weekStart, days };
  } catch (e) {
    return errorResp(`Submissions fetch failed: ${e.message}`, 502, origin);
  }

  // Post statuses (optional — Output DB)
  const outputDbId = getOutputDbId(env, agentSlug);
  let statuses = [];
  if (outputDbId) {
    try {
      const data = await notion(env, "POST", `/databases/${outputDbId}/query`, {
        filter: { property: "Week Start", date: { equals: weekStart } },
        sorts: [{ property: "Date", direction: "ascending" }],
        page_size: 25
      });
      statuses = ((data && data.results) || []).map((p) => ({
        date:   readDate(p, "Date"),
        day:    readRichText(p, "Day"),
        status: readSelect(p, "Status")
      }));
    } catch (e) {
      console.error("Output DB fetch failed (non-fatal)", e.message);
      // Fall through with empty statuses; the website will show "Status pending".
    }
  }

  return jsonResp({ ok: true, submission, statuses }, 200, origin);
}

// ============================================================
// ROUTER
// ============================================================
async function readJson(request) {
  try { return await request.json(); } catch (_) { return null; }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (method === "GET" && path === "/") {
        return jsonResp(
          { ok: true, service: "legacy-post-selector worker", time: new Date().toISOString() },
          200, origin
        );
      }

      if (method === "POST"   && path === "/submit")      return await handleSubmit(env, await readJson(request), origin);
      if (method === "POST"   && path === "/skip")        return await handleSkip(env, await readJson(request), origin);
      if (method === "POST"   && path === "/draft")       return await handleDraftSave(env, await readJson(request), origin);
      if (method === "GET"    && path === "/draft")       return await handleDraftRestore(env, url, origin);
      if (method === "DELETE" && path === "/draft")       return await handleDraftDelete(env, url, origin);
      if (method === "GET"    && path === "/submissions") return await handleSubmissions(env, url, origin);

      return errorResp(`Not found: ${method} ${path}`, 404, origin);
    } catch (e) {
      return errorResp(`Worker error: ${e.message}`, 500, origin, { stack: e.stack });
    }
  }
};
