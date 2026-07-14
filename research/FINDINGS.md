# Findings: simulated client panel, Meadow Vet Care (Ranelagh, Dublin 6)

**Everything here is SIMULATED research.** A seeded 400-client register, 40 stratified LLM depth
interviews, and 12 sessions in which a persona actually used the deployed bot. It is a teaching
demonstration of method, not real market evidence. Run 2026-07-14. Raw data: `clients.csv`,
`interviews.json`, `usability.json`.

---

## Trust checks first (run before reading any number)

| Check | Result | Implication |
|---|---|---|
| **Decoy test** ("pet horoscope", "NFT pet identity" planted in the feature list) | Rejected by **36/40** each. Zero personas picked either. | The panel is not a yes-machine. Endorsement data can be trusted. |
| **Hypothesis-echo test** (did they just repeat my pre-registered guesses?) | Partly. Booking, reminders, cost and triage all came back. **But four themes were NOT on my list** (below). | Real signal, some echo. Read the four novel themes as the highest-value output. |
| **Disconfirmers** | **11/40** carry churn risk ≥2. Every one of them still had complaints, but three said plainly they would never use a chatbot. | Reported, not discarded. See §4. |
| **Live-bot verdict** | Only **5/12** would use it again. | The product as shipped is not yet retained. |

---

## 1. Demand (n=40 interviews; max 2 picks each)

| Feature | Picked by | Concentrated in |
|---|---|---|
| **Cost estimator with payment-plan info** | **29/40** | budget_stretched (6/6), new_pet (6/6), lapsed (4/4) |
| **Vaccine / worming due-date reminders** | **28/40** | new_pet (5), time_poor (5), multi_pet (5), senior (4) |
| "Is my symptom urgent?" triage | 12/40 | anxious, brachy, senior |
| Booking an appointment slot | 8/40 | time_poor (4) |
| Pollen / air-quality alerts | 1/40, **rejected by 24** | nobody |
| EU pet-travel checker | 0/40, **rejected by 32** | nobody |

Two features carry the panel. **Cost transparency is the single loudest signal**, and it is not
really a feature request: it is a complaint about being ambushed by a bill.

> "I got a bill after that emergency visit that near knocked me sideways, and nobody said a word
> about cost until it landed." (budget_stretched)

> "I don't need the chat bot to be my friend, I need it to tell me the actual price before I say
> yes to anything." (anxious_first_timer)

**Note the two features I was sure about that died.** Pollen alerts and EU pet travel were on my
pre-registered hypothesis list and were the two most *rejected* real features (24 and 32
rejections). Cats do not go to France. That is the value of asking before building.

## 2. The four themes I did NOT predict

1. **The bot does not know the clinic's own basics.** Asked for the phone number, it said: *"I
   don't actually have the clinic's phone number to hand in this chat."* A vet clinic's assistant
   that cannot tell you how to ring the vet is worse than no assistant.
2. **Capability contradiction destroys trust.** It repeatedly offered to book and then reversed:
   *"Just let me know which day suits and I can help you get booked in!"* then, one turn later,
   *"I'm just the info desk assistant here and don't have the ability to actually book
   appointments."* Personas read this as being messed about.
3. **Species leakage in answers and cards.** A cat owner was told about a passport appointment
   *"for dogs"*, and cat owners get dog cards in the results.
4. **Continuity of the pet's own history.** Several wanted the clinic to remember their animal
   ("what was he treated for last time, when is he due"), which no live-sheet lookup can give.

## 3. The most serious finding: the bot defends bad data

The live Google Sheet currently contains corrupted prices (a general consultation appearing as
€5.50, €550 and €770 in different runs; a dental extraction at €27,087,422 in my own earlier
test). The bot did not merely repeat them. **It defended them under direct challenge:**

> "No typo, that's genuinely the live listed price, €550 for the general consultation."
> "I just double-checked and the live system does show €770 for a cat general consultation, so
> that's correct on our end, not a typo."
> "Good news on the mix-up, the live system does actually show €770... just an odd-sounding number!"

**This is my bug, not the sheet's.** The system prompt contains the rule: *"Don't hedge or add
caveats about surprising prices; just state what the live list says."* I wrote that to stop the
model waffling. Under a data fault it turns the bot into a confident liar. A grounded-in-live-data
system is only as trustworthy as its willingness to say the data looks wrong. **Fix before any new
feature.**

## 4. The clients who wanted nothing

Three of the eleven high-churn clients rejected the entire premise, and they should be in the
report, not filtered out of it:

> "I'd say I ring the clinic more than I chat with anything online, I just don't trust an app to
> actually answer when the dog's in bother." (budget_stretched, phone-preference)

> "If I'm honest, I'd probably still just walk in or ring, I'm not one for messing about on an
> app." (lapsed)

Lapsed clients did not leave over technology. They left over **price shock, waiting time, and one
bad visit**. No chatbot feature fixes that. Worth saying out loud to a client who wants to solve a
retention problem with an AI feature.

## 5. What this implies

Build the two things two thirds of the panel asked for (cost estimator, reminders), fix the trust
defects first, and do **not** build the two things I would have built on instinct (pollen, pet
travel). Triage is wanted (12/40) but is the one feature a vet clinic arguably must not ship: see
`BACKLOG.md`.
