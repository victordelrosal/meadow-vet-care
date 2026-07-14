#!/usr/bin/env python3
"""Layer A: generate the simulated 400-client register for Meadow Vet Care (Ranelagh, Dublin 6).

Deterministic (seeded), reproducible, and anchored to the REAL services sheet: every service a
client has used is a real service_id from the clinic's live list. No LLM calls here.
"""
import csv, json, random, io, sys
from collections import Counter

SEED = 20260714
random.seed(SEED)
N = 400

SERVICES = list(csv.DictReader(open("research/services_snapshot.csv")))
BY_SPECIES = {}
for s in SERVICES:
    BY_SPECIES.setdefault(s["species"], []).append(s)

# 3km catchment of Ranelagh, weighted by rough residential density/proximity.
HOODS = [("Ranelagh", 18), ("Rathmines", 16), ("Rathgar", 11), ("Harold's Cross", 10),
         ("Portobello", 9), ("Donnybrook", 9), ("Terenure", 8), ("Milltown", 7),
         ("Clonskeagh", 6), ("Dartry", 6)]

SEGMENTS = [("new_pet", 60), ("senior_pet", 60), ("brachy_highrisk", 40), ("multi_pet", 48),
            ("budget_stretched", 60), ("time_poor_professional", 60), ("anxious_first_timer", 32),
            ("lapsed", 40)]

DOG_BREEDS = ["Labrador", "Cocker Spaniel", "Border Collie", "Jack Russell", "Cavapoo", "Beagle",
              "Springer Spaniel", "Golden Retriever", "Rescue crossbreed", "Terrier cross", "Greyhound (retired)"]
BRACHY = ["French Bulldog", "Pug", "Bulldog", "Boxer", "Shih Tzu", "Cavalier King Charles Spaniel"]
CAT_BREEDS = ["Domestic shorthair", "Domestic longhair", "Rescue moggy", "British Shorthair", "Maine Coon", "Ragdoll"]
RABBIT_BREEDS = ["Netherland Dwarf", "Lionhead", "Mini Lop", "Rescue rabbit"]
BIRD_BREEDS = ["Budgie", "Cockatiel", "Canary"]
SMALL_BREEDS = ["Guinea pig", "Hamster", "Ferret"]

def wpick(pairs):
    vals, ws = zip(*pairs)
    return random.choices(vals, weights=ws)[0]

def pick_species(seg):
    if seg == "brachy_highrisk":
        return ["Dog"]
    r = random.random()
    if seg == "multi_pet":
        base = random.sample(["Dog", "Cat", "Rabbit"], 2)
        return base
    if r < 0.55: return ["Dog"]
    if r < 0.85: return ["Cat"]
    if r < 0.94: return ["Rabbit"]
    if r < 0.97: return ["Bird"]
    return ["Small mammal"]

def make_pet(sp, seg):
    if sp == "Dog":
        breed = random.choice(BRACHY) if seg == "brachy_highrisk" else random.choice(DOG_BREEDS)
    elif sp == "Cat": breed = random.choice(CAT_BREEDS)
    elif sp == "Rabbit": breed = random.choice(RABBIT_BREEDS)
    elif sp == "Bird": breed = random.choice(BIRD_BREEDS)
    else: breed = random.choice(SMALL_BREEDS)
    if seg == "new_pet": age = round(random.uniform(0.2, 1.4), 1)
    elif seg == "senior_pet": age = round(random.uniform(9, 16), 1)
    else: age = round(random.uniform(1, 11), 1)
    senior = age >= 9 if sp in ("Dog", "Cat") else age >= 6
    return {"species": sp, "breed": breed, "age_years": age,
            "brachycephalic": breed in BRACHY, "senior": senior}

# Service categories a segment plausibly consumes, weighted.
SEG_CATS = {
    "new_pet": [("Vaccination", 5), ("Microchip & ID", 4), ("Consultation", 4), ("Preventive", 3), ("Surgery", 2), ("Nutrition", 2), ("Behaviour", 2)],
    "senior_pet": [("Consultation", 5), ("Diagnostics", 4), ("Dental", 3), ("Preventive", 3), ("End-of-life", 1), ("Nutrition", 2)],
    "brachy_highrisk": [("Consultation", 4), ("Surgery", 3), ("Diagnostics", 3), ("Emergency", 2), ("Preventive", 3), ("Dental", 2)],
    "multi_pet": [("Preventive", 5), ("Vaccination", 4), ("Consultation", 3), ("Grooming", 3), ("Dental", 2)],
    "budget_stretched": [("Consultation", 4), ("Vaccination", 3), ("Preventive", 3), ("Emergency", 1)],
    "time_poor_professional": [("Consultation", 4), ("Grooming", 4), ("Vaccination", 3), ("Preventive", 3), ("Dental", 2)],
    "anxious_first_timer": [("Consultation", 5), ("Vaccination", 3), ("Behaviour", 3), ("Preventive", 2)],
    "lapsed": [("Consultation", 3), ("Vaccination", 2), ("Preventive", 1)],
}

def pick_services(seg, species, n):
    pool_cats = SEG_CATS[seg]
    out = []
    for _ in range(n * 2):
        cat = wpick(pool_cats)
        cands = [s for s in SERVICES if s["category"] == cat and s["species"] in species]
        if not cands:
            cands = [s for s in SERVICES if s["species"] in species]
        if cands:
            out.append(random.choice(cands)["service_id"])
    seen, uniq = set(), []
    for s in out:
        if s not in seen:
            seen.add(s); uniq.append(s)
    return uniq[:n]

rows = []
seg_pool = []
for seg, count in SEGMENTS:
    seg_pool += [seg] * count
assert len(seg_pool) == N, len(seg_pool)
random.shuffle(seg_pool)

for i, seg in enumerate(seg_pool, 1):
    species = pick_species(seg)
    pets = [make_pet(sp, seg) for sp in species]
    if seg == "multi_pet" and random.random() < 0.4:
        pets.append(make_pet(random.choice(species), seg))

    if seg == "lapsed":
        visits = random.randint(1, 3)
        last = random.choice(["2025-02", "2025-04", "2025-06", "2024-11", "2025-01"])
    elif seg == "new_pet":
        visits = random.randint(2, 6); last = random.choice(["2026-05", "2026-06", "2026-07"])
    elif seg in ("senior_pet", "brachy_highrisk"):
        visits = random.randint(4, 12); last = random.choice(["2026-05", "2026-06", "2026-07"])
    else:
        visits = random.randint(2, 8); last = random.choice(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07"])

    sat = {"lapsed": wpick([(2, 4), (3, 4), (4, 2)]),
           "budget_stretched": wpick([(2, 2), (3, 5), (4, 3)]),
           "anxious_first_timer": wpick([(3, 3), (4, 5), (5, 2)])}.get(seg, wpick([(3, 2), (4, 5), (5, 3)]))

    rows.append({
        "client_id": f"MVC-C{i:03d}",
        "segment": seg,
        "neighbourhood": wpick(HOODS),
        "owner_age_band": wpick([("18-29", 2), ("30-44", 5), ("45-59", 3), ("60+", 2)]),
        "household": wpick([("single", 3), ("couple", 3), ("family_with_kids", 3), ("shared_house", 1)]),
        "tech_comfort": wpick([("low", 2), ("medium", 5), ("high", 3)]),
        "budget_sensitivity": "high" if seg == "budget_stretched" else wpick([("low", 3), ("medium", 4), ("high", 3)]),
        "channel_preference": wpick([("phone", 4), ("walk-in", 2), ("web", 4)]),
        "pets": json.dumps(pets),
        "n_pets": len(pets),
        "services_used": "|".join(pick_services(seg, species, random.randint(2, 6))),
        "visits_last_2y": visits,
        "last_visit": last,
        "satisfaction_prior": sat,
    })

with open("research/clients.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)

print(f"wrote research/clients.csv: {len(rows)} clients (seed {SEED})")
print("segments:", Counter(r["segment"] for r in rows).most_common())
sp = Counter()
for r in rows:
    for p in json.loads(r["pets"]): sp[p["species"]] += 1
print("pets by species:", sp.most_common())
print("households with a dog:", sum(1 for r in rows if "Dog" in r["pets"]), "/", N)
print("brachy owners:", sum(1 for r in rows if '"brachycephalic": true' in r["pets"]))
print("mean satisfaction:", round(sum(r["satisfaction_prior"] for r in rows)/N, 2))
