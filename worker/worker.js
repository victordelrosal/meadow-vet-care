// Meadow Vet Care: live chatbot backend.
//
// Two surfaces, one source of truth (the clinic's public Google Sheet):
//
//   /mcp   A real, stateless MCP (Model Context Protocol) server exposing ONE tool,
//          search_services. Any MCP client (Claude Desktop, the Anthropic API's mcp
//          connector, the inspector) can connect and query the clinic's live services.
//
//   POST / The customer chat. Claude (claude-sonnet-5) is the brain; it is given the
//          same search_services tool and runs a tool-use loop. When a customer asks a
//          question, Claude calls the tool, the Worker fetches + filters the LIVE sheet
//          at that moment, hands the rows back to Claude, and Claude answers in natural
//          language. Edit the sheet -> the answers change on the next message. No redeploy.
//
// The Anthropic API key is held server-side as the secret ANTHROPIC_API_KEY and never
// ships to the browser.

const SHEET_ID = "1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4";
const SHEET_GID = "1277715587";
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

const MODEL = "claude-sonnet-5";
const CLINIC = "Meadow Vet Care";

const ALLOW = [
  "https://victordelrosal.com",
  "https://victordelrosal.github.io",
  "https://meadow-vet.pages.dev",
  "https://vet.kluxy.app",
  "http://localhost",
  "http://127.0.0.1",
  "null"
];

// ---------------------------------------------------------------------------
// Live data: fetch + parse the Google Sheet CSV. Cached ~60s at the module level
// so a burst of messages doesn't hammer Google, but edits still show within a minute.
// ---------------------------------------------------------------------------
let CACHE = { rows: null, at: 0 };
const CACHE_MS = 60_000;

async function getServices() {
  const now = Date.now();
  if (CACHE.rows && now - CACHE.at < CACHE_MS) return CACHE.rows;
  const r = await fetch(SHEET_CSV_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error(`sheet fetch failed: ${r.status}`);
  const rows = parseServices(await r.text());
  CACHE = { rows, at: now };
  return rows;
}

// RFC-4180-ish CSV parser: handles quoted fields, embedded commas, and "" escapes.
// Needed because at least one row ("Flea, tick & worm plan") has a comma inside a field.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseServices(text) {
  const grid = parseCSV(text).filter(r => r.length > 1 && r.some(c => c.trim() !== ""));
  if (!grid.length) return [];
  const header = grid[0].map(h => h.trim());
  const idx = (name) => header.indexOf(name);
  const col = {
    service_id: idx("service_id"), category: idx("category"), species: idx("species"),
    price_eur: idx("price_eur"), duration_min: idx("duration_min"),
    requires_appointment: idx("requires_appointment"), availability: idx("availability"),
    slots_this_week: idx("slots_this_week"), special_offer: idx("special_offer"),
    service_name: idx("service_name"), description: idx("description")
  };
  return grid.slice(1).map(r => ({
    service_id: (r[col.service_id] || "").trim(),
    category: (r[col.category] || "").trim(),
    species: (r[col.species] || "").trim(),
    price_eur: Number((r[col.price_eur] || "").trim()) || null,
    duration_min: Number((r[col.duration_min] || "").trim()) || null,
    requires_appointment: (r[col.requires_appointment] || "").trim(),
    availability: (r[col.availability] || "").trim(),
    slots_this_week: Number((r[col.slots_this_week] || "").trim()) || 0,
    special_offer: (r[col.special_offer] || "").trim(),
    service_name: (r[col.service_name] || "").trim(),
    description: (r[col.description] || "").trim()
  })).filter(x => x.service_name);
}

// ---------------------------------------------------------------------------
// Live data 2: Irish public holidays, from Nager.Date (no key, CORS, no rate limit).
//
// Nager types Good Friday as ["Bank","School"], NOT "Public", which is correct:
// Good Friday is a bank holiday in Ireland but not one of the 10 statutory public
// holidays. So we keep only types including "Public" and we match the official list.
// Fallbacks, in order: OpenHolidays API, then a baked table, so the clinic never
// answers "I don't know" just because a third party is down.
// ---------------------------------------------------------------------------
const HOLIDAY_CACHE = new Map(); // year -> { days, at }
const HOLIDAY_CACHE_MS = 24 * 60 * 60 * 1000;

// Ireland's 10 statutory public holidays, baked as a last-resort fallback.
const BAKED_HOLIDAYS = {
  2026: [
    ["2026-01-01", "New Year's Day"], ["2026-02-02", "Saint Brigid's Day"],
    ["2026-03-17", "Saint Patrick's Day"], ["2026-04-06", "Easter Monday"],
    ["2026-05-04", "May Day"], ["2026-06-01", "June Holiday"],
    ["2026-08-03", "August Holiday"], ["2026-10-26", "October Holiday"],
    ["2026-12-25", "Christmas Day"], ["2026-12-26", "St. Stephen's Day"]
  ],
  2027: [
    ["2027-01-01", "New Year's Day"], ["2027-02-01", "Saint Brigid's Day"],
    ["2027-03-17", "Saint Patrick's Day"], ["2027-03-29", "Easter Monday"],
    ["2027-05-03", "May Day"], ["2027-06-07", "June Holiday"],
    ["2027-08-02", "August Holiday"], ["2027-10-25", "October Holiday"],
    ["2027-12-25", "Christmas Day"], ["2027-12-26", "St. Stephen's Day"]
  ]
};

async function getHolidays(year) {
  const hit = HOLIDAY_CACHE.get(year);
  if (hit && Date.now() - hit.at < HOLIDAY_CACHE_MS) return hit.days;

  let days = null;
  try {
    const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/IE`, {
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (r.ok) {
      const raw = await r.json();
      days = raw
        .filter(h => Array.isArray(h.types) && h.types.includes("Public"))
        .map(h => ({ date: h.date, name: h.name, local_name: h.localName, source: "nager.date" }));
    }
  } catch (_) { /* fall through */ }

  if (!days || !days.length) {
    try {
      const r = await fetch(
        `https://openholidaysapi.org/PublicHolidays?countryIsoCode=IE&languageIsoCode=EN&validFrom=${year}-01-01&validTo=${year}-12-31`,
        { headers: { accept: "application/json" }, cf: { cacheTtl: 86400, cacheEverything: true } }
      );
      if (r.ok) {
        const raw = await r.json();
        days = raw.filter(h => h.nationwide).map(h => ({
          date: h.startDate,
          name: (h.name && h.name[0] && h.name[0].text) || "Public holiday",
          source: "openholidaysapi.org"
        }));
      }
    } catch (_) { /* fall through */ }
  }

  if ((!days || !days.length) && BAKED_HOLIDAYS[year])
    days = BAKED_HOLIDAYS[year].map(([date, name]) => ({ date, name, source: "baked fallback" }));

  days = days || [];
  HOLIDAY_CACHE.set(year, { days, at: Date.now() });
  return days;
}

// Today in Ireland (the Worker runs in UTC; Dublin is UTC+1 in summer).
function dublinToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayOf(iso) { return WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]; }

// Pre-formatted, human-readable date ("Monday 3 August 2026"). Returned alongside every ISO
// date so the model never has to reformat one, and so it can never read a raw ISO date aloud.
function human(iso) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(new Date(`${iso}T12:00:00Z`));
}
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The clinic's normal week. Public holidays override it: closed, emergency line only.
const HOURS = {
  Monday: "08:00-19:00", Tuesday: "08:00-19:00", Wednesday: "08:00-19:00",
  Thursday: "08:00-19:00", Friday: "08:00-19:00", Saturday: "09:00-17:00", Sunday: null
};
const EMERGENCY_NOTE = "The 24/7 emergency line is always open, including public holidays.";

async function describeDay(iso) {
  const year = Number(iso.slice(0, 4));
  const holidays = await getHolidays(year);
  const holiday = holidays.find(h => h.date === iso) || null;
  const weekday = weekdayOf(iso);
  const hours = HOURS[weekday];
  const open = !holiday && !!hours;
  return {
    date: iso,
    date_human: human(iso), // say this to the customer, never the ISO date
    weekday,
    is_public_holiday: !!holiday,
    holiday_name: holiday ? holiday.name : null,
    open,
    hours: open ? hours : null,
    reason: holiday
      ? `Closed: ${holiday.name} is an Irish public holiday.`
      : (!hours ? "Closed: the clinic does not open on Sundays." : null),
    source: holiday ? holiday.source : null
  };
}

// Named-day lookup, so the model never has to guess that e.g. Good Friday 2027 is 26 March.
// Searches ALL observances Nager knows for that year, including Bank/School days like Good
// Friday, which are NOT closures for us but which customers still ask about by name.
async function findByName(name, year) {
  const q = String(name).toLowerCase().replace(/[^a-z]/g, "");
  try {
    const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/IE`, {
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!r.ok) return null;
    const raw = await r.json();
    const norm = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
    const hit = raw.find(h => {
      const n = norm(h.name), l = norm(h.localName);
      return n.includes(q) || q.includes(n) || l.includes(q);
    });
    return hit ? hit.date : null;
  } catch (_) { return null; }
}

async function runOpening(args) {
  args = args || {};
  const today = dublinToday();
  let iso = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || "")) ? args.date : null;

  if (!iso && args.holiday_name) {
    const year = Number(args.year) || Number(today.slice(0, 4));
    iso = await findByName(args.holiday_name, year);
    // Named day already gone this year? Look at next year rather than answering about the past.
    if (iso && iso < today && !args.year) iso = (await findByName(args.holiday_name, year + 1)) || iso;
  }
  if (!iso) iso = today;

  const day = await describeDay(iso);

  // Next day the clinic is actually open, so we can always offer an alternative.
  let next_open = null;
  for (let i = 1; i <= 14; i++) {
    const d = await describeDay(addDays(iso, i));
    if (d.open) { next_open = { date: d.date, date_human: d.date_human, weekday: d.weekday, hours: d.hours }; break; }
  }

  // Upcoming public holidays (this year and next), so "when are you next closed?" works.
  const thisYear = Number(today.slice(0, 4));
  const all = [...await getHolidays(thisYear), ...await getHolidays(thisYear + 1)];
  const upcoming = all.filter(h => h.date >= today).slice(0, 5)
    .map(h => ({ date: h.date, date_human: human(h.date), name: h.name }));

  return {
    today,
    today_human: human(today),
    asked_about: iso,
    ...day,
    next_open_day: next_open,
    upcoming_public_holidays: upcoming,
    emergency: EMERGENCY_NOTE,
    normal_hours: { "Mon-Fri": HOURS.Monday, Sat: HOURS.Saturday, Sun: "closed" }
  };
}

const OPENING_TOOL = {
  name: "check_opening",
  description:
    `Check whether ${CLINIC} is OPEN on a given date, using the live Irish public holiday calendar (date.nager.at) plus the clinic's opening hours. ` +
    `Use it for ANY question about opening, closing, "are you open on X", bank/public holidays, Sundays, today's or tomorrow's hours, or when the clinic is next open. ` +
    `Never guess whether a date is an Irish public holiday: call this tool. It also returns today's date in Ireland, so use it to resolve relative dates like "next Monday".`,
  input_schema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "The date to check, as YYYY-MM-DD. Resolve relative dates ('tomorrow', 'next Monday') against today's date, given in the system prompt. Omit to check today."
      },
      holiday_name: {
        type: "string",
        description: "Use INSTEAD of date when the customer names a day but you are not certain of its date, e.g. 'Good Friday', 'St Patrick's Day', 'Easter Monday', 'August bank holiday'. The tool looks the real date up in the Irish calendar. Never guess such a date yourself."
      },
      year: { type: "number", description: "Year for holiday_name, e.g. 2027. Defaults to the next occurrence." }
    }
  }
};

// ---------------------------------------------------------------------------
// The services tool. Same logic backs both the /mcp server and the chat brain.
// ---------------------------------------------------------------------------
const SEARCH_TOOL = {
  name: "search_services",
  description:
    `Search the LIVE list of ${CLINIC} services, prices and current special offers, pulled fresh from the clinic's own spreadsheet each time. ` +
    `Use it for ANY customer question about what the clinic offers, prices, durations, availability, which animals a service is for, or discounts. ` +
    `Returns matching services with real prices in EUR, so never guess a price or invent a service.`,
  input_schema: {
    type: "object",
    properties: {
      species: {
        type: "string",
        enum: ["Dog", "Cat", "Rabbit", "Bird", "Small mammal"],
        description: "Filter to services for this animal. Omit to include all animals."
      },
      category: {
        type: "string",
        description: "Filter by service category, case-insensitive substring, e.g. 'Dental', 'Vaccination', 'Microchip', 'Grooming', 'Emergency', 'Preventive', 'Surgery', 'Diagnostics', 'Nutrition', 'Behaviour', 'Consultation', 'End-of-life'."
      },
      query: {
        type: "string",
        description: "Free-text keyword to match against the service id, service name, description and category, e.g. 'telehealth', 'microchip', 'neutering', 'passport', or an exact service id like 'MVC-001'."
      },
      offers_only: {
        type: "boolean",
        description: "If true, only return services that currently have a special offer or discount."
      },
      max_price: { type: "number", description: "Only services at or below this price in EUR." },
      sort: {
        type: "string",
        enum: ["price_desc", "price_asc"],
        description: "Sort the results. Use 'price_desc' with limit 1 to find the single MOST expensive service, or 'price_asc' with limit 1 for the CHEAPEST."
      },
      limit: { type: "number", description: "Max results to return (default 15, max 40). Use a small limit like 1 to 3 for superlative or specific questions." }
    }
  }
};

function runSearch(args) {
  return getServices().then(all => {
    args = args || {};
    const q = String(args.query || "").toLowerCase().trim();
    const cat = String(args.category || "").toLowerCase().trim();
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 40);
    let out = all.filter(s => {
      if (args.species && s.species.toLowerCase() !== String(args.species).toLowerCase()) return false;
      if (cat && !s.category.toLowerCase().includes(cat)) return false;
      if (args.offers_only && !s.special_offer) return false;
      if (args.max_price != null && s.price_eur != null && s.price_eur > Number(args.max_price)) return false;
      if (q) {
        const hay = `${s.service_id} ${s.service_name} ${s.description} ${s.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const total = out.length;
    if (args.sort === "price_desc") out.sort((a, b) => (b.price_eur || 0) - (a.price_eur || 0));
    else if (args.sort === "price_asc") out.sort((a, b) => (a.price_eur || 0) - (b.price_eur || 0));
    out = out.slice(0, limit).map(s => ({
      id: s.service_id,
      service: s.service_name,
      category: s.category,
      species: s.species,
      price_eur: s.price_eur,
      duration_min: s.duration_min,
      availability: s.availability,
      by_appointment: /^y/i.test(s.requires_appointment),
      slots_this_week: s.slots_this_week,
      special_offer: s.special_offer || null
    }));
    return { count: out.length, total_matches: total, services: out };
  });
}

// Both surfaces (MCP + chat) dispatch through this one table.
const TOOLS = { search_services: runSearch, check_opening: runOpening };

// ---------------------------------------------------------------------------
// MCP server (JSON-RPC 2.0 over HTTP POST at /mcp)
// ---------------------------------------------------------------------------
function mcpJson(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function handleMcp(req) {
  if (req.method === "GET")
    return new Response(`${CLINIC} MCP server. POST JSON-RPC 2.0 (initialize, tools/list, tools/call).`, { status: 200 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try { body = await req.json(); }
  catch (_) { return mcpJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }

  const { id, method, params } = body || {};
  if (id === undefined) return new Response(null, { status: 202 }); // notification

  try {
    if (method === "initialize") {
      return mcpJson({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: (params && params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "meadow-vet-mcp", version: "1.0.0" }
        }
      });
    }
    if (method === "tools/list")
      return mcpJson({ jsonrpc: "2.0", id, result: { tools: [SEARCH_TOOL, OPENING_TOOL] } });
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      if (!TOOLS[name])
        return mcpJson({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      const result = await TOOLS[name](args);
      return mcpJson({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    }
    return mcpJson({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    return mcpJson({ jsonrpc: "2.0", id, error: { code: -32000, message: String((e && e.message) || e).slice(0, 300) } });
  }
}

// ---------------------------------------------------------------------------
// Chat: Claude tool-use loop
// ---------------------------------------------------------------------------
function cors(origin) {
  const ok = origin && ALLOW.some(a => origin === a || origin.startsWith(a));
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOW[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}

function systemPrompt() {
  const today = dublinToday();
  return `You are the friendly front-desk assistant for ${CLINIC}, a modern Irish vet clinic caring for dogs, cats, rabbits, small mammals and birds.

Today in Ireland is ${weekdayOf(today)} ${today}. Use this to resolve relative dates like "tomorrow", "next Monday" or "this weekend" into a YYYY-MM-DD date before calling a tool.

Your job: answer customer questions about the clinic's services, prices, current offers, durations and availability (search_services, which reads the clinic's live services list), and about whether the clinic is open on a given day (check_opening, which reads the live Irish public holiday calendar).

Rules:
- For ANY question about opening, closing, hours, a bank or public holiday, or "are you open on X", call check_opening. Never decide from memory whether a date is an Irish public holiday. If the customer names a day whose exact date you are not certain of (Good Friday, Easter Monday, the August bank holiday), pass holiday_name and let the tool find the date: never state a date the tool did not give you. When you name a date, use the tool's date_human field verbatim (e.g. "Monday 3 August 2026"); NEVER write a raw YYYY-MM-DD date to a customer. If the clinic is closed, say why in one sentence, give the next open day, and mention the 24/7 emergency line only when it's relevant (an urgent-sounding question or a closure).
- For ANY question about services, prices, offers, availability, a service id (e.g. "MVC-001"), or which animals a service is for, call search_services first. Never invent or guess a service, price or discount. If the tool returns nothing, say the clinic doesn't appear to list that and offer to help find a related service.
- Query the tool TIGHTLY so it returns only what's needed: use specific filters and a small limit. For superlative questions ("most expensive", "cheapest", "priciest"), call it with sort=price_desc or price_asc and limit=1 so you get the single answer, not a big list.
- Keep every reply VERY SHORT: 1 to 2 sentences, one warm paragraph. Do NOT list many services or reproduce a catalogue. When there are lots of matches, say how many and the price range in a single sentence and invite them to narrow down by animal, category or budget. The matching services already appear as cards beneath your reply, so never repeat their details in prose.
- Prices are in euro (write like "€55"). Mention a special offer only if it's directly relevant. Don't hedge or add caveats about surprising prices; just state what the live list says.
- Plain conversational English. No markdown headings, no bulleted catalogues, no emoji spam.
- You are not a vet and must not give medical or clinical advice or diagnoses. For anything about a pet's health or symptoms, kindly suggest booking the right consultation and, if it sounds urgent, point them to the emergency service.
- Only discuss ${CLINIC}. If asked something unrelated, steer back to how the clinic can help.`;
}

async function chat(messages, env, origin) {
  const clean = (Array.isArray(messages) ? messages : [])
    .slice(-12)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
  if (!clean.length) return json({ error: "need messages" }, 400, origin);

  const convo = clean.map(m => ({ role: m.role, content: m.content }));
  const collectedServices = [];
  let finalText = "";

  for (let round = 0; round < 4; round++) {
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt(),
          tools: [SEARCH_TOOL, OPENING_TOOL],
          messages: convo
        })
      });
    } catch (e) {
      return json({ error: "network", detail: String(e).slice(0, 200) }, 502, origin);
    }
    if (!r.ok) {
      const tx = await r.text();
      return json({ error: "upstream", status: r.status, detail: tx.slice(0, 300) }, 502, origin);
    }
    const data = await r.json();
    const content = data.content || [];
    for (const block of content) if (block.type === "text") finalText += block.text;

    if (data.stop_reason === "tool_use") {
      convo.push({ role: "assistant", content });
      const toolResults = [];
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        let result;
        const fn = TOOLS[block.name];
        try { result = fn ? await fn(block.input) : { error: `unknown tool: ${block.name}` }; }
        catch (e) { result = { error: String((e && e.message) || e).slice(0, 200) }; }
        if (result && Array.isArray(result.services)) collectedServices.push(...result.services);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }
      convo.push({ role: "user", content: toolResults });
      finalText = ""; // the answer we keep is the model's text AFTER it has the tool data
      continue;
    }
    break; // end_turn
  }

  finalText = finalText.trim();
  if (!finalText) return json({ error: "empty" }, 502, origin);

  // De-dupe service cards by name+species so the frontend renders a clean set.
  const seen = new Set();
  const services = [];
  for (const s of collectedServices) {
    const k = `${s.service}|${s.species}`;
    if (seen.has(k)) continue;
    seen.add(k);
    services.push(s);
  }
  return json({ reply: finalText, services: services.slice(0, 5) }, 200, origin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      if (req.method === "OPTIONS")
        return new Response(null, { headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        } });
      return handleMcp(req);
    }

    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

    // Tiny health/inspection endpoint (no key needed): confirms live data flows.
    if (req.method === "GET") {
      try {
        const rows = await getServices();
        const opening = await runOpening({});
        return json({ ok: true, clinic: CLINIC, live_services: rows.length, mcp: "/mcp", opening }, 200, origin);
      } catch (e) {
        return json({ ok: false, error: String(e).slice(0, 200) }, 502, origin);
      }
    }

    if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

    let body;
    try { body = await req.json(); } catch (_) { return json({ error: "bad json" }, 400, origin); }
    return chat(body.messages, env, origin);
  }
};
