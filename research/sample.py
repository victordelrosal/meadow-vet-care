import csv, json, random
random.seed(99)
rows = list(csv.DictReader(open("research/clients.csv")))
svc = {s["service_id"]: s for s in csv.DictReader(open("research/services_snapshot.csv"))}
QUOTA = {"new_pet":6,"senior_pet":6,"brachy_highrisk":4,"multi_pet":5,
         "budget_stretched":6,"time_poor_professional":6,"anxious_first_timer":3,"lapsed":4}
sample=[]
for seg,n in QUOTA.items():
    pool=[r for r in rows if r["segment"]==seg]
    sample += random.sample(pool,n)
random.shuffle(sample)
out=[]
for r in sample:
    used=[svc[s]["service_name"] for s in r["services_used"].split("|") if s in svc]
    out.append({"client_id":r["client_id"],"segment":r["segment"],"neighbourhood":r["neighbourhood"],
        "age_band":r["owner_age_band"],"household":r["household"],"tech_comfort":r["tech_comfort"],
        "budget_sensitivity":r["budget_sensitivity"],"channel_preference":r["channel_preference"],
        "pets":json.loads(r["pets"]),"services_used":used,"visits_last_2y":int(r["visits_last_2y"]),
        "last_visit":r["last_visit"],"satisfaction_prior":int(r["satisfaction_prior"])})
json.dump(out,open("research/sample40.json","w"),indent=1)
# 12 usability: skew to web/high-tech but keep 3 low-tech for friction
usab=[p for p in out if p["tech_comfort"]!="low"][:9]+[p for p in out if p["tech_comfort"]=="low"][:3]
json.dump(usab,open("research/usability12.json","w"),indent=1)
print("sample40:",len(out),"usability12:",len(usab))
print(json.dumps(out[0],indent=1)[:400])
