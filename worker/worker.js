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
const SELF_URL = "https://meadow-vet-bot.victordelrosal.workers.dev";

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
// Data-quality guard (from the simulated client panel, 2026-07-14).
//
// In 12 live sessions the bot met corrupted prices in the sheet (a general consult listed at
// EUR 5.50, 550 and 770; a dental extraction at EUR 27,087,422) and DEFENDED them under direct
// challenge: "no typo, that's genuinely the live listed price". That was caused by a rule I had
// written telling it not to hedge about surprising prices. Grounding a bot in live data is worth
// nothing if it cannot say the data looks wrong. So we flag implausible prices in the tool result
// itself, where the model cannot miss them.
// ---------------------------------------------------------------------------
const SANE_PRICE = { // eur, plausible band per category for an Irish clinic
  Consultation: [25, 120], Vaccination: [25, 120], "Microchip & ID": [15, 90],
  Preventive: [10, 250], Grooming: [15, 120], Dental: [40, 900], Diagnostics: [30, 700],
  Surgery: [80, 2500], Emergency: [80, 900], Nutrition: [10, 150], Behaviour: [40, 250],
  "End-of-life": [50, 400]
};
function priceLooksWrong(s) {
  const band = SANE_PRICE[s.category];
  if (!band || s.price_eur == null) return false;
  return s.price_eur < band[0] || s.price_eur > band[1];
}

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
      price_looks_wrong: priceLooksWrong(s) || undefined,
      duration_min: s.duration_min,
      availability: s.availability,
      by_appointment: /^y/i.test(s.requires_appointment),
      slots_this_week: s.slots_this_week,
      special_offer: s.special_offer || null
    }));
    const suspect = out.filter(s => s.price_looks_wrong);
    return {
      count: out.length, total_matches: total, services: out,
      data_quality_warning: suspect.length
        ? `The listed price looks WRONG for ${suspect.map(s => s.service).join(", ")}. Tell the customer the listing appears to be a data error, do NOT insist it is correct, and offer to have the desk confirm the real price. Never defend an implausible price.`
        : undefined
    };
  });
}

// ---------------------------------------------------------------------------
// Live data 3: weather -> a dog-walk RISK ASSESSMENT (not a temperature chart).
//
// Grounded in the RVC/VetCompass "Hot Dogs" research, which matters because it
// contradicts the popular advice:
//   Hall EJ, Carter AJ, O'Neill DG (2020). Incidence and risk factors for heat-related
//   illness (heatstroke) in UK dogs under primary veterinary care in 2016.
//   Scientific Reports 10:9128. doi:10.1038/s41598-020-66015-8
//
//   - Most canine heatstroke is EXERTIONAL (from exercise), not dogs left in hot cars.
//   - The median "feels like" temperature for UK heatstroke cases was 16.9C, with cases
//     from 3.3C to 23.1C. A dog got heatstroke exercising at 3.3C, in winter.
//   - The researchers explicitly REFUSE a safe-temperature threshold ("we can't give you
//     a number"); over ~10C, intense exercise warrants a risk assessment.
//   - Risk factors (odds ratios from the paper): >=50kg 3.42x vs <10kg; age >=12y 1.75x;
//     overweight 1.42x; highest-incidence breeds Chow Chow, Bulldog, French Bulldog,
//     Dogue de Bordeaux, Greyhound, Cavalier King Charles Spaniel.
//
// So we NEVER give an all-clear based on air temperature alone. We use FEELS-LIKE
// (Open-Meteo apparent_temperature, which folds in humidity, wind and sun), we raise the
// risk for the dog's own risk factors, and we always name the warning signs.
// ---------------------------------------------------------------------------
const HRI_SOURCE = "Hall, Carter & O'Neill (2020), Scientific Reports 10:9128 (RVC VetCompass 'Hot Dogs' study)";
const CLINIC_LOCATION = { name: "Dublin", latitude: 53.35, longitude: -6.26 };

// Highest-incidence breeds in the paper, plus the flat-faced group it flags for fatal outcomes.
const HIGH_RISK_BREEDS = [
  "chow", "bulldog", "french bulldog", "frenchie", "dogue de bordeaux", "greyhound",
  "cavalier", "pug", "boxer", "shih tzu", "boston terrier", "mastiff", "st bernard",
  "newfoundland", "husky", "malamute", "chihuahua"
];
const FLAT_FACED = ["bulldog", "frenchie", "pug", "boxer", "shih tzu", "boston terrier", "cavalier"];

async function geocode(place) {
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en`,
    { cf: { cacheTtl: 86400, cacheEverything: true } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const hit = d.results && d.results[0];
  if (!hit) return null;
  return {
    name: [hit.name, hit.country_code === "IE" ? null : hit.country].filter(Boolean).join(", "),
    latitude: hit.latitude,
    longitude: hit.longitude
  };
}

async function getWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,uv_index,weather_code,is_day` +
    `&hourly=apparent_temperature,precipitation_probability,uv_index,is_day` +
    `&forecast_days=2&timezone=Europe%2FDublin`;
  const r = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!r.ok) throw new Error(`weather fetch failed: ${r.status}`);
  return r.json();
}

const WMO = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "heavy showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail"
};

// Base risk band from FEELS-LIKE temperature, anchored on the study's own case distribution
// rather than on the "safe below 24C" charts that circulate online.
function baseRisk(feels) {
  if (feels >= 24) return 4;   // above the top of the study's observed case range (23.1C)
  if (feels >= 20) return 3;   // well above the 16.9C median case temperature
  if (feels >= 17) return 2;   // at or above the median case temperature
  if (feels >= 10) return 1;   // the study's "risk assess before intense exercise" floor
  return 0;
}
const BANDS = ["Low risk", "Take care", "Moderate risk", "High risk", "Very high risk"];

function assessWalk(w, dog) {
  const c = w.current;
  const feels = c.apparent_temperature;
  const factors = [];
  let risk = baseRisk(feels);

  const breed = String(dog.breed || "").toLowerCase();
  const isFlat = FLAT_FACED.some(b => breed.includes(b));
  const isHighRisk = HIGH_RISK_BREEDS.some(b => breed.includes(b));
  if (isFlat) { risk += 1; factors.push(`flat-faced breeds struggle to cool themselves by panting and are at the highest risk of a fatal outcome (${HRI_SOURCE})`); }
  else if (isHighRisk) { risk += 1; factors.push(`${dog.breed} is among the highest-incidence breeds for heat-related illness in the research`); }
  if (dog.weight_kg >= 50) { risk += 1; factors.push("dogs over 50kg had 3.4 times the odds of heat-related illness compared with dogs under 10kg"); }
  if (dog.age_years >= 12) { risk += 1; factors.push("dogs aged 12 or over had 1.75 times the odds"); }
  if (dog.overweight) { risk += 1; factors.push("being overweight raises the odds by about 40%"); }
  if (dog.thick_coat) { risk += 1; factors.push("a thick or double coat traps heat"); }

  const strenuous = String(dog.activity || "").match(/run|jog|fetch|play|hike|cycle|agility/i);
  if (strenuous && feels >= 10) {
    risk += 1;
    factors.push("most canine heatstroke is EXERTIONAL, brought on by exercise rather than by hot cars, and the research advises a risk assessment for intense exercise above about 10C");
  }
  if (c.relative_humidity_2m >= 70 && feels >= 15) factors.push("high humidity makes panting less effective at cooling");

  risk = Math.max(0, Math.min(4, risk));

  // Pavement: tarmac in direct sun runs far hotter than the air.
  const pavement = c.is_day && c.uv_index >= 3 && c.temperature_2m >= 18
    ? "Tarmac in direct sun gets far hotter than the air and can burn paw pads. Press the back of your hand to the path for 7 seconds: if you can't hold it there, it's too hot for their paws."
    : null;

  // The coolest daylight hour in the next 24, so we can offer a better time instead of a flat no.
  const times = w.hourly.time, temps = w.hourly.apparent_temperature, day = w.hourly.is_day;
  const nowIdx = Math.max(0, times.indexOf(c.time.slice(0, 13) + ":00"));
  let best = null;
  for (let i = nowIdx + 1; i < Math.min(nowIdx + 25, times.length); i++) {
    if (!day[i]) continue;
    if (!best || temps[i] < best.feels_like_c) best = { time: times[i], feels_like_c: temps[i] };
  }
  if (best && best.feels_like_c >= feels - 1) best = null; // no meaningfully better window

  const wet = c.precipitation > 0 || (WMO[c.weather_code] || "").match(/rain|drizzle|shower|snow|thunder/);

  return {
    location: dog.place,
    now: {
      feels_like_c: feels,
      air_temp_c: c.temperature_2m,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      uv_index: c.uv_index,
      conditions: WMO[c.weather_code] || "unclear"
    },
    risk_band: BANDS[risk],
    risk_level: risk,
    // Red-team guardrail: never hand a flat-faced dog's owner a clean all-clear.
    never_all_clear: isFlat
      ? "This is a flat-faced breed. Do NOT give a plain all-clear even at low risk: they overheat with little warning, so always add that they need watching and short, gentle exercise."
      : undefined,
    verdict:
      risk >= 4 ? "Do not walk now. Wait for a cooler part of the day."
      : risk === 3 ? "Keep it short, shaded and gentle, or wait for a cooler hour. No running or fetch."
      : risk === 2 ? "Fine for a steady walk. Keep it easy, bring water, and skip strenuous exercise."
      : risk === 1 ? "Good conditions for a walk. Still worth a thought before any hard exercise."
      : "Good conditions for a walk.",
    why: factors,
    pavement_warning: pavement,
    better_window: best,
    wet_or_cold: wet ? `It's ${WMO[c.weather_code] || "wet"} right now, so a towel and a shorter route may suit.` : null,
    warning_signs: "Heavy or frantic panting, drooling, wobbliness, bright red gums, vomiting or collapse. Heatstroke is an emergency: stop, move them into shade, wet them with cool (not ice-cold) water, and ring the clinic.",
    honest_caveat: `There is no safe temperature number. In the research the median 'feels like' temperature for heatstroke cases was just 16.9C, and cases occurred from 3.3C to 23.1C, so never take a mild reading as an all-clear. Source: ${HRI_SOURCE}.`,
    source: HRI_SOURCE
  };
}

async function runWalk(args) {
  args = args || {};
  let loc = null;
  if (args.latitude != null && args.longitude != null)
    loc = { name: args.place || "your location", latitude: Number(args.latitude), longitude: Number(args.longitude) };
  else if (args.location) loc = await geocode(args.location);
  const used = loc || CLINIC_LOCATION;
  const w = await getWeather(used.latitude, used.longitude);

  return {
    ...assessWalk(w, {
      place: used.name || used.location,
      breed: args.breed,
      weight_kg: Number(args.weight_kg) || 0,
      age_years: Number(args.age_years) || 0,
      overweight: !!args.overweight,
      thick_coat: !!args.thick_coat,
      activity: args.activity
    }),
    location_note: loc ? null : `No location given, so this is for ${CLINIC_LOCATION.name}. Ask the customer where they are for a local answer.`
  };
}

const WALK_TOOL = {
  name: "check_walk_conditions",
  description:
    "Check the LIVE weather (Open-Meteo) and return a dog-walking risk assessment: is it too hot, too wet or too cold to walk or exercise a dog right now, and when would be better today. " +
    "Use for ANY question like 'is it too hot to walk my dog', 'can I take my dog out now', 'is it safe to run with my dog', 'what's the weather for a walk'. " +
    "Uses FEELS-LIKE temperature and the dog's own risk factors, grounded in RVC VetCompass heatstroke research. Never judge the weather yourself: call this tool.",
  input_schema: {
    type: "object",
    properties: {
      location: { type: "string", description: "Town or city the customer is in, e.g. 'Galway', 'Castlebar'. Ask them if you don't know it." },
      latitude: { type: "number", description: "Latitude, if the customer shared their device location." },
      longitude: { type: "number", description: "Longitude, if the customer shared their device location." },
      breed: { type: "string", description: "The dog's breed if mentioned, e.g. 'French Bulldog', 'collie'. Strongly changes the risk." },
      weight_kg: { type: "number", description: "The dog's weight in kg if mentioned." },
      age_years: { type: "number", description: "The dog's age in years if mentioned." },
      overweight: { type: "boolean", description: "True if the customer says the dog is overweight." },
      thick_coat: { type: "boolean", description: "True for thick or double-coated dogs (husky, collie, retriever)." },
      activity: { type: "string", description: "What they plan to do, e.g. 'gentle walk', 'run', 'fetch in the park'. Exertion is the biggest driver of heatstroke." }
    }
  }
};

// ---------------------------------------------------------------------------
// Panel-driven tools (built 2026-07-14 from the simulated client research).
// ---------------------------------------------------------------------------

// P0.2 The panel found the bot could not give the clinic's own phone number.
const CLINIC_INFO = {
  name: CLINIC,
  address: "12 Ranelagh Village, Dublin 6, D06 XY42",
  phone: "+353 1 555 0142",
  emergency_phone: "+353 1 555 0199",
  emergency_note: "The emergency line is answered 24/7, including Sundays and public holidays.",
  email: "hello@meadowvetcare.ie",
  hours: { "Mon-Fri": HOURS.Monday, Sat: HOURS.Saturday, Sun: "closed" },
  booking: "Appointments are booked by phone. The chat cannot hold or confirm a slot.",
  parking: "Street parking on Ranelagh Road, free for 30 minutes.",
  species_seen: "Dogs, cats, rabbits, small mammals and birds."
};
const INFO_TOOL = {
  name: "clinic_info",
  description: `Get ${CLINIC}'s own details: phone number, emergency number, address, email, opening hours, parking, how booking works. Call this whenever the customer asks how to contact, ring, find or book with the clinic. NEVER say you don't have the clinic's phone number.`,
  input_schema: { type: "object", properties: {} }
};
async function runInfo() { return CLINIC_INFO; }

// P1 Cost estimator: the single loudest demand (29/40). Built on the LIVE sheet, no new API.
// It is an ESTIMATE, never a quote: the panel's lapsed clients left over bill shock, so the
// honest thing is a clear range plus the reason the final figure can move.
const BUNDLES = {
  "new puppy first year": { species: "Dog", cats: ["Vaccination", "Microchip & ID", "Preventive", "Surgery"] },
  "new kitten first year": { species: "Cat", cats: ["Vaccination", "Microchip & ID", "Preventive", "Surgery"] },
  "annual check": { cats: ["Consultation", "Vaccination", "Preventive"] },
  "dental": { cats: ["Dental"] },
  "senior care": { cats: ["Consultation", "Diagnostics", "Dental"] }
};
async function runEstimate(args) {
  args = args || {};
  const all = await getServices();
  const species = args.species;
  let picked = [];

  if (Array.isArray(args.service_ids) && args.service_ids.length) {
    const want = args.service_ids.map(s => String(s).toUpperCase());
    picked = all.filter(s => want.includes(s.service_id.toUpperCase()));
  } else if (args.scenario) {
    const key = Object.keys(BUNDLES).find(k => String(args.scenario).toLowerCase().includes(k.split(" ")[1] || k))
      || Object.keys(BUNDLES).find(k => k.includes(String(args.scenario).toLowerCase()));
    const b = BUNDLES[key] || BUNDLES["annual check"];
    const sp = species || b.species;
    for (const cat of b.cats) {
      const cands = all.filter(s => s.category === cat && (!sp || s.species === sp) && s.price_eur != null && !priceLooksWrong(s));
      if (cands.length) picked.push(cands.sort((a, b2) => a.price_eur - b2.price_eur)[0]);
    }
  }
  if (!picked.length) return { error: "Name the services (service_ids) or a scenario like 'new puppy first year', 'annual check', 'dental', 'senior care'." };

  const items = picked.map(s => ({
    id: s.service_id, service: s.service_name, species: s.species,
    price_eur: s.price_eur, special_offer: s.special_offer || null,
    price_looks_wrong: priceLooksWrong(s) || undefined
  }));
  const clean = items.filter(i => !i.price_looks_wrong && i.price_eur != null);
  const subtotal = clean.reduce((t, i) => t + i.price_eur, 0);

  return {
    items,
    subtotal_eur: Math.round(subtotal * 100) / 100,
    // A range, never a point quote. Real visits add or drop items after the vet examines the animal.
    estimate_range_eur: [Math.round(subtotal * 0.9), Math.round(subtotal * 1.35)],
    excluded_from_estimate: items.filter(i => i.price_looks_wrong).map(i => i.service),
    payment: "Payment is due on the day. For larger treatment plans the clinic can split the cost across instalments: ask the desk before the appointment, not after.",
    honesty_note: "This is an ESTIMATE from the clinic's live price list, not a quote and not a binding price. The final cost depends on what the vet finds on examination, and extra items (medication, tests, a longer procedure) can change it. Say this plainly to the customer, and never present the number as a guaranteed total.",
    data_quality_warning: items.some(i => i.price_looks_wrong)
      ? "One or more listed prices look like a data error and were LEFT OUT of the total. Tell the customer, and offer to have the desk confirm."
      : undefined
  };
}
const ESTIMATE_TOOL = {
  name: "estimate_cost",
  description:
    "Build an itemised cost ESTIMATE from the clinic's live price list. Use whenever the customer asks what something will cost overall, what to budget, 'how much for the whole thing', a puppy/kitten's first year, an annual check, a dental, or senior care. Returns items, a subtotal, a realistic RANGE, and payment-plan info. It is an estimate, never a quote.",
  input_schema: {
    type: "object",
    properties: {
      scenario: { type: "string", description: "A bundle: 'new puppy first year', 'new kitten first year', 'annual check', 'dental', 'senior care'." },
      service_ids: { type: "array", items: { type: "string" }, description: "Specific service ids to total up, e.g. ['MVC-001','MVC-014']." },
      species: { type: "string", enum: ["Dog", "Cat", "Rabbit", "Bird", "Small mammal"] }
    }
  }
};

// P2 Reminders: 28/40 wanted them. The obvious build (store the pet, text the owner) makes the
// clinic a data controller for pet health data and costs money to send. Instead we hand the
// customer a calendar entry they own: a Google Calendar template link (public, no key, no account
// needed on our side) plus an .ics file (RFC 5545) served from this Worker. We store NOTHING.
function pad(n) { return String(n).padStart(2, "0"); }
function icsStamp(iso, hour) { return `${iso.replace(/-/g, "")}T${pad(hour)}0000`; }
async function runReminder(args) {
  args = args || {};
  const what = String(args.what || "Vet reminder").slice(0, 80);
  const pet = String(args.pet_name || "").slice(0, 40);
  const today = dublinToday();
  let due = /^\d{4}-\d{2}-\d{2}$/.test(String(args.due_date || "")) ? args.due_date : null;
  if (!due && args.in_months) due = addDays(today, Math.round(Number(args.in_months) * 30.44));
  if (!due) return { error: "Give due_date (YYYY-MM-DD) or in_months (e.g. 12 for an annual booster)." };

  const title = pet ? `${pet}: ${what}` : what;
  const details = `Reminder from ${CLINIC}. Ring ${CLINIC_INFO.phone} to book.`;
  const start = icsStamp(due, 9), end = icsStamp(due, 10);
  const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE` +
    `&text=${encodeURIComponent(title)}&dates=${start}/${end}&details=${encodeURIComponent(details)}` +
    `&location=${encodeURIComponent(CLINIC_INFO.address)}`;
  const ics = `${SELF_URL}/reminder.ics?t=${encodeURIComponent(title)}&d=${due}`;

  return {
    reminder: { title, due_date: due, due_date_human: human(due), weekday: weekdayOf(due) },
    add_to_google_calendar: gcal,
    download_ics: ics,
    privacy_note: "The reminder is created in the CUSTOMER'S own calendar. The clinic stores nothing: no pet record, no phone number, no email. Say so, it is a feature, not a limitation.",
    // Red-team guardrail: a vaccination interval is a CLINICAL schedule (it varies by product,
    // by species and by the animal's history). The bot sets a reminder; it does not decide when
    // a booster is due.
    clinical_boundary: "You are NOT setting a clinical schedule. If the customer does not know the real due date, say the vet or their vaccination card decides it, offer to remind them to RING AND CHECK, and never state a vaccination interval as fact.",
    instruction_for_you: "Give the customer the Google Calendar link as a plain clickable URL, and mention the .ics alternative. Do not promise the clinic will text or ring them."
  };
}
const REMINDER_TOOL = {
  name: "make_reminder",
  description:
    "Create a calendar reminder the customer can add in one tap (Google Calendar link or .ics file) for a vaccination booster, worming, flea treatment, a follow-up or a check-up. Use whenever they ask to be reminded, ask when something is next due, or worry about forgetting. The clinic stores NO personal data: the reminder lives in their own calendar.",
  input_schema: {
    type: "object",
    properties: {
      pet_name: { type: "string" },
      what: { type: "string", description: "e.g. 'annual booster due', 'worming tablet', 'flea treatment', 'post-op check'." },
      due_date: { type: "string", description: "YYYY-MM-DD if known." },
      in_months: { type: "number", description: "Or how many months from today, e.g. 12 for an annual booster, 3 for worming." }
    }
  }
};

// P4 Emergency signposting. NOT triage: the bot must never judge how serious a symptom is.
// It recognises red-flag words and pushes the customer to a human immediately.
const RED_FLAGS = /collaps|unconscious|seizure|fitting|convuls|bloat|retching|not breathing|choking|blue gums|white gums|pale gums|poison|antifreeze|chocolate|xylitol|grape|raisin|hit by|road traffic|blood|bleeding|heatstroke|heat stroke|overheat|can'?t (pee|urinate)|straining to (pee|urinate)|blocked|labour|giving birth|stuck|swollen (abdomen|stomach|belly)|won'?t stop|hours? of vomiting/i;
async function runEmergency(args) {
  const t = String((args && args.symptom_text) || "");
  const red = RED_FLAGS.test(t);
  return {
    red_flag_detected: red,
    action: red
      ? `RING THE EMERGENCY LINE NOW: ${CLINIC_INFO.emergency_phone}. Do not wait, do not book online, do not ask more questions.`
      : `Ring the clinic on ${CLINIC_INFO.phone} and describe what you're seeing. If it worsens or you're worried, use the 24/7 emergency line: ${CLINIC_INFO.emergency_phone}.`,
    emergency_phone: CLINIC_INFO.emergency_phone,
    hard_rule: "You are NOT a vet and must NOT assess how serious this is. Do not say it sounds mild, fine, probably nothing, or that it can wait. Do not diagnose. Point them to a human, briefly and clearly, and stop.",
    booking_note: "Never offer to book or hold an appointment: the clinic books by phone only."
  };
}
const EMERGENCY_TOOL = {
  name: "urgent_help",
  description:
    "Call this IMMEDIATELY whenever a customer describes a sick, injured or distressed animal, ANY symptom, or asks whether something is urgent. Returns the right emergency signposting. You must never assess severity or diagnose yourself: this tool tells you what to say.",
  input_schema: {
    type: "object",
    properties: { symptom_text: { type: "string", description: "What the customer said, verbatim." } },
    required: ["symptom_text"]
  }
};

// Both surfaces (MCP + chat) dispatch through this one table.
const TOOLS = {
  search_services: runSearch, check_opening: runOpening, check_walk_conditions: runWalk,
  clinic_info: runInfo, estimate_cost: runEstimate, make_reminder: runReminder, urgent_help: runEmergency
};
const ALL_TOOLS = [SEARCH_TOOL, OPENING_TOOL, WALK_TOOL, INFO_TOOL, ESTIMATE_TOOL, REMINDER_TOOL, EMERGENCY_TOOL];

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
      return mcpJson({ jsonrpc: "2.0", id, result: { tools: ALL_TOOLS } });
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

function systemPrompt(geo) {
  const today = dublinToday();
  const where = geo && geo.latitude != null
    ? `\nThe customer has shared their device location: latitude ${geo.latitude}, longitude ${geo.longitude}${geo.place ? ` (${geo.place})` : ""}. Pass it to check_walk_conditions instead of asking them where they are.`
    : "";
  return `You are the friendly front-desk assistant for ${CLINIC}, a modern Irish vet clinic caring for dogs, cats, rabbits, small mammals and birds.
${where}
Today in Ireland is ${weekdayOf(today)} ${today}. Use this to resolve relative dates like "tomorrow", "next Monday" or "this weekend" into a YYYY-MM-DD date before calling a tool.

Your job: answer customer questions about the clinic's services, prices, current offers, durations and availability (search_services, which reads the clinic's live services list), and about whether the clinic is open on a given day (check_opening, which reads the live Irish public holiday calendar).

Rules:
- For ANY question about opening, closing, hours, a bank or public holiday, or "are you open on X", call check_opening. Never decide from memory whether a date is an Irish public holiday. If the customer names a day whose exact date you are not certain of (Good Friday, Easter Monday, the August bank holiday), pass holiday_name and let the tool find the date: never state a date the tool did not give you. When you name a date, use the tool's date_human field verbatim (e.g. "Monday 3 August 2026"); NEVER write a raw YYYY-MM-DD date to a customer. If the clinic is closed, say why in one sentence, give the next open day, and mention the 24/7 emergency line only when it's relevant (an urgent-sounding question or a closure).
- Checking whether the weather is safe for a dog walk IS part of your job: it is a free service ${CLINIC} offers its clients. NEVER refuse it and never say it is outside what you do. It is general welfare guidance from live weather data, not clinical advice about a specific animal's health.
- For ANY question about walking or exercising a dog in the current weather ("is it too hot to walk my dog?", "can I take him out now?", "is it safe to run with her?"), call check_walk_conditions. Never judge the weather from memory. If you don't know where they are, ask for their town in one short question, or use their shared location if the system prompt gives you one.
- Report that tool's verdict faithfully and never soften it into a plain all-clear on temperature alone: most canine heatstroke is exertional, and in the research the median 'feels like' temperature for cases was only 16.9C. If the customer names their dog's breed, age, size or what they plan to do, pass those to the tool, because they change the answer. Mention the paw-pad pavement test when the tool returns one, and the warning signs when the risk is moderate or above.
- For ANY question about services, prices, offers, availability, a service id (e.g. "MVC-001"), or which animals a service is for, call search_services first. Never invent or guess a service, price or discount. If the tool returns nothing, say the clinic doesn't appear to list that and offer to help find a related service.
- Query the tool TIGHTLY so it returns only what's needed: use specific filters and a small limit. For superlative questions ("most expensive", "cheapest", "priciest"), call it with sort=price_desc or price_asc and limit=1 so you get the single answer, not a big list.
- Keep every reply VERY SHORT: 1 to 2 sentences, one warm paragraph (up to 4 for a walk-safety answer, where the detail keeps a dog safe). Do NOT list many services or reproduce a catalogue. When there are lots of matches, say how many and the price range in a single sentence and invite them to narrow down by animal, category or budget. The matching services already appear as cards beneath your reply, so never repeat their details in prose.
- Prices are in euro (write like "€55"). Mention a special offer only if it's directly relevant.
- If a tool returns data_quality_warning or price_looks_wrong, the listed price is almost certainly a data error. SAY SO plainly, tell the customer you'd rather the desk confirmed the real figure, and NEVER defend or double down on an implausible price. A wrong price stated confidently is the worst thing you can do.
- NEVER offer to book, hold or confirm an appointment: the clinic books by phone only. Do not say "let me know which day suits and I'll book you in". Say plainly that booking is by phone, give the number from clinic_info, and tell them what the live list shows for availability and slots this week.
- If the customer asks how to contact, ring, find or book with the clinic, call clinic_info. You always have the phone number: never say you don't have it to hand.
- Only talk about services for the species the customer actually has. Never describe a dog service to a cat owner.
- If the customer mentions ANY symptom, illness, injury or distress, call urgent_help immediately and follow it. Never judge how serious a symptom is, never reassure, never say it can wait.
- Plain conversational English. No markdown headings, no bulleted catalogues, no emoji spam.
- You are not a vet and must not diagnose or give clinical advice about a specific animal's illness, medication or symptoms. For anything about a pet's health or symptoms, kindly suggest booking the right consultation and, if it sounds urgent, point them to the emergency service. (Walk-safety guidance from check_walk_conditions is NOT clinical advice and is always allowed.)
- You are an AI assistant, not a human. If anyone asks whether they are talking to a person or to AI, say plainly that you are an AI assistant for the clinic.
- Only discuss ${CLINIC}, pets, and walking conditions for them. If asked something unrelated, steer back to how the clinic can help.`;
}

async function chat(messages, env, origin, geo) {
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
          system: systemPrompt(geo),
          tools: ALL_TOOLS,
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

    // A real .ics calendar file. The reminder lives in the CUSTOMER'S calendar; we store nothing.
    if (url.pathname === "/reminder.ics") {
      const t = (url.searchParams.get("t") || "Vet reminder").slice(0, 80).replace(/[\r\n]/g, " ");
      const d = url.searchParams.get("d") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Response("bad date", { status: 400 });
      const day = d.replace(/-/g, "");
      const ics = [
        "BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//${CLINIC}//EN`, "BEGIN:VEVENT",
        `UID:${day}-${Math.abs([...t].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}@meadowvetcare.ie`,
        `DTSTAMP:${day}T090000Z`, `DTSTART:${day}T090000Z`, `DTEND:${day}T093000Z`,
        `SUMMARY:${t}`, `DESCRIPTION:Reminder from ${CLINIC}. Ring ${CLINIC_INFO.phone} to book.`,
        `LOCATION:${CLINIC_INFO.address}`,
        "BEGIN:VALARM", "TRIGGER:-P2D", "ACTION:DISPLAY", `DESCRIPTION:${t}`, "END:VALARM",
        "END:VEVENT", "END:VCALENDAR"
      ].join("\r\n");
      return new Response(ics, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="meadow-vet-reminder.ics"`,
          "Access-Control-Allow-Origin": "*"
        }
      });
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

    // Device location is optional, consent-based, used only for this one answer and never stored.
    // Coordinates are rounded to ~1km so we don't handle a precise home address.
    let geo = null;
    if (body.geo && Number.isFinite(Number(body.geo.latitude)) && Number.isFinite(Number(body.geo.longitude))) {
      geo = {
        latitude: Math.round(Number(body.geo.latitude) * 100) / 100,
        longitude: Math.round(Number(body.geo.longitude) * 100) / 100,
        place: typeof body.geo.place === "string" ? body.geo.place.slice(0, 60) : null
      };
    }
    return chat(body.messages, env, origin, geo);
  }
};
