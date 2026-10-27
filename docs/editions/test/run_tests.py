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
           "signed_at": "2026-10-27T01:00:00Z", "signature": "M0 0 L10 10"}
act(RO, "update public.visits set signoff = %s, completed_at = now(), outcome = 'compliant' where id = %s",
    [json.dumps(SIGNOFF), RV])
RD, RTOK, RSNAP = act(RO, "select id, token, snapshot from public.send_report(%s, 'kim@landlord.test', %s)",
                      [RV, json.dumps({"signoff": {"technician": "Forged"}, "summary": "All good"})])[0]
check("the visit's sign-off reaches the delivered report, over anything the app sent",
      RSNAP["signoff"] == SIGNOFF and RSNAP["summary"] == "All good", str(RSNAP.get("signoff")))
check("the link's public view lasts 90 days",
      su("select link_expires_at::date - sent_at::date from public.report_deliveries where id = %s", [RD])[0][0] == 90)
pv = act(None, "select status, workflow, provider, snapshot from public.report_preview(%s)", [RTOK])
check("a fresh link shows the report (status ok)",
      pv and pv[0][0] == "ok" and pv[0][1] == "Electrical safety check" and pv[0][3]["signoff"] == SIGNOFF, str(pv))
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

print(f"\n{passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
