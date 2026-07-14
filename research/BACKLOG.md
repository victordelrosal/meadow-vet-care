# Backlog, feasibility-gated

Every item names a data source that was actually checked. Nothing here rests on an invented API.
Ranked by (panel demand x feasibility x demo value). Source: `FINDINGS.md`.

## P0. Fix the trust defects (no new API needed)

These came out of the 12 live sessions. They are bugs in what is already deployed, and no new
feature should ship on top of them.

1. **Stop defending bad data.** Kill the system-prompt rule "don't hedge about surprising prices".
   Add a plausibility check in the Worker: any price outside a sane band for its category is
   flagged to the model as `price_looks_wrong: true`, and the bot must say the listing looks
   incorrect and offer to have the desk confirm, rather than insisting €770 is real.
2. **Know the clinic's own basics.** New `clinic_info` tool: phone, address, email, emergency
   line, parking, hours. Source: a constant in the Worker (a real clinic would use a sheet tab).
3. **Never offer what it cannot do.** One honest capability statement in the prompt. It must not
   say "let me know which day suits and I'll book you in" and then reverse.
4. **Species correctness.** Filter cards to the species under discussion; never describe a
   dog-only service to a cat owner.

## P1. Cost estimator (picked by 29/40, the loudest signal)

- **Demand:** budget_stretched 6/6, new_pet 6/6, lapsed 4/4. The lapsed clients' stated reason for
  leaving was bill shock, not care quality.
- **Data source:** the existing **live Google Sheet** (`price_eur`, `duration_min`, `special_offer`).
  No new API. Verified: 94 rows, real prices.
- **Tool sketch:** `estimate_cost({ scenario | service_ids[], species })` returns an itemised list,
  a subtotal, any active offers applied, and a clearly-labelled **range, not a quote**, plus a
  plain statement that the final cost depends on the vet's examination. Pairs typical bundles
  (e.g. "new puppy first year" = vaccination course + microchip + neuter + parasite plan).
- **Risk:** must never read as a binding quote. Language gate in the prompt.

## P2. Vaccination / worming reminders (picked by 28/40)

- **Demand:** spread evenly across every segment except lapsed.
- **Data source:** **no backend, no storage, no personal data.** Generate a standards-compliant
  **ICS (RFC 5545) calendar file** served from a new Worker route, plus a **Google Calendar
  template URL** (`calendar.google.com/calendar/render?action=TEMPLATE&...`, verified: HTTP 200,
  no key, no account needed on our side). The reminder lives in **the client's own calendar**.
- **Why this shape:** the obvious build (store pet records and send SMS) creates a GDPR liability,
  a data controller obligation and a messaging cost. Handing the client an .ics gives the same
  outcome with zero personal data retained. This is the interesting engineering decision in the
  whole backlog.
- **Tool sketch:** `make_reminder({ pet_name, what, due_date | interval })` returns a one-tap
  calendar link and an .ics download.

## P3. Booking, honestly (picked by 8/40, but the loudest usability failure)

- The clinic has **no booking backend**, so the bot must not pretend. Ship the honest version:
  surface real `slots_this_week` and `availability` from the sheet, state plainly that booking is
  by phone, and give a **tappable `tel:` link**. Revisit only if a real booking API exists.
- **Parked, not built:** actual slot reservation. No API. Saying so is the point.

## P4. Emergency signposting (the guardrailed answer to "triage", picked by 12/40)

- **DO NOT BUILD symptom triage.** A vet clinic's public AI telling an owner their pet's symptom
  is or is not urgent is clinical advice without a vet: exposure under the Veterinary Council of
  Ireland's regime and the Animal Health and Welfare Act 2013, and a foreseeable route to a dead
  animal and a lawsuit. The demand is real; the feature is not safe as asked.
- **Build instead:** a red-flag **signposting** tool. Recognised emergency words (collapse,
  bloat/retching, seizure, heatstroke, poisoning, blocked cat urinating, dystocia) trigger an
  immediate, unmissable "ring the emergency line now" response with the number, no assessment, no
  reassurance, and no attempt to decide severity. It never says "that sounds fine".

## Rejected on the panel's evidence (do not build)

- **Pollen / air-quality alerts:** rejected by 24/40, picked by 1. I had pre-registered this as a
  likely winner. It was not.
- **EU pet-travel checker:** rejected by 32/40, picked by 0. Also: the authoritative Irish source
  (DAFM) has no public JSON API, so it would have been scrape-only anyway. Parked on both counts.
- **Pet horoscope, NFT pet identity:** decoys. Rejected 36/40 each, as designed.
