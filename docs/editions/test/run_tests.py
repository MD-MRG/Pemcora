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


def su_raw(sql, params=None):
    """As the superuser with triggers off: for arranging history the gates would refuse."""
    with db.transaction():
        db.execute("set local session_replication_role = replica")
        db.execute(sql, params)


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


def user(email, invite_token=None):
    """A confirmed account. With an invite token, as if it signed up from the link."""
    uid = uuid.uuid4()
    meta = json.dumps({"invite_token": str(invite_token)} if invite_token else {})
    su("insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (%s, %s, %s, now())",
       [uid, email, meta])
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
check("catalogue: 5 packs, 9 workflows, both kind FKs", tuple(v6) == (5, 9, 2), str(v6))

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
# Older work only comes in through the owner's one-time import window.
act(A, "select public.open_import_window(%s)", [TA])
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
        "select public.choose_starter_pack(%s, 'qld_electrical')", [TA], contains="cannot be swapped", sqlstate="PT402")
F = user("fresh@test")
TF = one(F, "select id from public.create_organisation('Fresh Co', 'provider', 'av')")
act(F, "select public.choose_starter_pack(%s, 'qld_electrical')", [TF])
check("an unused starter pack can be swapped",
      su("select pack_id from public.team_packs where team_id = %s", [TF]) == [("qld_electrical",)])

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


def add_site(uid, team, name, contact_name="", contact_email=""):
    """A client with one site, as the app makes them. Returns (client id, location id)."""
    cid, lid = uuid.uuid4(), uuid.uuid4()
    act(uid, "insert into public.clients (id, team_id, name, contact_name, contact_email) values (%s, %s, %s, %s, %s)",
        [cid, team, name, contact_name, contact_email])
    act(uid, "insert into public.locations (id, client_id, team_id, address, suburb) values (%s, %s, %s, %s, 'Richmond')",
        [lid, cid, team, f"{name} St"])
    return cid, lid


def add_location(uid, team, cid, address):
    lid = uuid.uuid4()
    act(uid, "insert into public.locations (id, client_id, team_id, address, suburb) values (%s, %s, %s, %s, 'Richmond')",
        [lid, cid, team, address])
    return lid


def start_visit(uid, team, lid, kind, completed=False, started_at=None):
    vid = uuid.uuid4()
    act(uid, "insert into public.visits (id, team_id, location_id, kind, started_at) values (%s, %s, %s, %s, coalesce(%s, now()))",
        [vid, team, lid, kind, started_at])
    if completed:
        act(uid, "update public.visits set completed_at = now() where id = %s", [vid])
    return vid


def months_after(d, n):
    return su("select (%s::date + make_interval(months => %s))::date", [d, n])[0][0]


def usage(team):
    rows = su("select period, visits_started from public.team_usage where team_id = %s", [team])
    return rows[0] if rows else (None, 0)


now = datetime.now(timezone.utc)
this_month = today.replace(day=1)

# ── H. a second device joins; a different visit is refused ─────────────────
print("\n— A second device on the same visit")
S2 = user("two-devices@test")
TS2 = one(S2, "select id from public.create_organisation('Two Devices', 'provider', 'vic_rental')")
_, S2_L1 = add_site(S2, TS2, "Elm")
_, S2_L2 = add_site(S2, TS2, "Oak")
start_visit(S2, TS2, S2_L1, "vic_smoke_alarm")
refused("with the allowance used, a second device starting the same open visit gets 23505 — the app joins it", S2,
        "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'vic_smoke_alarm')",
        [TS2, S2_L1], contains="visits_one_open_per_kind_idx", sqlstate="23505")
refused("…while a different visit is still refused with 402", S2,
        "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'vic_smoke_alarm')",
        [TS2, S2_L2], contains="1 inspection a month", sqlstate="PT402")
check("…and only the one inspection is counted", usage(TS2) == (this_month, 1), str(usage(TS2)))

# ── I. honest dates ────────────────────────────────────────────────────────
print("\n— Visit dates")
DT = user("dates@test")
TD = one(DT, "select id from public.create_organisation('Dated', 'provider', 'vic_rental')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [TD])   # the webhook; no allowance in the way
_, TD_L1 = add_site(DT, TD, "Ash")
_, TD_L2 = add_site(DT, TD, "Birch")
start_visit(DT, TD, TD_L1, "vic_smoke_alarm", started_at=now - timedelta(days=6))
check("a visit started 6 days ago (an offline device) is accepted and counted in this month by the server's clock",
      usage(TD) == (this_month, 1), str(usage(TD)))
refused("a start date 8 days ago is refused", DT,
        "insert into public.visits (team_id, location_id, kind, started_at) values (%s, %s, 'vic_smoke_alarm', %s)",
        [TD, TD_L2, now - timedelta(days=8)], contains="more than 7 days ago", sqlstate="23514")
refused("a start date 2 hours ahead is refused", DT,
        "insert into public.visits (team_id, location_id, kind, started_at) values (%s, %s, 'vic_smoke_alarm', %s)",
        [TD, TD_L2, now + timedelta(hours=2)], contains="in the future", sqlstate="23514")
refused("a visit inserted already completed 9 days ago is refused", DT,
        "insert into public.visits (team_id, location_id, kind, completed_at) values (%s, %s, 'vic_smoke_alarm', %s)",
        [TD, TD_L2, now - timedelta(days=9)], contains="completion date", sqlstate="23514")
check("a refused start counts nothing", usage(TD)[1] == 1)

LONG = start_visit(DT, TD, TD_L2, "vic_smoke_alarm")
su_raw("update public.visits set started_at = now() - interval '20 days' where id = %s", [LONG])
refused("completing with a date 8 days ago is refused", DT,
        "update public.visits set completed_at = now() - interval '8 days' where id = %s", [LONG], sqlstate="23514")
act(DT, "update public.visits set completed_at = now() where id = %s", [LONG])
check("a visit started 20 days ago can still be finished today",
      su("select completed_at is not null from public.visits where id = %s", [LONG])[0][0])
refused("a completion date cannot later be moved into the past through the API", DT,
        "update public.visits set completed_at = now() - interval '9 days' where id = %s", [LONG], sqlstate="23514")
refused("nor can a start date", DT,
        "update public.visits set started_at = now() - interval '25 days' where id = %s", [LONG], sqlstate="23514")
act(DT, "update public.visits set technician = 'Sam', started_at = started_at, completed_at = completed_at where id = %s", [LONG])
check("sending a 20-day-old start date back unchanged with another edit passes",
      su("select technician from public.visits where id = %s", [LONG])[0][0] == "Sam")
act(DT, "update public.visits set completed_at = null where id = %s", [LONG])
act(DT, "update public.visits set completed_at = now() where id = %s", [LONG])
check("reopening and completing again passes", True)

# ── J. the one-time import window ──────────────────────────────────────────
print("\n— Import window")
DA = user("dates-admin@test")
su("insert into public.team_members (team_id, user_id, role) values (%s, %s, 'admin')", [TD, DA])
refused("an admin cannot open it — the owner only", DA, "select public.open_import_window(%s)", [TD],
        contains="owner", sqlstate="42501")
w1 = one(DT, "select public.open_import_window(%s)", [TD])
w2 = one(DT, "select public.open_import_window(%s)", [TD])
check("the owner opens it for 15 minutes; asking again inside it returns the same closing time",
      w1 is not None and w1 == w2
      and su("select import_open_until - import_used_at from public.teams where id = %s", [TD])[0][0] == timedelta(minutes=15))
check("entitlements say the import has been used", one(DT, "select public.team_entitlements(%s)", [TD])["import_used"] is True)
before = usage(TD)[1]
_, TD_L3 = add_site(DT, TD, "Cedar")
start_visit(DT, TD, TD_L3, "vic_electrical_safety", started_at=now - timedelta(days=400))
check("inside it, a visit from last year goes in and is history, not usage", usage(TD)[1] == before)
_, TD_L4 = add_site(DT, TD, "Douglas")
start_visit(DT, TD, TD_L4, "vic_electrical_safety")
check("inside it, a visit from this month still counts", usage(TD)[1] == before + 1)
su("update public.teams set import_open_until = now() - interval '1 second' where id = %s", [TD])
refused("once it has closed it never opens again", DT, "select public.open_import_window(%s)", [TD],
        contains="already used", sqlstate="PT409")
refused("…and the app cannot reset it", DT, "update public.teams set import_used_at = null where id = %s", [TD],
        sqlstate="42501")
_, TD_L5 = add_site(DT, TD, "Elder")
refused("…so the date check is back", DT,
        "insert into public.visits (team_id, location_id, kind, started_at) values (%s, %s, 'vic_smoke_alarm', %s)",
        [TD, TD_L5, now - timedelta(days=30)], sqlstate="23514")

# ── K. card declined, and cancelling ───────────────────────────────────────
print("\n— Billing dates")
GR = user("grace@test")
TG = one(GR, "select id from public.create_organisation('Graceful', 'provider', 'av')")
su("update public.subscriptions set plan = 'pro', status = 'past_due' where team_id = %s", [TG])
since = su("select past_due_since from public.subscriptions where team_id = %s", [TG])[0][0]
check("going past due starts the 7-day clock", since is not None)
su("update public.subscriptions set status = 'past_due' where team_id = %s", [TG])
check("Stripe repeating past_due keeps the first date",
      su("select past_due_since from public.subscriptions where team_id = %s", [TG])[0][0] == since)
su("update public.subscriptions set past_due_since = now() - interval '6 days' where team_id = %s", [TG])
check("past due on day 6 is still Pro", su("select public.team_is_pro(%s)", [TG])[0][0] is True)
check("…and entitlements give the day Pro ends",
      one(GR, "select public.team_entitlements(%s)", [TG])["past_due_until"] is not None)
su("update public.subscriptions set past_due_since = now() - interval '8 days' where team_id = %s", [TG])
check("past due on day 8 is Free, whether or not Stripe has said so", su("select public.team_is_pro(%s)", [TG])[0][0] is False)
su("update public.subscriptions set status = 'active' where team_id = %s", [TG])
check("a successful payment clears the clock and restores Pro",
      su("select past_due_since is null, public.team_is_pro(%s) from public.subscriptions where team_id = %s",
         [TG, TG])[0] == (True, True))
su("update public.subscriptions set cancel_at = now() + interval '3 days' where team_id = %s", [TG])
check("cancelled, but inside the paid period: still Pro", su("select public.team_is_pro(%s)", [TG])[0][0] is True)
su("update public.subscriptions set cancel_at = now() - interval '1 minute' where team_id = %s", [TG])
check("after cancel_at: Free, even before the webhook changes the status",
      su("select public.team_is_pro(%s)", [TG])[0][0] is False)

# ── L. the catalogue, and no silent AV ─────────────────────────────────────
print("\n— Catalogue")
check("packs: core, av, vic_rental, qld_electrical, electrical_general — qld_smoke is gone",
      {r[0] for r in su("select id from public.packs")}
      == {"core", "av", "vic_rental", "qld_electrical", "electrical_general"})
wf = {r[0]: r[1:] for r in su("select id, pack_id, default_interval_months, interval_fixed from public.workflows")}
check("qld_electrical: the smoke alarm check (12, fixed) and the new electrical check (24, adjustable)",
      wf["qld_smoke_alarm"] == ("qld_electrical", 12, True) and wf["qld_electrical_safety"] == ("qld_electrical", 24, False))
check("electrical_general: electrical_safety (24) and smoke_alarm_check (12), both adjustable",
      wf["electrical_safety"] == ("electrical_general", 24, False)
      and wf["smoke_alarm_check"] == ("electrical_general", 12, False))
check("only the three intervals the law sets are fixed",
      {k for k, v in wf.items() if v[2]} == {"vic_electrical_safety", "vic_smoke_alarm", "qld_smoke_alarm"})
NP = user("no-pack@test")
refused("a new provider team must say which pack it starts with — no silent AV", NP,
        "select public.create_organisation('No Pack', 'provider')", contains="Choose the pack")
refused("…a blank pack is no pack", NP,
        "select public.create_organisation('No Pack', 'provider', '  ')", contains="Choose the pack")
check("…and nothing was created", su("select count(*) from public.teams where name = 'No Pack'")[0][0] == 0)
TEP = one(NP, "select id from public.create_organisation('Baseline Sparks', 'provider', 'electrical_general')")
check("an electrician outside VIC and QLD starts on electrical_general",
      su("select pack_id from public.team_packs where team_id = %s", [TEP]) == [("electrical_general",)])

# ── M. seat races ──────────────────────────────────────────────────────────
print("\n— Seat races")
SO = user("seats-owner@test")
TSR, TSR_CODE = act(SO, "select id, invite_code from public.create_organisation('Last Seat', 'provider', 'av')")[0]
su("update public.subscriptions set plan = 'pro', seats = 2 where team_id = %s", [TSR])
inv_bee = act(SO, "select id, token, invitee_name from public.create_invite(%s, 'bee@seats.test', 'Bee Smith')", [TSR])[0]
check("an invitation carries the invitee's name", inv_bee[2] == "Bee Smith")
CODER = user("coder@seats.test")
joined = one(CODER, "select public.join_team(%s)", [TSR_CODE])
check("someone joining with the team code takes the last seat",
      joined.get("status") == "joined" and joined.get("id") == str(TSR), json.dumps(joined))
BEE = user("bee@seats.test")
res = one(BEE, "select public.accept_invite(%s)", [inv_bee[1]])
check("the invitee who arrives second gets {status: full}, not an error",
      res.get("status") == "full" and "id" not in res, json.dumps(res))
inv = su("select cancelled_at is not null, cancel_reason, accepted_at from public.team_invites where id = %s", [inv_bee[0]])[0]
check("…their invitation is cancelled, reason no_seats", inv[0] and inv[1] == "no_seats" and inv[2] is None, str(inv))
check("…and they are not in the team",
      su("select count(*) from public.team_members where team_id = %s and user_id = %s", [TSR, BEE])[0][0] == 0)
notes = act(SO, "select kind, payload from public.team_notices where team_id = %s", [TSR])
check("the owner gets a notice naming them",
      len(notes) == 1 and notes[0][0] == "invite_cancelled_no_seats"
      and notes[0][1]["name"] == "Bee Smith" and notes[0][1]["email"] == "bee@seats.test", str(notes))
check("a plain member does not see notices", one(CODER, "select count(*) from public.team_notices") == 0)
act(SO, "update public.team_notices set read_at = now() where team_id = %s", [TSR])
check("an owner marks a notice read",
      su("select read_at is not null from public.team_notices where team_id = %s", [TSR])[0][0])
refused("…but cannot change anything else on it", SO,
        "update public.team_notices set kind = 'x' where team_id = %s", [TSR], sqlstate="42501")
refused("nobody writes notices directly", SO,
        "insert into public.team_notices (team_id, kind) values (%s, 'fake')", [TSR], sqlstate="42501")
check("the invitation link now says it was cancelled",
      act(None, "select cancelled from public.invite_preview(%s)", [inv_bee[1]]) == [(True,)])
refused("trying it again says the team is full", BEE, "select public.accept_invite(%s)", [inv_bee[1]],
        contains="This team is full. Ask the person who invited you.")
LATE = user("late@seats.test")
check("joining a full team by code returns {status: full}, with nobody to notify",
      one(LATE, "select public.join_team(%s)", [TSR_CODE]).get("status") == "full"
      and su("select count(*) from public.team_notices where team_id = %s", [TSR])[0][0] == 1)
refused("clients cannot insert invitations directly", SO,
        "insert into public.team_invites (team_id, email) values (%s, 'direct@seats.test')", [TSR], sqlstate="42501")
refused("…or un-cancel one", SO,
        "update public.team_invites set cancelled_at = null where team_id = %s", [TSR], sqlstate="42501")
refused("the shared seat check is not callable by clients", SO,
        "select public.claim_seat(%s, %s)", [TSR, inv_bee[0]], sqlstate="42501")

su("update public.subscriptions set seats = 3 where team_id = %s", [TSR])
tok_eve = one(SO, "select token from public.create_invite(%s, 'eve@seats.test', 'Eve Jones')", [TSR])
su("update public.subscriptions set seats = 2 where team_id = %s", [TSR])   # seats lowered after it went out
EVE = user("eve@seats.test", invite_token=tok_eve)
check("confirming an email into a team that has filled up adds nobody, and the sign-up still succeeds",
      su("select count(*) from auth.users where id = %s", [EVE])[0][0] == 1
      and su("select count(*) from public.team_members where team_id = %s and user_id = %s", [TSR, EVE])[0][0] == 0)
check("…the invitation is cancelled and the notice names Eve",
      su("select cancel_reason from public.team_invites where token = %s", [tok_eve])[0][0] == "no_seats"
      and su("select count(*) from public.team_notices where team_id = %s and payload->>'name' = 'Eve Jones'",
             [TSR])[0][0] == 1)
su("update public.subscriptions set seats = 5 where team_id = %s", [TSR])
tok_fay = one(SO, "select token from public.create_invite(%s, 'fay@seats.test')", [TSR])
FAY = user("fay@seats.test")
res = one(FAY, "select public.accept_invite(%s)", [tok_fay])
check("with a seat free, accept_invite still returns the team's id and name (all today's app reads)",
      res.get("status") == "joined" and res.get("id") == str(TSR) and res.get("name") == "Last Seat", json.dumps(res))
tok_gus = one(SO, "select token from public.create_invite(%s, 'gus@seats.test')", [TSR])
GUS = user("gus@seats.test", invite_token=tok_gus)
check("…and confirming an email from an invitation still adds the person",
      su("select count(*) from public.team_members where team_id = %s and user_id = %s", [TSR, GUS])[0][0] == 1)

# ── N. regular PM visits ───────────────────────────────────────────────────
print("\n— Regular intervals")
PO = user("pm-owner@test")
TPM = one(PO, "select id from public.create_organisation('Regular AV', 'provider', 'av')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [TPM])
PM_MEMBER = user("pm-member@test")
act(PM_MEMBER, "select public.join_team(%s)", [su("select invite_code from public.teams where id = %s", [TPM])[0][0]])
ACME, P1 = add_site(PO, TPM, "Acme", "Ann", "ann@acme.test")   # gets a PM visit
P2 = add_location(PO, TPM, ACME, "2 Acme St")                   # never visited
BOLT, P3 = add_site(PO, TPM, "Bolt")                            # another client
start_visit(PO, TPM, P1, "maintenance", completed=True)
check("with no interval set, a PM visit starts no schedule (AV PM has no default)",
      su("select count(*) from public.compliance_items where team_id = %s", [TPM])[0][0] == 0)
refused("a plain member cannot set the interval", PM_MEMBER,
        "select public.set_workflow_interval(%s, 'maintenance', null, 3)", [TPM], contains="owner or admin")
refused("an interval fixed by law cannot be changed", PO,
        "select public.set_workflow_interval(%s, 'vic_smoke_alarm', null, 6)", [TPM], contains="set by law")
refused("another team's client is refused", PO,
        "select public.set_workflow_interval(%s, 'maintenance', %s, 6)", [TPM, CA], contains="not in this team")
refused("nobody writes intervals directly", PO,
        "insert into public.workflow_intervals (team_id, workflow_id, interval_months) values (%s, 'maintenance', 1)",
        [TPM], sqlstate="42501")


def pm_items():
    return {r[0]: r[1:] for r in su("""select location_id, next_due_on, interval_months, active
                                         from public.compliance_items
                                        where team_id = %s and obligation = 'maintenance'""", [TPM])}


act(PO, "select public.set_workflow_interval(%s, 'maintenance', null, 3)", [TPM])
items = pm_items()
check("a team default of 3 months gives every site an item", set(items) == {P1, P2, P3}, str(items))
check("…the visited site is due 3 months after its PM visit", items[P1] == (months_after(today, 3), 3, True), str(items[P1]))
check("…and the others have no due date yet", items[P2][0] is None and items[P3][0] is None)
act(PO, "select public.set_workflow_interval(%s, 'maintenance', %s, 6)", [TPM, ACME])
items = pm_items()
check("a client's own interval recalculates that client's sites", items[P1] == (months_after(today, 6), 6, True), str(items[P1]))
check("…and leaves other clients on the team default", items[P3][1] == 3)
act(PO, "select public.set_workflow_interval(%s, 'maintenance', null, 4)", [TPM])
check("changing the team default leaves the client's own interval alone",
      pm_items()[P1][1] == 6 and pm_items()[P3][1] == 4)
act(PO, "select public.set_workflow_interval(%s, 'maintenance', %s, null)", [TPM, ACME])
check("'use team default' puts the client back on it, due dates and all",
      pm_items()[P1][:2] == (months_after(today, 4), 4))
check("members read the intervals; other teams do not",
      one(PM_MEMBER, "select count(*) from public.workflow_intervals") == 1
      and one(X, "select count(*) from public.workflow_intervals") == 0)
P4 = add_location(PO, TPM, BOLT, "4 Bolt St")
start_visit(PO, TPM, P4, "maintenance", completed=True)
check("a site added later joins the schedule on its first PM visit", pm_items()[P4][:2] == (months_after(today, 4), 4))

# ── O. the Due page ────────────────────────────────────────────────────────
print("\n— Due list")
act(PO, "insert into public.assets (team_id, location_id, asset_type, label, expires_on) values (%s, %s, 'smoke_alarm', 'Hall', %s)",
    [TPM, P2, today + timedelta(days=40)])
act(PO, "insert into public.assets (team_id, location_id, asset_type, label, expires_on) values (%s, %s, 'smoke_alarm', 'Far off', %s)",
    [TPM, P2, today + timedelta(days=400)])
act(PO, """insert into public.assets (team_id, location_id, asset_type, label, expires_on, removed_at)
           values (%s, %s, 'smoke_alarm', 'Replaced', %s, now())""", [TPM, P2, today + timedelta(days=10)])
su("update public.compliance_items set next_due_on = %s where location_id = %s", [today - timedelta(days=5), P4])
due = act(PO, "select kind, due_on, location_id, label, client_name, contact_name, address from public.due_list(%s)", [TPM])
kinds = {(r[0], r[2]) for r in due}
check("an overdue check is listed, first", due and due[0][0] == "overdue" and due[0][2] == P4, str(due))
check("sites on the regular interval with no PM visit yet are 'not done yet'",
      ("not_done_yet", P2) in kinds and ("not_done_yet", P3) in kinds)
check("a check due beyond 60 days is not listed", not any(r[2] == P1 for r in due))
check("an alarm expiring within 3 months is listed; a far-off one and a replaced one are not",
      [r[3] for r in due if r[0] == "expiring"] == ["Hall"])
check("each row carries its client, contact and address",
      any(r[4] == "Acme" and r[5] == "Ann" and r[6] == "2 Acme St" for r in due))
check("a wider window brings the later check in",
      any(r[2] == P1 for r in act(PO, "select kind, due_on, location_id from public.due_list(%s, 200)", [TPM])))
check("members see the same list; other teams see nothing",
      len(act(PM_MEMBER, "select * from public.due_list(%s)", [TPM])) == len(due)
      and act(X, "select * from public.due_list(%s)", [TPM]) == [])
refused("anonymous callers cannot read it", None, "select * from public.due_list(%s)", [TPM], sqlstate="42501")
su("update public.compliance_items set active = false where location_id = %s and obligation = 'maintenance'", [P3])
check("a check switched off for a site stays off the list",
      not any(r[2] == P3 for r in act(PO, "select kind, due_on, location_id from public.due_list(%s)", [TPM])))
act(PO, "select public.set_workflow_interval(%s, 'maintenance', null, null)", [TPM])
check("removing the team default switches every PM item off, and 'not done yet' goes with it",
      su("select count(*) from public.compliance_items where team_id = %s and obligation = 'maintenance' and active",
         [TPM])[0][0] == 0
      and not any(r[0] == "not_done_yet" for r in act(PO, "select kind, due_on from public.due_list(%s)", [TPM])))

_, EG_L = add_site(NP, TEP, "Gum")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [TEP])
start_visit(NP, TEP, EG_L, "electrical_safety", completed=True)
eg = lambda: su("select interval_months, next_due_on, active from public.compliance_items where location_id = %s", [EG_L])[0]
check("electrical_safety starts on its own 24-month default", eg()[0] == 24)
act(NP, "select public.set_workflow_interval(%s, 'electrical_safety', null, 36)", [TEP])
check("a team default of 36 months applies to it", eg()[:2] == (36, months_after(today, 36)))
act(NP, "select public.set_workflow_interval(%s, 'electrical_safety', null, null)", [TEP])
check("removing it falls back to 24 months and keeps the check on", eg() == (24, months_after(today, 24), True))

# ── P. reminder switches and the opt-out link ──────────────────────────────
print("\n— Reminders")
act(PO, "update public.team_settings set reminders_enabled = false where team_id = %s", [TPM])
check("an owner switches the whole team's reminders off",
      su("select reminders_enabled from public.team_settings where team_id = %s", [TPM])[0][0] is False)
act(PO, "update public.team_settings set reminders_enabled = true where team_id = %s", [TPM])
act(PM_MEMBER, "update public.team_settings set reminders_enabled = false where team_id = %s", [TPM])
check("a plain member cannot", su("select reminders_enabled from public.team_settings where team_id = %s", [TPM])[0][0] is True)
act(PM_MEMBER, "update public.clients set reminders_enabled = false where id = %s", [BOLT])
act(PM_MEMBER, "update public.compliance_items set reminders_enabled = false where location_id = %s", [P4])
check("a member switches one client, and one check, off",
      su("select reminders_enabled from public.clients where id = %s", [BOLT])[0][0] is False
      and su("select reminders_enabled from public.compliance_items where location_id = %s", [P4])[0][0] is False)

opt_item, opt_tok = su("""select id, reminder_token from public.compliance_items
                           where location_id = %s and obligation = 'vic_electrical_safety'""", [LOCS[0]])[0]
r = act(None, "select provider, address, suburb from public.reminder_opt_out(%s)", [opt_tok])
check("'No longer needed' works without signing in and returns only the business name and address",
      r == [("Sparky Electrical", "10 Smith St", "Richmond")], str(r))
row = su("select reminders_enabled, opted_out_at is not null, opted_out_via from public.compliance_items where id = %s",
         [opt_item])[0]
check("…switches that check's reminders off and records how", tuple(row) == (False, True, "email_link"), str(row))
n = act(A, "select payload from public.team_notices where team_id = %s and kind = 'reminder_opt_out'", [TA])
check("…and tells the electrician who and where",
      len(n) == 1 and n[0][0]["contact_name"] == "Jane" and n[0][0]["address"] == "10 Smith St", str(n))
act(None, "select * from public.reminder_opt_out(%s)", [opt_tok])
check("clicking it twice tells them once",
      su("select count(*) from public.team_notices where team_id = %s and kind = 'reminder_opt_out'", [TA])[0][0] == 1)
check("an unknown token returns nothing", act(None, "select * from public.reminder_opt_out(%s)", [uuid.uuid4()]) == [])
su("update public.team_settings set company = %s where team_id = %s",
   [json.dumps({"name": "Sparky Electrical Pty Ltd"}), TA])
check("the business name from the company details comes first",
      act(None, "select provider from public.reminder_opt_out(%s)", [opt_tok]) == [("Sparky Electrical Pty Ltd",)])

# ── Q. checks entered by hand ──────────────────────────────────────────────
print("\n— Hand-entered checks")
_, GAS_L = add_site(J, TJ, "Gas")
gas = one(J, """insert into public.compliance_items (team_id, location_id, obligation, label, interval_months, last_done_on)
               values (%s, %s, 'gas_safety', 'Gas safety check', 24, '2026-03-01') returning id""", [TJ, GAS_L])
gas_row = lambda: su("select next_due_on, last_reminded_at from public.compliance_items where id = %s", [gas])[0]
check("a gas check recorded as done on 1 March 2026 is next due 1 March 2028", gas_row()[0] == date(2028, 3, 1))
su("update public.compliance_items set last_reminded_at = now() where id = %s", [gas])
act(J, "update public.compliance_items set last_done_on = '2026-09-01' where id = %s", [gas])
check("a newer date done moves the due date on and restarts the reminders", gas_row() == (date(2028, 9, 1), None))
act(J, "update public.compliance_items set interval_months = 12 where id = %s", [gas])
check("a new interval moves the due date too", gas_row()[0] == date(2027, 9, 1))
act(J, "update public.compliance_items set last_done_on = '2026-10-01', next_due_on = '2027-06-30' where id = %s", [gas])
check("a due date typed in the same change is kept as typed", gas_row()[0] == date(2027, 6, 30))

# ── R. report links, and the sign-off on the report ────────────────────────
print("\n— Report links and sign-off")
RO = user("signer@test")
TRO = one(RO, "select id from public.create_organisation('Signed Sparks', 'provider', 'vic_rental')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [TRO])
act(RO, "update public.member_prefs set licence_number = 'REC-123' where team_id = %s and user_id = %s", [TRO, RO])
check("a technician records their own licence number",
      su("select licence_number from public.member_prefs where team_id = %s and user_id = %s", [TRO, RO])[0][0] == "REC-123")
_, RL = add_site(RO, TRO, "Willow", "Kim", "kim@landlord.test")
RV = start_visit(RO, TRO, RL, "vic_electrical_safety")
refused("a signature over 50 KB is refused", RO, "update public.visits set signoff = %s where id = %s",
        [json.dumps({"signature": "M" + "0" * 52000}), RV], sqlstate="23514")
refused("a sign-off has to be an object", RO, "update public.visits set signoff = '\"Sam\"' where id = %s", [RV],
        sqlstate="23514")
SIGNOFF = {"technician": "Sam Sparks", "licence_number": "REC-123",
           "signed_at": datetime.now(timezone.utc).isoformat(), "signature": "M0 0 L10 10"}
APP_KEYS = ("technician", "licence_number", "signature")
act(RO, "update public.visits set signoff = %s, completed_at = now(), outcome = 'compliant' where id = %s",
    [json.dumps(SIGNOFF), RV])
RD, RTOK, RSNAP = act(RO, "select id, token, snapshot from public.send_report(%s, 'kim@landlord.test', %s)",
                      [RV, json.dumps({"signoff": {"technician": "Forged"}, "summary": "All good"})])[0]
check("the visit's sign-off reaches the delivered report, over anything the app sent",
      all(RSNAP["signoff"][k] == SIGNOFF[k] for k in APP_KEYS) and RSNAP["summary"] == "All good",
      str(RSNAP.get("signoff")))
check("…carrying who signed it, recorded by the database",
      RSNAP["signoff"].get("signed_by") == str(RO) and RSNAP["signoff"].get("recorded_at"), str(RSNAP.get("signoff")))
check("the link's public view lasts 90 days",
      su("select link_expires_at::date - sent_at::date from public.report_deliveries where id = %s", [RD])[0][0] == 90)
pv = act(None, "select status, workflow, provider, snapshot from public.report_preview(%s)", [RTOK])
check("a fresh link shows the report (status ok)",
      pv and pv[0][0] == "ok" and pv[0][1] == "Electrical safety check"
      and all(pv[0][3]["signoff"][k] == SIGNOFF[k] for k in APP_KEYS), str(pv))
check("…without the signer's account id, like the provider's team id",
      "signed_by" not in pv[0][3]["signoff"] and "team_id" not in pv[0][3]["provider"])
su("update public.report_deliveries set link_expires_at = now() - interval '1 minute' where id = %s", [RD])
pv = act(None, """select status, workflow, provider, completed_on, outcome, site, snapshot, has_file
                    from public.report_preview(%s)""", [RTOK])
check("after 90 days it shows only who sent it (status expired), so the landlord can ask them",
      pv and pv[0][0] == "expired" and pv[0][2] == "Signed Sparks"
      and pv[0][1] is None and all(v is None for v in pv[0][3:]), str(pv))
refused("another team cannot send it again", X, "select public.resend_report(%s)", [RD], contains="not sent by your team")
RTOK2 = one(RO, "select token from public.resend_report(%s)", [RD])
check("'Send again' issues a new link", RTOK2 is not None and RTOK2 != RTOK)
check("…the old link stops working at once", act(None, "select status from public.report_preview(%s)", [RTOK]) == [])
check("…and the new one shows the report for another 90 days",
      act(None, "select status from public.report_preview(%s)", [RTOK2]) == [("ok",)]
      and su("select link_expires_at > now() + interval '89 days' from public.report_deliveries where id = %s", [RD])[0][0])
su("update public.report_deliveries set link_expires_at = now() - interval '1 minute' where id = %s", [RD])
KIM = user("kim@landlord.test")
TK = one(KIM, "select id from public.create_organisation('Kim''s rentals', 'landlord')")
act(KIM, "select public.claim_report(%s, %s)", [RTOK2, TK])
check("saving the report still works after the link has expired",
      su("select recipient_team_id from public.report_deliveries where id = %s", [RD])[0][0] == TK)
check("once saved, the link asks for a sign-in instead of showing it (status saved)",
      act(None, "select status, provider, snapshot from public.report_preview(%s)", [RTOK2])
      == [("saved", "Signed Sparks", None)])

# ── S. the pre-A4 security review: F1–F11 ──────────────────────────────────
# One block per finding. Each failed on the drafts at d4bfeb2 and passes with
# its fix. F5's reopen check and F6 follow the rules chosen for notes 1 and 6.

# F1 — a started visit keeps its check (kind), site (location_id) and team (team_id).
print("\n— Review F1: a started visit keeps its check, site and team")
F1U = user("f1-owner@review.test")
F1T = one(F1U, "select id from public.create_organisation('F1 AV Only', 'provider', 'av')")   # Free; AV is its only pack
_, F1_L1 = add_site(F1U, F1T, "F1 One")
_, F1_L2 = add_site(F1U, F1T, "F1 Two")
F1_V = start_visit(F1U, F1T, F1_L1, "maintenance")   # this month's one free inspection
refused("F1: (insert gate, for contrast) a Free AV team cannot start a VIC check", F1U,
        "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'vic_electrical_safety')",
        [F1T, F1_L2], sqlstate="PT402")
refused("F1: …nor turn its AV visit into a VIC check by changing the kind", F1U,
        "update public.visits set kind = 'vic_electrical_safety' where id = %s", [F1_V], sqlstate="23514")
refused("F1: …nor move the month's one counted visit to another site to inspect that one uncounted", F1U,
        "update public.visits set location_id = %s where id = %s", [F1_L2, F1_V], sqlstate="23514")
F1T2 = one(F1U, "select id from public.create_organisation('F1 Second Team', 'provider', 'vic_rental')")
refused("F1: …nor move it into another of the person's teams", F1U,
        "update public.visits set team_id = %s where id = %s", [F1T2, F1_V])
act(F1U, """update public.visits set technician = 'Sam', kind = kind, location_id = location_id, team_id = team_id
             where id = %s""", [F1_V])
check("F1: an edit that sends the same check, site and team back still saves",
      su("select technician from public.visits where id = %s", [F1_V])[0][0] == "Sam")

# F2 — a team's join code is a credential, so it has to be too long to guess.
print("\n— Review F2: a team's join code cannot be guessed")
F2U = user("f2-owner@review.test")
F2T, F2_CODE = act(F2U, "select id, invite_code from public.create_organisation('F2 Co', 'provider', 'av')")[0]
check("F2: a new team's join code carries at least 60 bits (12 characters from a 32-letter alphabet)",
      len(F2_CODE) >= 12 and set(F2_CODE) <= set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789"), F2_CODE)
F2N = user("f2-today@review.test")
F2_TODAY = one(F2N, "select invite_code from public.create_team('F2 Today', '')")
check("F2: …and so does one made by today's create_team()", len(F2_TODAY) >= 12, F2_TODAY)
F2_SHORT = su("select count(*) from public.teams where length(invite_code) < 12")[0][0]
check("F2: …and no team that existed before is left on a 6-character code", F2_SHORT == 0, f"{F2_SHORT} short codes")
F2J = user("f2-joiner@review.test")
check("F2: the long code still joins (limits on, Pro team with a free seat)",
      su("update public.subscriptions set plan = 'pro', seats = 3 where team_id = %s", [F2T]) is None
      and one(F2J, "select public.join_team(%s)", [F2_CODE.lower()]).get("status") == "joined")

# F3 — "the address has to match" must not pass when the signed-in account has no address.
print("\n— Review F3: an account with no email address cannot claim a report or accept an invitation")
F3P = user("f3-provider@review.test")
F3TP = one(F3P, "select id from public.create_organisation('F3 Sparks', 'provider', 'vic_rental')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [F3TP])   # unlimited seats and visits
_, F3_L = add_site(F3P, F3TP, "F3 Rental")
F3_V = start_visit(F3P, F3TP, F3_L, "vic_smoke_alarm", completed=True)
F3_TOK = one(F3P, "select token from public.send_report(%s, 'owner@f3-landlord.test')", [F3_V])
F3_INV = one(F3P, "select token from public.create_invite(%s, 'colleague@f3-sparks.test')", [F3TP])
# Signed in, role authenticated, but auth.users.email is null: a phone or anonymous sign-in.
F3_NOMAIL = uuid.uuid4()
su("insert into auth.users (id, email) values (%s, null)", [F3_NOMAIL])
F3_TL = one(F3_NOMAIL, "select id from public.create_organisation('F3 Grabber', 'landlord')")
refused("F3: an account with no email address cannot save a report sent to someone else", F3_NOMAIL,
        "select public.claim_report(%s, %s)", [F3_TOK, F3_TL], contains="was sent to")
refused("F3: …nor accept an invitation sent to someone else", F3_NOMAIL,
        "select public.accept_invite(%s)", [F3_INV], contains="was sent to")
check("F3: …so the report is still waiting for its real recipient",
      su("select recipient_team_id is null from public.report_deliveries where token = %s", [F3_TOK])[0][0])

# F4 — a row hangs only off its own team's rows, for 0001's field data as well as 0007's tables.
print("\n— Review F4: rows hang only off their own team's rows")
F4A = user("f4-victim@review.test")
F4TA = one(F4A, "select id from public.create_organisation('F4 Victim', 'provider', 'av')")
F4_CA, F4_LA = add_site(F4A, F4TA, "F4 Victim", "Vic Client", "vic.client@f4.test")
F4_VA = start_visit(F4A, F4TA, F4_LA, "commissioning")
F4_FLOOR, F4_ROOM, F4_VR = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
act(F4A, "insert into public.floors (id, team_id, location_id, label) values (%s, %s, %s, 'Ground')", [F4_FLOOR, F4TA, F4_LA])
act(F4A, "insert into public.rooms (id, team_id, floor_id, name) values (%s, %s, %s, 'Boardroom')", [F4_ROOM, F4TA, F4_FLOOR])
act(F4A, "insert into public.visit_rooms (id, team_id, visit_id, room_id) values (%s, %s, %s, %s)",
    [F4_VR, F4TA, F4_VA, F4_ROOM])

F4X = user("f4-outsider@review.test")
F4TX = one(F4X, "select id from public.create_organisation('F4 Outsider', 'provider', 'av')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [F4TX])   # photos allowed
refused("F4: a member cannot start a visit at another team's site", F4X,
        "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'maintenance')",
        [F4TX, F4_LA], sqlstate="42501")
refused("F4: …nor add a site under another team's client", F4X,
        "insert into public.locations (client_id, team_id, address, suburb) values (%s, %s, 'Anywhere', 'Richmond')",
        [F4_CA, F4TX], sqlstate="42501")
refused("F4: …nor write results into another team's visit", F4X,
        "insert into public.visit_rooms (team_id, visit_id) values (%s, %s)", [F4TX, F4_VA], sqlstate="42501")
refused("F4: …nor hang a photo record off another team's visit room", F4X,
        "insert into public.attachments (team_id, visit_room_id, storage_path) values (%s, %s, %s)",
        [F4TX, F4_VR, f"{F4TX}/f4.jpg"], sqlstate="42501")
check("F4: the victim's own writes are unaffected",
      su("select count(*) from public.visit_rooms where visit_id = %s and team_id = %s", [F4_VA, F4TA])[0][0] == 1)

# F5 — the import window takes old work, once: not open visits banked for later, not new dates.
print("\n— Review F5: the import window takes old work, not banked open visits or new dates")
F5U = user("f5-owner@review.test")
F5T = one(F5U, "select id from public.create_organisation('F5 Import', 'provider', 'vic_rental')")   # Free: 1 a month
F5_SITES = [add_site(F5U, F5T, f"F5 Bank {i}")[1] for i in range(3)]
act(F5U, "select public.open_import_window(%s)", [F5T])
F5_BANKED = [start_visit(F5U, F5T, lid, "vic_smoke_alarm", started_at=now - timedelta(days=40)) for lid in F5_SITES]
su("update public.teams set import_open_until = now() - interval '1 second' where id = %s", [F5T])   # it closes
act(F5U, "update public.visits set completed_at = now() where id = %s", [F5_BANKED[0]])
check("F5: an open visit brought in through the window counts when it is finished after the window has closed",
      usage(F5T)[1] == 1, str(usage(F5T)))
refused("F5: …so open visits banked in the window cannot all be finished uncounted later", F5U,
        "update public.visits set completed_at = now() where id = %s", [F5_BANKED[1]], sqlstate="PT402")

F5W = user("f5-dates@review.test")
F5TW = one(F5W, "select id from public.create_organisation('F5 Dates', 'provider', 'vic_rental')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [F5TW])   # no allowance in the way
_, F5W_L1 = add_site(F5W, F5TW, "F5 Future")
_, F5W_L2 = add_site(F5W, F5TW, "F5 Today")
F5W_TODAY = start_visit(F5W, F5TW, F5W_L2, "vic_smoke_alarm", completed=True)   # finished today, before the window
act(F5W, "select public.open_import_window(%s)", [F5TW])
refused("F5: even inside the window, a completion date in the future is refused", F5W,
        """insert into public.visits (team_id, location_id, kind, started_at, completed_at)
           values (%s, %s, 'vic_smoke_alarm', now() - interval '400 days', now() + interval '400 days')""",
        [F5TW, F5W_L1], contains="in the future", sqlstate="23514")
refused("F5: …and the window does not let anyone re-date a visit that was finished today", F5W,
        "update public.visits set completed_at = now() - interval '300 days' where id = %s", [F5W_TODAY],
        sqlstate="23514")
act(F5W, "update public.visits set completed_at = null where id = %s", [F5W_TODAY])
try:   # refused or ignored, either keeps today's date
    act(F5W, "update public.visits set completed_at = now() - interval '300 days' where id = %s", [F5W_TODAY])
except psycopg.Error:
    pass
check("F5: …not even by reopening it first: completing it again keeps today's date",
      su("select local_day(completed_at) = local_day(now()) from public.visits where id = %s", [F5W_TODAY])[0][0])
F5W_OLD = start_visit(F5W, F5TW, F5W_L1, "vic_electrical_safety", started_at=now - timedelta(days=400))
act(F5W, "update public.visits set completed_at = %s where id = %s", [now - timedelta(days=399), F5W_OLD])
check("F5: …while old work imported the way migrate.js does it (insert open, then complete) still goes in",
      su("select local_day(completed_at) < local_day(now()) - 300 from public.visits where id = %s", [F5W_OLD])[0][0])

# F6 and note 6 — a client's emailed opt-out sticks, and every click on the link works.
print("\n— Review F6 and note 6: a client's emailed opt-out sticks")
F6U = user("f6-owner@review.test")
F6T = one(F6U, "select id from public.create_organisation('F6 Sparks', 'provider', 'vic_rental')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [F6T])   # two checks this month
_, F6_L = add_site(F6U, F6T, "F6 Rental", "Lee", "lee@f6-landlord.test")
start_visit(F6U, F6T, F6_L, "vic_smoke_alarm", completed=True)
F6_ITEM, F6_TOK = su("select id, reminder_token from public.compliance_items where location_id = %s", [F6_L])[0]


def f6_notices():
    return su("select count(*) from public.team_notices where team_id = %s and kind = 'reminder_opt_out'", [F6T])[0][0]


act(None, "select * from public.reminder_opt_out(%s)", [F6_TOK])
refused("note 6: once the client opts out from the email, the team cannot switch the reminders back on", F6U,
        "update public.compliance_items set reminders_enabled = true where id = %s", [F6_ITEM],
        contains="turned these reminders off", sqlstate="23514")
for _col, _val in (("opted_out_at", None), ("opted_out_via", None), ("reminder_token", uuid.uuid4()),
                   ("last_reminded_at", None), ("last_visit_id", None)):
    refused(f"note 6: …nor rewrite {_col}, which belongs to the opt-out and the reminder job", F6U,
            f"update public.compliance_items set {_col} = %s where id = %s", [_val, F6_ITEM], sqlstate="42501")
act(None, "select * from public.reminder_opt_out(%s)", [F6_TOK])
check("F6: clicking again on reminders already off changes nothing and tells nobody twice", f6_notices() == 1,
      f"{f6_notices()} notices")
# Should the client opt back in, only the service role can clear the opt-out; after that the link works again.
su("update public.compliance_items set reminders_enabled = true, opted_out_via = null where id = %s", [F6_ITEM])
act(None, "select * from public.reminder_opt_out(%s)", [F6_TOK])
check("F6: …and with reminders back on, the next click switches them off and tells the electrician again",
      su("select reminders_enabled from public.compliance_items where id = %s", [F6_ITEM])[0][0] is False
      and f6_notices() == 2, f"{f6_notices()} notices")
_, F6_L2 = add_site(F6U, F6T, "F6 Second")
start_visit(F6U, F6T, F6_L2, "vic_smoke_alarm", completed=True)
F6_ITEM2 = su("select id from public.compliance_items where location_id = %s", [F6_L2])[0][0]
act(F6U, "update public.compliance_items set reminders_enabled = false where id = %s", [F6_ITEM2])
act(F6U, "update public.compliance_items set reminders_enabled = true where id = %s", [F6_ITEM2])
check("note 6: a check the team switched off itself, from the Due page, can be switched back on",
      su("select reminders_enabled from public.compliance_items where id = %s", [F6_ITEM2])[0][0] is True)


def _as_user(conn, uid):
    conn.execute("select set_config('request.jwt.claim.sub', %s, true)", [str(uid)])
    conn.execute("set local role authenticated")


# F7 — the invitation seat check has to queue on the plan row, like the membership one does.
print("\n— Review F7: two invitations for the last seat at the same moment")
F7U = user("f7-owner@review.test")
F7T = one(F7U, "select id from public.create_organisation('F7 Race', 'provider', 'av')")
su("update public.subscriptions set plan = 'pro', seats = 2 where team_id = %s", [F7T])   # the owner and one more
F7_C1 = psycopg.connect(DSN, autocommit=True)
F7_C2 = psycopg.connect(DSN, autocommit=True)
with F7_C1.transaction():
    _as_user(F7_C1, F7U)
    F7_C1.execute("select public.create_invite(%s, 'first@f7.test')", [F7T])
    # The first invitation is not committed yet when the second one arrives.
    try:
        with F7_C2.transaction():
            _as_user(F7_C2, F7U)
            F7_C2.execute("set local lock_timeout = '2s'")
            F7_C2.execute("select public.create_invite(%s, 'second@f7.test')", [F7T])
        F7_SECOND = "let through"
    except psycopg.Error as e:
        F7_SECOND = f"{e.sqlstate}: {str(e).splitlines()[0]}"
F7_C1.close()
F7_C2.close()
check("F7: the second invitation waits for the first instead of slipping past the seat count",
      F7_SECOND != "let through", F7_SECOND)
F7_PENDING = su("select count(*) from public.team_invites where team_id = %s and accepted_at is null", [F7T])[0][0]
check("F7: …so a team with one free seat has one invitation out, not two", F7_PENDING == 1, f"{F7_PENDING} pending")

# F8 — swapping the starter pack has to wait for a visit being started under it.
print("\n— Review F8: swapping the starter pack while its first visit is being saved")
F8U = user("f8-owner@review.test")
F8T = one(F8U, "select id from public.create_organisation('F8 Race', 'provider', 'vic_rental')")
_, F8_L = add_site(F8U, F8T, "F8 Rental")
F8_C1 = psycopg.connect(DSN, autocommit=True)
F8_C2 = psycopg.connect(DSN, autocommit=True)
with F8_C1.transaction():
    _as_user(F8_C1, F8U)
    F8_C1.execute("insert into public.visits (team_id, location_id, kind) values (%s, %s, 'vic_smoke_alarm')",
                  [F8T, F8_L])
    # The first visit under vic_rental is not committed yet when the swap arrives.
    try:
        with F8_C2.transaction():
            _as_user(F8_C2, F8U)
            F8_C2.execute("set local lock_timeout = '2s'")
            F8_C2.execute("select public.choose_starter_pack(%s, 'qld_electrical')", [F8T])
        F8_SWAP = "let through"
    except psycopg.Error as e:
        F8_SWAP = f"{e.sqlstate}: {str(e).splitlines()[0]}"
F8_C1.close()
F8_C2.close()
check("F8: the swap waits for the visit being saved under the old pack instead of slipping past it",
      F8_SWAP != "let through", F8_SWAP)
F8_PACKS = [r[0] for r in su("select pack_id from public.team_packs where team_id = %s", [F8T])]
check("F8: …so the team still holds the pack its visit was started under", F8_PACKS == ["vic_rental"], str(F8_PACKS))

# F9 — the plan helpers answer for any team id they are given, so outsiders must not call them.
print("\n— Review F9: another team's plan and packs are not for outsiders to read")
F9A = user("f9-target@review.test")
F9TA = one(F9A, "select id from public.create_organisation('F9 Target', 'provider', 'vic_rental')")
F9X = user("f9-curious@review.test")
one(F9X, "select id from public.create_organisation('F9 Curious', 'provider', 'av')")
for _fn, _args in (("team_is_pro(%s)", [F9TA]), ("team_has_pack(%s, 'vic_rental')", [F9TA]),
                   ("team_seat_limit(%s)", [F9TA]), ("team_visit_limit(%s)", [F9TA])):
    refused(f"F9: an outsider cannot ask {_fn.split('(')[0]}() about another team", F9X,
            f"select public.{_fn}", _args, sqlstate="42501")
F9_EV = f"{F9TA}/{uuid.uuid4()}/p.jpg"
refused("F9: (unchanged) a Free team still cannot upload evidence", F9A,
        "insert into storage.objects (bucket_id, name) values ('evidence', %s)", [F9_EV], sqlstate="42501")
refused("F9: (unchanged) …nor record a photo", F9A,
        "insert into public.attachments (team_id, storage_path) values (%s, %s)", [F9TA, F9_EV], sqlstate="PT402")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [F9TA])
act(F9A, "insert into storage.objects (bucket_id, name) values ('evidence', %s)", [F9_EV])
act(F9A, "insert into public.attachments (team_id, storage_path) values (%s, %s)", [F9TA, F9_EV])
check("F9: (unchanged) …and a Pro team still uploads a photo and records it", True)

# F10 — the reports folder is undeletable, so it takes report PDFs and nothing else.
print("\n— Review F10: the reports folder takes report PDFs only")
F10U = user("f10-owner@review.test")
F10T = one(F10U, "select id from public.create_organisation('F10 Free', 'provider', 'vic_rental')")
refused("F10: a Free team cannot use its undeletable reports folder for photos or other files", F10U,
        "insert into storage.objects (bucket_id, name) values ('reports', %s)", [f"{F10T}/site-photo.jpg"],
        sqlstate="42501")
act(F10U, "insert into storage.objects (bucket_id, name) values ('reports', %s)", [f"{F10T}/{uuid.uuid4()}.pdf"])
check("F10: …while a report PDF, named as step D2 names it, still uploads", True)

# F11 — privileges are the second lock on every table, the 0001-0005 ones included.
print("\n— Review F11: anon holds no table privileges, so RLS is never the only lock")
F11_ANON = su("""select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind = 'r'
                    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
                         or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))""")[0][0]
check("F11: anon holds no privilege on any public table", F11_ANON == "", F11_ANON)
F11_PROBE = su("""select has_table_privilege('authenticated', 'public.email_probe_log', 'select')
                      or has_table_privilege('authenticated', 'public.email_probe_log', 'insert')""")[0][0]
check("F11: …and authenticated holds none on the probe log that 0004 says it is never granted", F11_PROBE is False)

# ── T. the review's notes, as decided ──────────────────────────────────────

# Note 1 — reopening a finished visit is for corrections: completing it again keeps its first completion date.
print("\n— Review note 1: a reopened visit keeps the date it was first completed")
N1U = user("n1-owner@review.test")
N1T = one(N1U, "select id from public.create_organisation('N1 Sparks', 'provider', 'vic_rental')")   # Free: 1 a month
_, N1_L = add_site(N1U, N1T, "N1 Rental")
N1_V = start_visit(N1U, N1T, N1_L, "vic_smoke_alarm", completed=True)   # this month's one inspection
check("note 1: completing a visit records when it was first completed",
      su("select first_completed_at = completed_at from public.visits where id = %s", [N1_V])[0][0])
# Make it last year's check (the superuser, triggers off).
su_raw("""update public.visits set started_at = now() - interval '370 days', completed_at = now() - interval '365 days',
                 first_completed_at = now() - interval '365 days' where id = %s""", [N1_V])
su_raw("""update public.compliance_items set last_done_on = (now() - interval '365 days')::date,
                 next_due_on = (now() - interval '365 days' + interval '12 months')::date where location_id = %s""", [N1_L])


def n1_state():
    return su("""select v.completed_at, c.next_due_on from public.visits v
                 join public.compliance_items c on c.location_id = v.location_id where v.id = %s""", [N1_V])[0]


N1_BEFORE = n1_state()
refused("note 1: (for contrast) with this month's inspection used, a new visit at the rental is refused", N1U,
        "insert into public.visits (team_id, location_id, kind) values (%s, %s, 'vic_smoke_alarm')", [N1T, N1_L],
        sqlstate="PT402")
act(N1U, "update public.visits set completed_at = null where id = %s", [N1_V])
act(N1U, "update public.visits set completed_at = now() where id = %s", [N1_V])
N1_AFTER = n1_state()
check("note 1: reopening last year's check and completing it again keeps last year's date",
      N1_AFTER[0] == N1_BEFORE[0], f"{N1_BEFORE} -> {N1_AFTER}")
check("note 1: …so the rental's due date does not move on", N1_AFTER[1] == N1_BEFORE[1], f"{N1_BEFORE} -> {N1_AFTER}")
check("note 1: …and a report sent from it again carries last year's date",
      one(N1U, "select completed_on from public.send_report(%s, 'owner@n1.test')", [N1_V])
      == su("select public.local_day(%s)", [N1_BEFORE[0]])[0][0])
refused("note 1: a completion date recorded more than 7 days ago cannot be changed directly", N1U,
        "update public.visits set completed_at = now() where id = %s", [N1_V],
        contains="can no longer be changed", sqlstate="23514")
try:   # refused or ignored, either keeps the record
    act(N1U, "update public.visits set first_completed_at = now() where id = %s", [N1_V])
except psycopg.Error:
    pass
check("note 1: …and when it was first completed is the database's to keep, not the app's",
      su("select first_completed_at from public.visits where id = %s", [N1_V])[0][0] == N1_BEFORE[0])

# F5, tightened — inside the window, a visit started in the last 7 days is today's work.
print("\n— Review F5, tightened: inside the import window only old work is old work")
W5U = user("w5-owner@review.test")
W5T = one(W5U, "select id from public.create_organisation('W5 Sparks', 'provider', 'vic_rental')")
su("update public.subscriptions set plan = 'pro' where team_id = %s", [W5T])
_, W5_L1 = add_site(W5U, W5T, "W5 Today")
_, W5_L2 = add_site(W5U, W5T, "W5 Old")
act(W5U, "select public.open_import_window(%s)", [W5T])
W5_V = start_visit(W5U, W5T, W5_L1, "vic_smoke_alarm")
refused("F5: inside the window, a visit started today still cannot be completed months ago", W5U,
        "update public.visits set completed_at = now() - interval '300 days' where id = %s", [W5_V], sqlstate="23514")
refused("no visit ends before it began, old work in the window included", W5U,
        """insert into public.visits (team_id, location_id, kind, started_at, completed_at)
           values (%s, %s, 'vic_smoke_alarm', now() - interval '400 days', now() - interval '500 days')""",
        [W5T, W5_L2], contains="before its start", sqlstate="23514")
su("update public.teams set import_open_until = now() - interval '1 second' where id = %s", [W5T])
refused("…nor today's work, by more than an hour's difference between two devices' clocks", W5U,
        "update public.visits set completed_at = now() - interval '2 hours' where id = %s", [W5_V],
        contains="before its start", sqlstate="23514")
# A row from before 0006 whose dates are out of order (a device with a wrong clock, say).
su_raw("update public.visits set completed_at = started_at - interval '1 day' where id = %s", [W5_V])
act(W5U, "update public.visits set technician = 'Sam', started_at = started_at, completed_at = completed_at where id = %s",
    [W5_V])
check("…while a visit already out of order still takes every other edit, the app re-sending its dates",
      su("select technician from public.visits where id = %s", [W5_V])[0][0] == "Sam")

# Note 4 — the grace clock survives a webhook that writes every column.
print("\n— Review note 4: the 7-day grace cannot be restarted or stretched by the webhook")
N4U = user("n4-owner@review.test")
N4T = one(N4U, "select id from public.create_organisation('N4 Billing', 'provider', 'av')")
su("update public.subscriptions set plan = 'pro', status = 'past_due' where team_id = %s", [N4T])


def n4_since():
    return su("select past_due_since from public.subscriptions where team_id = %s", [N4T])[0][0]


N4_FIRST = n4_since()
su("update public.subscriptions set status = 'past_due', past_due_since = null where team_id = %s", [N4T])
check("note 4: writing past_due_since empty while still past due keeps the first date", n4_since() == N4_FIRST)
su("update public.subscriptions set past_due_since = now() + interval '3 days' where team_id = %s", [N4T])
check("note 4: …and a later date cannot stretch the 7 days", n4_since() == N4_FIRST)
su("update public.subscriptions set past_due_since = %s where team_id = %s", [N4_FIRST - timedelta(days=2), N4T])
check("note 4: …while the webhook can still set an earlier one, from the failed invoice",
      n4_since() == N4_FIRST - timedelta(days=2))

# Note 5 — who signed off, and when it was saved, are the database's.
print("\n— Review note 5: the database records who signed off, and when")
N5U = user("n5-owner@review.test")
N5T = one(N5U, "select id from public.create_organisation('N5 Sparks', 'provider', 'vic_rental')")
_, N5_L = add_site(N5U, N5T, "N5 Rental")
N5_V = start_visit(N5U, N5T, N5_L, "vic_electrical_safety")
act(N5U, "update public.visits set signoff = %s where id = %s",
    [json.dumps({"technician": "Sam", "signature": "M0 0", "signed_by": str(uuid.uuid4()),
                 "recorded_at": "2020-01-01T00:00:00Z"}), N5_V])
N5_SO = su("select signoff from public.visits where id = %s", [N5_V])[0][0]
check("note 5: the sign-off records who was signed in, over anything the app sent",
      N5_SO.get("signed_by") == str(N5U), str(N5_SO))
check("note 5: …and when it was saved", "recorded_at" in N5_SO and datetime.fromisoformat(N5_SO["recorded_at"]) > now - timedelta(hours=1),
      str(N5_SO))
check("note 5: …and fills in the signing time if the app left it out", N5_SO.get("signed_at") is not None, str(N5_SO))
refused("note 5: a sign-off dated before the visit started is refused", N5U,
        "update public.visits set signoff = %s where id = %s",
        [json.dumps({"technician": "Sam", "signed_at": (now - timedelta(days=3)).isoformat()}), N5_V],
        contains="sign-off time", sqlstate="23514")
refused("note 5: …as is one dated in the future", N5U,
        "update public.visits set signoff = %s where id = %s",
        [json.dumps({"technician": "Sam", "signed_at": (now + timedelta(days=1)).isoformat()}), N5_V],
        contains="sign-off time", sqlstate="23514")

# Note 8 — a sent report is work under the starter pack, even once its visit is deleted.
print("\n— Review note 8: a sent report keeps the starter pack fixed")
N8U = user("n8-owner@review.test")
N8T = one(N8U, "select id from public.create_organisation('N8 Sparks', 'provider', 'vic_rental')")
_, N8_L = add_site(N8U, N8T, "N8 Rental")
N8_V = start_visit(N8U, N8T, N8_L, "vic_smoke_alarm", completed=True)
act(N8U, "select public.send_report(%s, 'owner@n8.test')", [N8_V])
act(N8U, "delete from public.visits where id = %s", [N8_V])
refused("note 8: deleting the visit does not free the starter pack once its report has gone out", N8U,
        "select public.choose_starter_pack(%s, 'qld_electrical')", [N8T], contains="cannot be swapped",
        sqlstate="PT402")

# Note 9 — a saved report stays saved if the account it was saved to is deleted.
print("\n— Review note 9: deleting the landlord's account does not reopen the report's link")
N9U = user("n9-provider@review.test")
N9T = one(N9U, "select id from public.create_organisation('N9 Sparks', 'provider', 'vic_rental')")
_, N9_L = add_site(N9U, N9T, "N9 Rental")
N9_V = start_visit(N9U, N9T, N9_L, "vic_smoke_alarm", completed=True)
N9_TOK = one(N9U, "select token from public.send_report(%s, 'pat@n9-landlord.test')", [N9_V])
N9L = user("pat@n9-landlord.test")
N9TL = one(N9L, "select id from public.create_organisation('Pat''s rentals', 'landlord')")
act(N9L, "select public.claim_report(%s, %s)", [N9_TOK, N9TL])
act(N9L, "delete from public.teams where id = %s", [N9TL])
check("note 9: the link still says saved, with no content, after the landlord's account is deleted",
      act(None, "select status, snapshot from public.report_preview(%s)", [N9_TOK]) == [("saved", None)])

# Note 11 — a pack the team already holds cannot also become its starter.
print("\n— Review note 11: choosing a pack the team already holds")
N11U = user("n11-owner@review.test")
N11T = one(N11U, "select id from public.create_organisation('N11 Sparks', 'provider', 'vic_rental')")
su("insert into public.team_packs (team_id, pack_id, source) values (%s, 'av', 'addon')", [N11T])   # the webhook
refused("note 11: a pack held as an add-on cannot also be chosen as the starter", N11U,
        "select public.choose_starter_pack(%s, 'av')", [N11T], contains="already has")
check("note 11: …so the team keeps its starter",
      su("select pack_id from public.team_packs where team_id = %s and source = 'starter'", [N11T]) == [("vic_rental",)])

print(f"\n{passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
