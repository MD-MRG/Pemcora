"""
Proves 0006 and 0007 on a throwaway local Postgres with a Supabase stub.

Applies 0001-0005 (the real files from the repo), creates a "legacy" team the way
the app does today, then applies 0006 + 0007 twice (re-run safety) and drives every
gate, policy and RPC as real signed-in roles — RLS on, no superuser shortcuts.

    PGHOST=localhost PGUSER=postgres python3 docs/editions/test/run_tests.py \
        supabase/migrations docs/editions

Connection details come from the usual libpq variables (PGHOST, PGPORT, PGUSER,
PGPASSWORD). It drops and recreates a database called pemcora_editions_test and
creates the roles anon / authenticated / service_role, so point it at a throwaway
server, never at Supabase. Needs: pip install "psycopg[binary]".
"""

import json
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg

OLD = Path(sys.argv[1])
NEW = Path(sys.argv[2])
STUB = Path(__file__).parent / "00_supabase_stub.sql"
TEST_DB = "pemcora_editions_test"
ADMIN = "dbname=postgres"
DSN = f"dbname={TEST_DB}"

failures = 0
passes = 0


def check(name, ok, extra=""):
    global failures, passes
    if ok:
        passes += 1
    else:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + extra) if extra else ''}")


# ── database ───────────────────────────────────────────────────────────────
with psycopg.connect(ADMIN, autocommit=True) as c:
    c.execute(f"drop database if exists {TEST_DB}")
    c.execute(f"create database {TEST_DB}")

db = psycopg.connect(DSN, autocommit=True)


def run_file(path):
    db.execute(Path(path).read_text())


def su(sql, params=None):
    """As the superuser (the SQL editor, or the service_role webhook)."""
    cur = db.execute(sql, params)
    return cur.fetchall() if cur.description else None


def act(uid, sql, params=None):
    """As a signed-in user (uid) or anonymous (None), with RLS in force."""
    with db.transaction():
        db.execute("select set_config('request.jwt.claim.sub', %s, true)", [str(uid) if uid else ""])
        db.execute("set local role " + ("authenticated" if uid else "anon"))
        cur = db.execute(sql, params)
        return cur.fetchall() if cur.description else None


def one(uid, sql, params=None):
    rows = act(uid, sql, params)
    return rows[0][0] if rows else None


def refused(name, uid, sql, params=None, contains=None, sqlstate=None):
    try:
        act(uid, sql, params)
    except psycopg.Error as e:
        msg = str(e).splitlines()[0]
        ok = (contains is None or contains.lower() in msg.lower()) and (sqlstate is None or e.sqlstate == sqlstate)
        check(name, ok, f"{e.sqlstate}: {msg}")
        return
    check(name, False, "the write was allowed")


def user(email):
    uid = uuid.uuid4()
    su("insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())", [uid, email])
    return uid


# ── 0001-0005, and a team made the way the app makes one today ─────────────
run_file(STUB)
for f in sorted(OLD.glob("000*.sql")):
    run_file(f)

O = user("owner@legacy.test")
O2 = user("colleague@legacy.test")
T0 = act(O, "select id, invite_code from public.create_team('Legacy AV', '')")[0]
T0, T0_CODE = T0[0], T0[1]
act(O2, "select public.join_team(%s)", [T0_CODE])
L0_CLIENT = uuid.uuid4()
L0 = uuid.uuid4()
act(O, "insert into public.clients (id, team_id, name) values (%s, %s, 'Acme Corp')", [L0_CLIENT, T0])
act(O, "insert into public.locations (id, client_id, team_id, address, suburb) values (%s, %s, %s, '1 George St', 'Sydney')",
    [L0, L0_CLIENT, T0])
act(O, "insert into public.visits (team_id, location_id, kind, completed_at) values (%s, %s, 'maintenance', now())", [T0, L0])

# ── 0006 + 0007, twice ─────────────────────────────────────────────────────
for attempt in (1, 2):
    for f in ("0006_editions.sql", "0007_compliance_and_reports.sql"):
        try:
            run_file(NEW / f)
            check(f"{f} applies (run {attempt})", True)
        except psycopg.Error as e:
            check(f"{f} applies (run {attempt})", False, str(e))
            sys.exit(1)

check("re-run did not duplicate plans", su("select count(*) from public.subscriptions")[0][0] == 1)
check("re-run did not duplicate packs", su("select count(*) from public.team_packs")[0][0] == 1)

v6 = su("""select (select count(*) from public.packs), (select count(*) from public.workflows),
                  (select count(*) from pg_constraint where conname in ('visits_kind_fkey','team_templates_kind_fkey'))""")[0]
check("catalogue: 4 packs, 6 workflows, both kind FKs", tuple(v6) == (4, 6, 2), str(v6))

# ── A. the team that existed before ────────────────────────────────────────
print("\n— Legacy team")
plan = su("select plan, comped, seats, monthly_visit_limit from public.subscriptions where team_id = %s", [T0])[0]
check("grandfathered: Pro, comped, unlimited seats and visits", tuple(plan) == ("pro", True, None, None), str(plan))
check("grandfathered: AV pack switched on",
      su("select pack_id, source from public.team_packs where team_id = %s", [T0]) == [("av", "comped")])
act(O, "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'commissioning')", [T0, L0])
check("legacy team still starts AV visits", True)
for i in range(3):
    act(O, "select public.create_invite(%s, %s)", [T0, f"new{i}@legacy.test"])
check("legacy team can invite freely", True)
ent = one(O, "select public.team_entitlements(%s)", [T0])
check("entitlements read Pro with core + av", ent["is_pro"] and ent["packs"] == ["core", "av"], json.dumps(ent))

# ── B. a team made by today's Team Setup screen (create_team) ──────────────
print("\n— New team via today's create_team()")
N = user("newbie@test")
TN, TN_CODE = act(N, "select id, invite_code from public.create_team('Newbie AV', '')")[0]
check("today's sign-up lands on Free with AV as starter",
      su("select plan from public.subscriptions where team_id = %s", [TN])[0][0] == "free"
      and su("select pack_id, source from public.team_packs where team_id = %s", [TN]) == [("av", "starter")])

print("\n— With the switch off (as shipped)")
check("limits ship switched off", one(N, "select public.team_entitlements(%s)", [TN])["enforced"] is False)
N2 = user("newbie2@test")
act(N2, "select public.join_team(%s)", [TN_CODE])
check("…so tests/rls.mjs can still join a second person to a new Free team",
      su("select count(*) from public.team_members where team_id = %s", [TN])[0][0] == 2)
for i in range(6):
    lid = uuid.uuid4()
    act(N, "insert into public.clients (id, team_id, name) values (%s, %s, %s)", [lid, TN, f"C{i}"])
    act(N, "insert into public.locations (id, client_id, team_id) values (%s, %s, %s)", [lid, lid, TN])
    act(N, "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'vic_smoke_alarm')", [TN, lid])
check("…and nothing is refused, but usage is still counted",
      su("select visits_started from public.team_usage where team_id = %s", [TN])[0][0] == 6)
refused("no client can flip the switch", N, "update public.app_settings set enforce_limits = true", sqlstate="42501")

su("update public.app_settings set enforce_limits = true")   # the day billing goes live
check("switched on from the SQL editor", one(N, "select public.team_entitlements(%s)", [TN])["enforced"] is True)

# ── C. a new electrician via create_organisation ───────────────────────────
print("\n— New electrician on Free with the VIC pack")
A = user("sparky@test")
TA = one(A, "select id from public.create_organisation('Sparky Co', 'provider', 'vic_rental')")
check("provider team with vic_rental as its only pack",
      su("select account_type from public.teams where id = %s", [TA])[0][0] == "provider"
      and su("select pack_id from public.team_packs where team_id = %s", [TA]) == [("vic_rental",)])
kinds = {r[0] for r in su("select kind from public.team_templates where team_id = %s", [TA])}
check("template rows exist for the pack's workflows",
      {"vic_electrical_safety", "vic_smoke_alarm"} <= kinds, str(sorted(kinds)))

CA = uuid.uuid4()
act(A, """insert into public.clients (id, team_id, name, contact_name, contact_email)
          values (%s, %s, 'Jane Landlord', 'Jane', 'jane@landlord.test')""", [CA, TA])
LOCS = []
for i in range(6):
    lid = uuid.uuid4()
    act(A, """insert into public.locations (id, client_id, team_id, address, suburb, state, site_type, is_rental)
              values (%s, %s, %s, %s, 'Richmond', 'VIC', 'residential', true)""",
        [lid, CA, TA, f"{i + 10} Smith St"])
    LOCS.append(lid)

refused("Free VIC team cannot start AV maintenance", A,
        "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'maintenance')",
        [TA, LOCS[0]], contains="does not have the AV", sqlstate="PT402")

VISITS = [uuid.uuid4()]
act(A, "insert into public.visits (id, team_id, location_id, kind) values (%s, %s, %s, 'vic_electrical_safety')",
    [VISITS[0], TA, LOCS[0]])
check("one inspection starts on Free", True)
refused("the second this month is refused", A,
        "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'vic_smoke_alarm')",
        [TA, LOCS[5]], contains="1 inspection a month", sqlstate="PT402")
check("a refused start does not use up allowance",
      su("select visits_started from public.team_usage where team_id = %s", [TA])[0][0] == 1)

last_year = datetime.now(timezone.utc) - timedelta(days=400)
OLDV = uuid.uuid4()
act(A, """insert into public.visits (id, team_id, location_id, kind, started_at, completed_at)
          values (%s, %s, %s, 'vic_smoke_alarm', %s, %s)""", [OLDV, TA, LOCS[1], last_year, last_year])
check("an imported visit from last year is history, not usage",
      su("select visits_started from public.team_usage where team_id = %s", [TA])[0][0] == 1)

refused("Free team (1 seat) cannot invite", A, "select public.create_invite(%s, 'helper@test')", [TA],
        contains="seat", sqlstate="PT402")

act(A, "update public.teams set name = 'Sparky Electrical' where id = %s", [TA])
check("an admin can still rename the team",
      su("select name from public.teams where id = %s", [TA])[0][0] == "Sparky Electrical")
refused("nobody can change a team's account type from the app", A,
        "update public.teams set account_type = 'agency' where id = %s", [TA], sqlstate="42501")

refused("starter pack cannot be swapped once there is work under it", A,
        "select public.choose_starter_pack(%s, 'qld_smoke')", [TA], contains="cannot be swapped", sqlstate="PT402")
F = user("fresh@test")
TF = one(F, "select id from public.create_organisation('Fresh Co', 'provider', 'av')")
act(F, "select public.choose_starter_pack(%s, 'qld_smoke')", [TF])
check("an unused starter pack can be swapped",
      su("select pack_id from public.team_packs where team_id = %s", [TF]) == [("qld_smoke",)])

# ── D. compliance clock ────────────────────────────────────────────────────
print("\n— Re-check dates")
act(A, "update public.visits set completed_at = now(), outcome = 'compliant' where id = %s", [VISITS[0]])
item = su("""select obligation, interval_months, last_done_on, next_due_on, last_visit_id
               from public.compliance_items where location_id = %s""", [LOCS[0]])
today = su("select public.local_day(now())")[0][0]
check("completing a VIC electrical check starts a 24-month clock",
      len(item) == 1 and item[0][0] == "vic_electrical_safety" and item[0][1] == 24
      and item[0][2] == today and item[0][4] == VISITS[0]
      and item[0][3] == su("select (%s::date + interval '24 months')::date", [today])[0][0], str(item))
old_item = su("select last_done_on, next_due_on from public.compliance_items where location_id = %s and obligation = 'vic_smoke_alarm'",
              [LOCS[1]])
check("an imported completed visit builds its schedule too (12 months)", len(old_item) == 1, str(old_item))

refused("cannot hang an asset off another team's site", A,
        "insert into public.assets (team_id, location_id, asset_type) values (%s, %s, 'smoke_alarm')",
        [TA, L0], sqlstate="42501")
act(A, """insert into public.assets (team_id, location_id, asset_type, label, attributes, expires_on)
          values (%s, %s, 'smoke_alarm', 'Bedroom 1', '{"sensor":"photoelectric","power":"10yr_lithium"}', '2034-05-01')""",
    [TA, LOCS[0]])
X = user("outsider@test")
TX = one(X, "select id from public.create_organisation('Outsider', 'provider', 'av')")
check("another team cannot see that asset", one(X, "select count(*) from public.assets") == 0)

# ── E. photos are Pro ──────────────────────────────────────────────────────
print("\n— Photo evidence")
refused("Free team cannot attach a photo", A,
        "insert into public.attachments (team_id, visit_id, storage_path) values (%s, %s, %s)",
        [TA, VISITS[0], f"{TA}/{VISITS[0]}/p1.jpg"], contains="Pro", sqlstate="PT402")
refused("Free team cannot upload to evidence", A,
        "insert into storage.objects (bucket_id, name) values ('evidence', %s)", [f"{TA}/{VISITS[0]}/p1.jpg"],
        sqlstate="42501")

# the Stripe webhook, with the service_role key
su("update public.subscriptions set plan = 'pro', status = 'active', seats = 3 where team_id = %s", [TA])
for i in range(1, 5):   # Pro has no monthly cap; the delivery checks below use these
    VISITS.append(uuid.uuid4())
    act(A, "insert into public.visits (id, team_id, location_id, kind) values (%s, %s, %s, 'vic_electrical_safety')",
        [VISITS[i], TA, LOCS[i]])
act(A, "insert into storage.objects (bucket_id, name) values ('evidence', %s)", [f"{TA}/{VISITS[0]}/p1.jpg"])
act(A, "insert into public.attachments (team_id, visit_id, storage_path) values (%s, %s, %s)",
    [TA, VISITS[0], f"{TA}/{VISITS[0]}/p1.jpg"])
check("after upgrading, more inspections, a photo and its upload all go through", True)
refused("an attachment cannot claim another team's folder", A,
        "insert into public.attachments (team_id, visit_id, storage_path) values (%s, %s, %s)",
        [TA, VISITS[0], f"{TX}/x.jpg"], sqlstate="42501")
refused("a client cannot make itself Pro", A,
        "update public.subscriptions set seats = 99 where team_id = %s", [TA], sqlstate="42501")

# ── F. seats ───────────────────────────────────────────────────────────────
print("\n— Seats")
tok_b = one(A, "select token from public.create_invite(%s, 'b@test')", [TA])
B = user("b@test")
act(B, "select public.accept_invite(%s)", [tok_b])
check("Pro with 3 seats: second person joins",
      su("select count(*) from public.team_members where team_id = %s", [TA])[0][0] == 2)
act(A, "select public.create_invite(%s, 'c@test')", [TA])
refused("a fourth person cannot even be invited (2 members + 1 invited = 3)", A,
        "select public.create_invite(%s, 'd@test')", [TA], contains="already invited", sqlstate="PT402")
TA2 = one(A, "select id from public.create_organisation('Sparky North', 'provider', 'vic_rental')")
refused("moving someone into a full team is refused", A,
        "select public.move_member(%s, %s, %s)", [B, TA, TA2], contains="seat", sqlstate="PT402")

# ── G. sending a report to the landlord ────────────────────────────────────
print("\n— Report delivery")
act(A, "insert into storage.objects (bucket_id, name) values ('reports', %s)", [f"{TA}/r1.pdf"])
refused("nobody uploads into another team's reports folder", X,
        "insert into storage.objects (bucket_id, name) values ('reports', %s)", [f"{TA}/fake.pdf"], sqlstate="42501")
refused("an unfinished visit's report cannot be sent", A,
        "select public.send_report(%s, 'jane@landlord.test')", [VISITS[2]], contains="Complete the visit")
refused("a report cannot point at another team's file", A,
        "select public.send_report(%s, 'jane@landlord.test', '{}', %s)", [VISITS[0], f"{TX}/x.pdf"],
        contains="own team")

d1 = act(A, """select id, token, site, snapshot from public.send_report(%s, ' Jane@Landlord.test ',
               '{"summary":"No faults","snapshot":true}', %s)""", [VISITS[0], f"{TA}/r1.pdf"])[0]
D1, TOK1, SITE1, SNAP1 = d1
check("send_report copies the site address from the database", SITE1["address"] == "10 Smith St", str(SITE1))
check("the provider's real name is stamped on the snapshot",
      SNAP1["provider"]["name"] == "Sparky Electrical" and SNAP1["summary"] == "No faults")
check("an outsider cannot see the delivery", one(X, "select count(*) from public.report_deliveries") == 0)
check("an outsider cannot read the file",
      one(X, "select count(*) from storage.objects where bucket_id = 'reports'") == 0)

prev = act(None, "select workflow, provider, outcome, snapshot, claimed from public.report_preview(%s)", [TOK1])
check("the emailed link previews without an account",
      prev and prev[0][0] == "Electrical safety check" and prev[0][1] == "Sparky Electrical"
      and prev[0][2] == "compliant" and prev[0][4] is False, str(prev))
check("the preview leaks no provider ids", "team_id" not in prev[0][3]["provider"])
check("opening the link is recorded", su("select opened_at is not null from public.report_deliveries where id = %s", [D1])[0][0])
refused("anonymous visitors cannot read deliveries at all", None,
        "select count(*) from public.report_deliveries", sqlstate="42501")

J = user("jane@landlord.test")
TJ = one(J, "select id from public.create_organisation('Jane''s rentals', 'landlord')")
check("landlord team has no inspection packs",
      su("select count(*) from public.team_packs where team_id = %s", [TJ])[0][0] == 0
      and one(J, "select public.team_entitlements(%s)", [TJ])["packs"] == ["core"])
JC = uuid.uuid4()
JL = uuid.uuid4()
act(J, "insert into public.clients (id, team_id, name) values (%s, %s, 'My properties')", [JC, TJ])
act(J, """insert into public.locations (id, client_id, team_id, address, suburb, state, site_type, is_rental)
          values (%s, %s, %s, '  10 SMITH st ', 'richmond', 'VIC', 'residential', true)""", [JL, JC, TJ])

refused("someone else holding the link cannot claim it", X,
        "select public.claim_report(%s, %s)", [TOK1, TX], contains="was sent to")
TJP = one(J, "select id from public.create_organisation('Jane Sparky', 'provider', 'av')")
refused("a report cannot be saved into a provider team, even the recipient's own", J,
        "select public.claim_report(%s, %s)", [TOK1, TJP], contains="landlord or agency")

claimed = act(J, "select recipient_team_id, recipient_location_id, filed_at from public.claim_report(%s, %s)", [TOK1, TJ])[0]
check("claiming files it under the matching property", claimed[0] == TJ and claimed[1] == JL and claimed[2] is not None,
      str(claimed))
ji = su("""select last_done_on, next_due_on, last_delivery_id, interval_months
             from public.compliance_items where team_id = %s and location_id = %s""", [TJ, JL])
check("the landlord's tracker now shows the check done and next due in 24 months",
      len(ji) == 1 and ji[0][0] == today and ji[0][2] == D1 and ji[0][3] == 24, str(ji))
check("the landlord can read the delivered file",
      one(J, "select count(*) from storage.objects where bucket_id = 'reports' and name = %s", [f"{TA}/r1.pdf"]) == 1)
check("the landlord sees none of the provider's own records",
      one(J, "select count(*) from public.visits where team_id = %s", [TA]) == 0
      and one(J, "select count(*) from public.clients where team_id = %s", [TA]) == 0
      and one(J, "select count(*) from public.locations where team_id = %s", [TA]) == 0)
check("both sides can see the site link, nobody else",
      one(A, "select count(*) from public.site_links") == 1 and one(J, "select count(*) from public.site_links") == 1
      and one(X, "select count(*) from public.site_links") == 0)

V2 = uuid.uuid4()
act(A, "insert into public.visits (id, team_id, location_id, kind) values (%s, %s, %s, 'vic_electrical_safety')",
    [V2, TA, LOCS[0]])
act(A, "update public.visits set completed_at = now(), outcome = 'non_compliant' where id = %s", [V2])
d2 = act(A, "select id, recipient_team_id, recipient_location_id from public.send_report(%s, 'jane@landlord.test')", [V2])[0]
check("the next report for that site files itself", d2[1] == TJ and d2[2] == JL, str(d2))
check("…and moves the landlord's tracker onto it",
      su("select last_delivery_id from public.compliance_items where team_id = %s and location_id = %s", [TJ, JL])[0][0] == d2[0])

act(A, "update public.visits set completed_at = now() where id = %s", [VISITS[1]])
tok3 = one(A, "select token from public.send_report(%s, 'jane@landlord.test')", [VISITS[1]])
unf = act(J, "select id, recipient_location_id from public.claim_report(%s, %s)", [tok3, TJ])[0]
check("a report for a property not yet in the account arrives unfiled", unf[1] is None)
JL2 = uuid.uuid4()
act(J, "insert into public.locations (id, client_id, team_id, address, suburb) values (%s, %s, %s, '11 Smith St', 'Richmond')",
    [JL2, JC, TJ])
filed = act(J, "select recipient_location_id from public.file_report(%s, %s)", [unf[0], JL2])[0][0]
check("…and the landlord files it", filed == JL2)
refused("a report cannot be filed into another team's property", J,
        "select public.file_report(%s, %s)", [unf[0], LOCS[2]], contains="not in this account")

wrong = one(A, "select id from public.send_report(%s, 'typo@landlrod.test')", [VISITS[0]])
act(A, "select public.revoke_report(%s)", [wrong])
check("a report sent to a typo can be withdrawn",
      su("select count(*) from public.report_deliveries where id = %s", [wrong])[0][0] == 0)
refused("a claimed report cannot be withdrawn", A, "select public.revoke_report(%s)", [D1], contains="already been saved")

refused("the internal filing function is not callable", A,
        "select public._file_delivery(%s, %s, %s, %s)", [D1, TA, LOCS[0], A], sqlstate="42501")
refused("deliveries cannot be edited directly", A,
        "update public.report_deliveries set recipient_email = 'x@test' where id = %s", [D1], sqlstate="42501")
act(A, "delete from storage.objects where bucket_id = 'reports' and name = %s", [f"{TA}/r1.pdf"])
check("a delivered report file cannot be deleted by the sender",
      su("select count(*) from storage.objects where bucket_id = 'reports' and name = %s", [f"{TA}/r1.pdf"])[0][0] == 1)
check("entitlements are private to members", one(X, "select public.team_entitlements(%s)", [TA]) is None)

print(f"\n{passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
