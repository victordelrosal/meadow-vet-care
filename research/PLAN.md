# Simulated market research: Meadow Vet Care client panel

Status: PLANNED, not yet executed. Written 2026-07-14 for execution in a follow-on session.
Goal: decide which MCP/API features to build next, driven by simulated client demand rather than by what is easy to build.

Everything below is SIMULATION. Outputs must always be labelled as simulated research, never presented as real market evidence. It is a teaching demonstration of method.

---

## 1. Fixed decisions (do not relitigate at execution time)

- **Clinic location: Ranelagh, Dublin 6.** Dense, dog-heavy, walkable urban village with a wide socioeconomic spread within 3km: Rathmines, Rathgar, Harold's Cross, Donnybrook, Milltown, Clonskeagh, Terenure, Portobello. Supports realistic variety (young renters with rescue dogs, families, retirees, students) without straining plausibility.
- **Population: 400 clients on the register, active over the last 2 years.** We do NOT run 400 LLM interviews. The 400 exist as a generated dataset; depth comes from a stratified interview sample.
- **Species mix is anchored to the real live sheet** (verified 2026-07-14: 94 services; Dog 47, Cat 31, Rabbit 12, Bird 2, Small mammal 2). Client mix: ~55% dog households, ~30% cat, ~9% rabbit, ~6% birds/small mammals/multi-species. Roughly 15% own more than one species.
- **Feature outputs must be MCP-shaped**: each recommended feature must be implementable as a Worker tool over a public API, the existing Google Sheet, or a new sheet tab. A feature with no feasible API behind it goes to a "parked" list, not the backlog.

## 2. Architecture: three layers, increasing depth

### Layer A: the client register (script, zero LLM cost)
A deterministic, seeded Python script generates `research/clients.csv`: 400 rows.
Columns: client_id, neighbourhood, owner_age_band, household (single/couple/family/shared), tech_comfort (low/med/high), budget_sensitivity (low/med/high), species[], pets (breed/age incl. brachycephalic and senior flags), services_used (sampled from the REAL 94 service ids, weighted by category plausibility), visits_last_2y, last_visit, channel_preference (phone/walk-in/web), satisfaction_prior (1-5), segment (see below).

Segments (quota, roughly): new-puppy/kitten owners 15%, senior-pet owners 15%, brachy/high-risk-breed owners 10%, multi-pet households 12%, budget-stretched 15%, time-poor professionals 15%, anxious first-timers 8%, lapsed clients (no visit in 12m+) 10%.

The register is what makes claims like "23% of clients asked about X" honest within the simulation: percentages are computed against these 400 rows, not invented.

### Layer B: depth interviews (the core spend: ~40 agents)
Stratified sample of 40 clients from the register, quotas matching the segments above (lapsed clients and skeptics deliberately included as disconfirmers). One subagent per interviewee, run via the Workflow tool in parallel batches, each returning a schema-forced JSON:

- persona is given ONLY their register row + a one-paragraph life sketch derived from it; they are told to be a real, busy, sometimes grumpy Dubliner, not a focus-group pleaser
- interview script (open questions FIRST, no feature menu):
  1. Walk me through your last three interactions with the clinic. What was annoying?
  2. What do you do today in the 24h BEFORE a visit? After?
  3. What pet-care jobs do you handle elsewhere (apps, Google, WhatsApp, phone calls) that the clinic doesn't help with?
  4. You have the clinic's chat assistant (describe what it can already do: live prices/services, holiday opening, walk-safety). What would make you actually open it monthly?
  5. Only NOW show the seeded candidate list (see §4) mixed with 2 decoy features; ask them to pick max 2, reject at least 2, and say what they'd stop using.
- output schema: {likes[], dislikes[], jobs_to_be_done[], feature_requests[] (verbatim + normalised tag), picks[], rejections[], quotes[], churn_risk 0-3}

### Layer C: live usability sessions (12 agents, the differentiator)
12 of the 40 personas actually USE the deployed bot: the agent POSTs their persona's real questions to `https://meadow-vet-bot.victordelrosal.workers.dev/` (curl, multi-turn, in persona) and reports friction from the REAL transcripts: wrong/odd answers, missing abilities, tone problems, dead ends. This grounds the research in the product as it actually behaves today. Keep each session to ≤6 turns.

## 3. Bias controls (pre-registered)

- My own hypotheses, written down BEFORE execution so echo can be detected: appointment booking, vaccination/parasite reminders, prescription refills, pollen/air-quality alerts for allergic pets, pet travel-document requirements (EU pet passport), cost estimates/payment plans, out-of-hours triage. If the panel returns exactly this list and nothing else, the simulation collapsed into my prior: say so in the findings.
- Two decoy features in the §4 list (deliberately weak, e.g. "pet horoscope", "NFT pet ID"). If personas endorse decoys, that batch's endorsements are marked low-trust.
- Disconfirmer quota: ≥10 of 40 interviewees are lapsed, budget-stretched or explicitly satisfied-with-phoning. Their "I wouldn't use any of this" answers are reported, not discarded.
- Percentages only ever cite the register (n=400) or the sample (n=40), explicitly.

## 4. Seeded candidate list (shown only at interview step 5)

Booking an appointment slot · vaccine/worming due-date reminders · prescription refill requests · "is my symptom urgent?" triage guidance · pollen & air-quality alerts for allergic pets · EU pet-travel requirements checker · cost estimator with payment-plan info · lost-pet microchip checklist · pet weight/food portion calculator · pet horoscope (DECOY) · NFT pet identity (DECOY) · [+ anything Layer C surfaces before interviews run, appended at execution time]

## 5. Analysis & synthesis (2 agents + main loop)

1. Affinity-cluster all feature_requests + friction reports into named themes; count demand by segment, weight to the register.
2. Feasibility gate per theme: name a concrete, free/public API or data source and the MCP tool shape; verify the API actually responds (curl) BEFORE it may appear in the backlog. Candidates to check at execution time: Google Calendar/sheet-based slots (booking), HSE/Met pollen feeds vs Open-Meteo air-quality endpoint (verified pattern already), TRACES/DAFM pages for pet travel (may be scrape-only: if so, park it), sheet tab for refills/reminders.
3. Score = demand × feasibility × classroom-demo value. Output top 3-5.
4. Red-team pass (one adversarial agent): attack the top features for privacy, clinical-advice creep (triage!), EU AI Act implications, and "would a real clinic get sued/embarrassed".

## 6. Deliverables

```
research/
  PLAN.md            (this file)
  clients.csv        (Layer A, 400 rows, seeded + reproducible)
  interviews.json    (Layer B raw, 40 records)
  usability.json     (Layer C raw, 12 session reports)
  FINDINGS.md        (themes, counts, quotes, disconfirmers, decoy check, hypothesis-echo check)
  BACKLOG.md         (top features, each with: demand evidence, named verified API, MCP tool sketch, risk notes)
```

Then, per the class brief, implement the top features as new Worker tools and keep iterating.

## 7. Execution notes for the next session

- Use the Workflow tool: Layer B as one pipeline (40 agents, schema-forced), Layer C as a parallel batch of 12, then synthesis. Layer A is a plain script first: interviews must sample from the REAL csv.
- Interview agents need no repo access; give each its register row + interview script + output schema in the prompt. Layer C agents need only the Worker URL.
- Rough scale: ~55 subagents total. Keep interview outputs terse (schema, quotes ≤3) so synthesis fits in one context.
- Guard: the bot has a live Anthropic key behind it; Layer C is 12 sessions × ≤6 turns ≈ ≤72 real model calls. Fine. Do not point 400 agents at it.
- Everything committed and pushed as it lands (deploy-as-you-go applies).
