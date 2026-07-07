// Meadow Vet Care — live chatbot backend.
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
// The one tool. Same logic backs both the /mcp server and the chat brain.
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
        description: "Free-text keyword to match against the service name, description and category, e.g. 'telehealth', 'microchip', 'neutering', 'passport'."
      },
      offers_only: {
        type: "boolean",
        description: "If true, only return services that currently have a special offer or discount."
      },
      max_price: { type: "number", description: "Only services at or below this price in EUR." },
      limit: { type: "number", description: "Max results to return (default 15, max 40)." }
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
        const hay = `${s.service_name} ${s.description} ${s.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const total = out.length;
    out = out.slice(0, limit).map(s => ({
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
      return mcpJson({ jsonrpc: "2.0", id, result: { tools: [SEARCH_TOOL] } });
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      if (name !== "search_services")
        return mcpJson({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      const result = await runSearch(args);
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

const SYSTEM = `You are the friendly front-desk assistant for ${CLINIC}, a modern Irish vet clinic caring for dogs, cats, rabbits, small mammals and birds.

Your job: answer customer questions about the clinic's services, prices, current offers, durations and availability, using ONLY the search_services tool, which reads the clinic's live services list.

Rules:
- For ANY question about services, prices, offers, availability or which animals a service is for, call search_services first. Never invent or guess a service, price or discount. If the tool returns nothing, say the clinic doesn't appear to list that and offer to help find a related service.
- Prices are in euro (write like "€55"). If a service has a special_offer, mention it. If slots_this_week is 0, gently note it's currently fully booked this week but they can still enquire.
- Keep replies warm, concise and in plain conversational English. Short paragraphs or a short bulleted list. No markdown headings, no emoji spam.
- You are not a vet and must not give medical or clinical advice or diagnoses. For anything about a pet's health or symptoms, kindly suggest booking the right consultation and, if it sounds urgent, point them to the emergency service.
- Only discuss ${CLINIC}. If asked something unrelated, steer back to how the clinic can help.`;

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
          system: SYSTEM,
          tools: [SEARCH_TOOL],
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
        try { result = await runSearch(block.input); }
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
  return json({ reply: finalText, services: services.slice(0, 12) }, 200, origin);
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
        return json({ ok: true, clinic: CLINIC, live_services: rows.length, mcp: "/mcp" }, 200, origin);
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
