// The Supabase data layer.
//
// The database is snake_case and fully normalised; the app's components speak
// camelCase and expect the nested shape that clientStore.js has always handed
// them:
//
//   Client   { id, name, locations: [Location] }
//   Location { id, address, suburb, city, state, postcode, floors: [Floor] }
//   Floor    { id, label, rooms: [Room] }
//   Room     { id, name, planNumber }
//
// Keeping that shape is deliberate: the pages, the duplicate-detection logic and
// the report builder were all written against it, and none of them should have
// to change because the rows now live in Postgres. This file is the seam
// clientStore.js promised in its header comment.
//
// Every function throws on error rather than returning a result object. The
// callers already have Notice/ConfirmDialog for surfacing failures, and a thrown
// PostgrestError carries the code (42501 for a privilege failure, 23505 for a
// unique-index collision) that tells the difference between "you may not" and
// "that already exists".

import { supabase, emailRedirectUrl, inviteUrl } from './supabase.js'

// ─────────────────────────────────────────────────────────────────────────────
// Row → app mappers
// ─────────────────────────────────────────────────────────────────────────────

const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0)

// A friendlier message that keeps its code, which is what saveErrors.js goes by.
const coded = (message, code) => Object.assign(new Error(message), { code })

const PARENT = {
  clients: 'client',
  locations: 'site',
  floors: 'floor',
  rooms: 'room',
  visits: 'visit',
  assets: 'item',
}

/**
 * The security rules check that a new row hangs off a parent in the same team, and
 * they answer before the foreign key does. So a parent deleted on another device
 * comes back as "not allowed" (42501), not as a missing parent (23503), and the save
 * queue would keep trying a save that can never land. Looking for the parent tells
 * the two apart without reading the message: a missing one is reported with the code
 * that means it. Still there, or no way to look, and the refusal stands.
 *
 * Found by tests/offline-e2e.mjs against the real database. The stand-in in
 * tests/fake-server.mjs answers as this function does.
 */
async function whenParentGone(error, parents) {
  if (error?.code !== '42501') return error
  for (const [table, id] of parents) {
    if (!id) continue
    const { data, error: lookError } = await supabase.from(table).select('id').eq('id', id).maybeSingle()
    if (lookError) return error
    if (!data) return coded(`The ${PARENT[table]} this was saved under has been deleted.`, '23503')
  }
  return error
}

const roomFromRow = r => ({
  id: r.id,
  name: r.name ?? '',
  planNumber: r.plan_number ?? '',
  // A key from the pack, such as 'bedroom': it switches sections on and is what
  // coverage rules count by. Blank on a room nobody has typed.
  roomType: r.room_type ?? '',
  position: r.position ?? 0,
})

const roomToRow = (r, floorId, teamId, position) => ({
  ...(r.id ? { id: r.id } : {}),
  floor_id: floorId,
  team_id: teamId,
  name: r.name ?? '',
  plan_number: r.planNumber ?? '',
  room_type: r.roomType ?? '',
  position: position ?? r.position ?? 0,
})

const floorFromRow = r => ({
  id: r.id,
  label: r.label ?? '',
  position: r.position ?? 0,
  rooms: (r.rooms ?? []).sort(byPosition).map(roomFromRow),
})

const floorToRow = (f, locationId, teamId, position) => ({
  ...(f.id ? { id: f.id } : {}),
  location_id: locationId,
  team_id: teamId,
  label: f.label ?? '',
  position: position ?? f.position ?? 0,
})

const locationFromRow = r => ({
  id: r.id,
  clientId: r.client_id,
  address: r.address ?? '',
  suburb: r.suburb ?? '',
  city: r.city ?? '',
  state: r.state ?? '',
  postcode: r.postcode ?? '',
  floors: (r.floors ?? []).sort(byPosition).map(floorFromRow),
})

const locationToRow = l => ({
  address: l.address ?? '',
  suburb: l.suburb ?? '',
  city: l.city ?? '',
  state: l.state ?? '',
  postcode: l.postcode ?? '',
})

const clientFromRow = r => ({
  id: r.id,
  name: r.name ?? '',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  locations: (r.locations ?? []).map(locationFromRow),
})

// The app's three room states are 'not-started' | 'in-progress' | 'complete';
// the database column only permits the latter two. That is not a mismatch to
// paper over — 'not-started' is precisely the absence of a visit_rooms row, so
// a room nobody has touched costs nothing to store. Only the hyphen differs.
const statusFromRow = s => (s === 'in_progress' ? 'in-progress' : 'complete')
const statusToRow = s => (s === 'complete' ? 'complete' : 'in_progress')

const visitRoomFromRow = r => ({
  id: r.id,
  visitId: r.visit_id,
  roomId: r.room_id,
  roomName: r.room_name ?? '',
  planNumber: r.plan_number ?? '',
  floorLabel: r.floor_label ?? '',
  position: r.position ?? 0,
  results: r.results ?? {},
  readings: r.readings ?? {},
  troubleshooting: r.troubleshooting ?? {},
  // `sections` in the app, `sections_enabled` in the database — the column name
  // says what the value means, the app name is what the components already use.
  sections: r.sections_enabled ?? {},
  comments: r.comments ?? '',
  status: statusFromRow(r.status),
  fails: r.fails ?? 0,
  template: r.template ?? {},
  updatedAt: r.updated_at,
})

const visitRoomToRow = e => ({
  room_name: e.roomName ?? '',
  plan_number: e.planNumber ?? '',
  floor_label: e.floorLabel ?? '',
  position: e.position ?? 0,
  results: e.results ?? {},
  readings: e.readings ?? {},
  troubleshooting: e.troubleshooting ?? {},
  sections_enabled: e.sections ?? {},
  comments: e.comments ?? '',
  status: statusToRow(e.status),
  fails: e.fails ?? 0,
  template: e.template ?? {},
})

const visitFromRow = r => ({
  id: r.id,
  locationId: r.location_id,
  kind: r.kind,
  technician: r.technician ?? '',
  startedAt: r.started_at,
  completedAt: r.completed_at,
  // Set once a visit has been completed. On an open visit, that makes it a
  // correction being made to an earlier inspection, not a new one.
  firstCompletedAt: r.first_completed_at ?? null,
  createdBy: r.created_by,
  exportPreference: r.export_preference ?? null,
  // The whole-site step: sections done once per visit, and those repeated for
  // each item at the site. Shaped like a room (testTypes.js).
  siteResults: r.site_results ?? {},
  // The technician's declaration and signature at sign-off (C1), as the database
  // stamped it: who was signed in and when it was saved are added there.
  outcome: r.outcome ?? null,
  signoff: r.signoff ?? null,
  rooms: Object.fromEntries(
    (r.visit_rooms ?? [])
      .filter(vr => vr.room_id)
      .map(vr => [vr.room_id, visitRoomFromRow(vr)]),
  ),
  exports: (r.visit_exports ?? [])
    .map(x => ({
      id: x.id,
      revision: x.revision,
      filename: x.filename ?? '',
      createdAt: x.exported_at,
    }))
    .sort((a, b) => a.revision - b.revision),
})

const settingsFromRow = r => ({
  company: r.company ?? {},
  logoFull: r.logo_full ?? null,
  logoCollapsed: r.logo_collapsed ?? null,
  plate: r.plate ?? 'brass',
})

const settingsToRow = s => {
  const row = {}
  if ('company' in s) row.company = s.company ?? {}
  if ('logoFull' in s) row.logo_full = s.logoFull ?? null
  if ('logoCollapsed' in s) row.logo_collapsed = s.logoCollapsed ?? null
  if ('plate' in s) row.plate = s.plate ?? 'brass'
  return row
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts — the one call made before anybody is signed in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is there an account for this address?
 *
 * `resetPasswordForEmail` deliberately reports success either way, so that a
 * stranger cannot use the reset form to discover who has an account. Answering
 * the question directly gives that up: this RPC is an enumeration oracle, and
 * that is a considered trade, not an oversight — a technician who mistypes
 * their address on a job site otherwise waits for an email that will never
 * arrive, with nothing on screen to say why.
 *
 * The RPC is rate-limited per caller in 0004 to keep it from being scraped.
 */
export async function emailIsRegistered(email) {
  const { data, error } = await supabase.rpc('email_is_registered', {
    p_email: String(email ?? '').trim(),
  })
  if (error) throw error
  return Boolean(data)
}

// ─────────────────────────────────────────────────────────────────────────────
// Team settings, templates and per-member preferences
// ─────────────────────────────────────────────────────────────────────────────

export async function getTeamSettings(teamId) {
  const { data, error } = await supabase
    .from('team_settings')
    .select('*')
    .eq('team_id', teamId)
    .single()
  if (error) throw error
  return settingsFromRow(data)
}

// Admin-only at the database. A member calling this gets a zero-row update
// rather than an error — PostgREST reports RLS-filtered updates as success — so
// ask for the row back and treat "nothing returned" as the refusal it is.
export async function updateTeamSettings(teamId, patch) {
  const { data, error } = await supabase
    .from('team_settings')
    .update(settingsToRow(patch))
    .eq('team_id', teamId)
    .select()
  if (error) throw error
  if (!data?.length) throw coded('Only an admin can change the company settings.', '42501')
  return settingsFromRow(data[0])
}

export async function getTemplates(teamId) {
  const { data, error } = await supabase
    .from('team_templates')
    .select('kind, template')
    .eq('team_id', teamId)
  if (error) throw error
  return Object.fromEntries(data.map(r => [r.kind, r.template ?? {}]))
}

export async function saveTemplate(teamId, kind, template) {
  const { data, error } = await supabase
    .from('team_templates')
    .update({ template })
    .eq('team_id', teamId)
    .eq('kind', kind)
    .select()
  if (error) throw error
  if (!data?.length) throw coded('Only an admin can change the shared test lists.', '42501')
  return data[0].template
}

// create_team leaves the three template rows empty on purpose — the pack files
// in src/data/packs/ are the single source of truth, and the app seeds from them on
// first load. Anything already filled in is left alone, so this is safe to call
// on every boot and two technicians starting at once cannot clobber each other.
export async function seedTemplatesIfEmpty(teamId, seedByKind) {
  const existing = await getTemplates(teamId)
  const blank = kind => !existing[kind] || Object.keys(existing[kind]).length === 0
  const todo = Object.keys(seedByKind).filter(blank)
  if (!todo.length) return existing
  for (const kind of todo) {
    await saveTemplate(teamId, kind, seedByKind[kind])
  }
  return { ...existing, ...Object.fromEntries(todo.map(k => [k, seedByKind[k]])) }
}

export async function getMemberPrefs(teamId, userId) {
  const { data, error } = await supabase
    .from('member_prefs')
    .select('*')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  // The licence number is the member's own (0007). C3 lets them set it; until
  // then it is read, to fill in the sign-off.
  return { defaultTechnician: data?.default_technician ?? '', licenceNumber: data?.licence_number ?? '' }
}

export async function saveMemberPrefs(teamId, userId, patch) {
  const { error } = await supabase
    .from('member_prefs')
    .upsert(
      { team_id: teamId, user_id: userId, default_technician: patch.defaultTechnician ?? '' },
      { onConflict: 'team_id,user_id' },
    )
  if (error) throw error
}

// ─────────────────────────────────────────────────────────────────────────────
// Entitlements
// ─────────────────────────────────────────────────────────────────────────────

// Null if this person isn't in the team. A null limit is no limit.
export async function getEntitlements(teamId) {
  const { data, error } = await supabase.rpc('team_entitlements', { p_team_id: teamId })
  if (error) throw error
  if (!data) return null
  return {
    enforced: !!data.enforced,
    accountType: data.account_type ?? 'provider',
    plan: data.plan ?? 'free',
    isPro: !!data.is_pro,
    seatLimit: data.seat_limit ?? null,
    seatsUsed: Number(data.seats_used ?? 0),
    visitLimit: data.visit_limit ?? null,
    visitsUsed: Number(data.visits_used ?? 0),
    packs: data.packs ?? ['core'],
    pastDueUntil: data.past_due_until ?? null,
    cancelAt: data.cancel_at ?? null,
    importUsed: !!data.import_used,
    openVisits: Number(data.open_visits ?? 0),
    starterPack: data.starter_pack ?? null,
    starterInUse: !!data.starter_in_use,
  }
}

// Owner or admin. Refused with the plan's code once the old pack has been used.
export async function chooseStarterPack(teamId, packId) {
  const { error } = await supabase.rpc('choose_starter_pack', {
    p_team_id: teamId,
    p_pack_id: packId,
  })
  if (error) throw error
}

// ─────────────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────────────

export async function listMembers(teamId) {
  const { data, error } = await supabase.rpc('team_members_list', { p_team_id: teamId })
  if (error) throw error
  return data.map(m => ({
    userId: m.user_id,
    email: m.email,
    role: m.role,
    joinedAt: m.joined_at,
  }))
}

// Roles move ONLY through these RPCs. There is no UPDATE policy on
// team_members and `authenticated` has UPDATE revoked on it, so a direct table
// write would fail — but the real reason is that RLS cannot restrict which
// columns an UPDATE touches, which would make any self-update policy a route to
// role='owner'. PM v2 patched the table directly; do not copy that here.
export async function setMemberRole(teamId, userId, role) {
  const { error } = await supabase.rpc('set_member_role', {
    p_team_id: teamId,
    p_user_id: userId,
    p_role: role,
  })
  if (error) throw error
}

export async function transferOwnership(teamId, userId) {
  const { error } = await supabase.rpc('transfer_ownership', {
    p_team_id: teamId,
    p_user_id: userId,
  })
  if (error) throw error
}

// Every account in every team you administer — the Teams page roster. Distinct
// from listMembers, which answers the same question for one team.
export async function listAllMembers() {
  const { data, error } = await supabase.rpc('all_members_overview')
  if (error) throw error
  return data.map(m => ({
    userId: m.user_id,
    email: m.email,
    teamId: m.team_id,
    teamName: m.team_name,
    role: m.role,
    joinedAt: m.joined_at,
  }))
}

// Owner of both teams, and never a team's own owner. Their clients and visits
// do not travel with them — those belong to the team — so this changes only
// which work they can see.
export async function moveMember(userId, fromTeamId, toTeamId) {
  const { error } = await supabase.rpc('move_member', {
    p_user_id: userId,
    p_from_team_id: fromTeamId,
    p_to_team_id: toTeamId,
  })
  if (error) throw error
}

export async function removeMember(teamId, userId) {
  const { data, error } = await supabase
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .select()
  if (error) throw error
  if (!data?.length) throw new Error('You do not have permission to remove that person.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Teams and invitations
// ─────────────────────────────────────────────────────────────────────────────

// A new team that knows what it is. All six arguments, because the sign-up function
// is the overload in 0008 that takes all six.
export async function createOrganisation({ name, description, accountType, packId, state, addons }) {
  const { data, error } = await supabase.rpc('create_organisation', {
    p_name: name,
    p_account_type: accountType,
    p_pack_id: packId ?? null,
    p_description: description ?? '',
    p_state: state ?? null,
    p_addons: addons ?? [],
  })
  if (error) throw error
  return data
}

// Admin-only at the database, and reported the same way as team_settings: RLS
// turns a refused update into zero rows rather than an error.
export async function updateTeam(teamId, patch) {
  const row = {}
  if ('name' in patch) row.name = String(patch.name ?? '').trim()
  if ('description' in patch) row.description = String(patch.description ?? '').trim()
  const { data, error } = await supabase.from('teams').update(row).eq('id', teamId).select()
  if (error) throw error
  if (!data?.length) throw new Error('Only an owner or admin can change this team.')
  return { name: data[0].name, description: data[0].description ?? '' }
}

const inviteFromRow = i => ({
  id: i.id,
  email: i.email,
  token: i.token,
  createdAt: i.created_at,
  expiresAt: i.expires_at,
  acceptedAt: i.accepted_at,
})

// Returns the token as well as the row: whoever asked for the invitation is
// the one who has to deliver it.
export async function createInvite(teamId, email) {
  const { data, error } = await supabase.rpc('create_invite', {
    p_team_id: teamId,
    p_email: email,
  })
  if (error) throw error
  return inviteFromRow(data)
}

/**
 * Invite somebody and, if there is a mailer, email them the link.
 *
 * Falls all the way back to createInvite when the function is not deployed.
 * That is not defensive padding — the Edge Function is deployed separately from
 * the app, so there is a window where the built site is ahead of it, and an
 * invitation that has to be copied by hand is a great deal better than a button
 * that fails.
 *
 * Always returns { link, emailed }: the caller says "emailed to them" or "send
 * them this" from the same shape, and never claims an email that did not go.
 */
export async function sendInvite(teamId, email) {
  try {
    const { data, error } = await supabase.functions.invoke('send-invite', {
      body: { teamId, email, appUrl: emailRedirectUrl() },
    })
    // A non-2xx carries our own { error } body, which is the useful message —
    // FunctionsHttpError's own text is only ever "non-2xx status code". The code and
    // hint come with it, which is how a full team is told from any other refusal.
    if (error) {
      const said = await error.context?.json?.().catch(() => null)
      if (said?.error) {
        throw Object.assign(new Error(said.error), { code: said.code, hint: said.hint })
      }
      throw error
    }
    return { link: data.link, emailed: Boolean(data.emailed), email: data.email ?? email }
  } catch (e) {
    // Only a missing or unreachable function falls through to the direct RPC.
    // A refusal — not an admin, address already in the team — is a real answer
    // and has to surface, not be quietly retried into the same refusal.
    if (e instanceof Error && !/fetch|network|Failed to send|not found/i.test(e.message)) throw e
    const invite = await createInvite(teamId, email)
    return { link: inviteUrl(invite.token), emailed: false, email: invite.email }
  }
}

/**
 * Delete the account itself, not just the membership.
 *
 * Needs the service-role key, so it can only happen in an Edge Function. The
 * guards live there too — owner of the team, target owns nothing, target is in
 * no other team — because they are decisions about the whole database rather
 * than about one team's rows.
 */
export async function deleteAccount(userId, teamId) {
  const { data, error } = await supabase.functions.invoke('delete-account', {
    body: { userId, teamId },
  })
  if (error) {
    const said = await error.context?.json?.().catch(() => null)
    throw new Error(said?.error ?? 'Deleting the account failed. Is the function deployed?')
  }
  if (!data?.deleted) throw new Error(data?.error ?? 'Deleting the account failed.')
}

// Outstanding only. A spent invitation is history, and the person is in the
// roster below it by then anyway.
export async function listInvites(teamId) {
  const { data, error } = await supabase
    .from('team_invites')
    .select('*')
    .eq('team_id', teamId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data.map(inviteFromRow)
}

export async function revokeInvite(inviteId) {
  const { data, error } = await supabase
    .from('team_invites')
    .delete()
    .eq('id', inviteId)
    .select()
  if (error) throw error
  if (!data?.length) throw new Error('You do not have permission to revoke that invitation.')
}

// Callable with no session — it is what the sign-up screen asks before anyone
// has an account. Returns null for a token that never existed.
export async function previewInvite(token) {
  const { data, error } = await supabase.rpc('invite_preview', { p_token: token })
  if (error) throw error
  const row = data?.[0]
  return row
    ? { email: row.email, teamName: row.team_name, expired: row.expired, accepted: row.accepted }
    : null
}

// For somebody who already has an account. A new account gets its membership
// from the confirm trigger instead, since that is when the address is proven.
//
// Once the editions migration is in, a team with no seat left answers
// { status: 'full' } rather than an error — an error would undo the cancelled
// invitation and the notice to the admins. Before it, the answer is the team
// row itself, which has no status and is read the same way.
export async function acceptInvite(token) {
  const { data, error } = await supabase.rpc('accept_invite', { p_token: token })
  if (error) throw error
  if (data?.status === 'full') throw new Error('This team is full. Ask the person who invited you.')
  return { id: data.id, name: data.name }
}

/**
 * Opens the team's one-time window for importing older work. Owner only.
 *
 * Returns 'open' (until the time given), 'used' when the team has had its
 * window, or 'unavailable' before the editions migration exists, when there is
 * no window and no date check to need one. Anything else is a real refusal and
 * is thrown.
 */
export async function openImportWindow(teamId) {
  const { data, error } = await supabase.rpc('open_import_window', { p_team_id: teamId })
  if (!error) return { status: 'open', until: data }
  if (error.code === 'PT409') return { status: 'used' }
  if (error.code === 'PGRST202') return { status: 'unavailable' }
  throw error
}

// ─────────────────────────────────────────────────────────────────────────────
// Clients → locations → floors → rooms
// ─────────────────────────────────────────────────────────────────────────────

// One round trip for the whole tree. The nesting is what the components expect,
// and a site with a few hundred rooms is still a small payload.
const CLIENT_TREE = '*, locations(*, floors(*, rooms(*)))'

export async function listClients(teamId) {
  const { data, error } = await supabase
    .from('clients')
    .select(CLIENT_TREE)
    .eq('team_id', teamId)
    .order('name', { ascending: true })
  if (error) throw error
  return data.map(clientFromRow)
}

export async function getClient(clientId) {
  const { data, error } = await supabase
    .from('clients')
    .select(CLIENT_TREE)
    .eq('id', clientId)
    .single()
  if (error) throw error
  return clientFromRow(data)
}

// 23505 is a unique-index violation. The app checks for duplicates before
// writing, but two technicians on two devices can pass that check at the same
// moment; the index is what actually decides, so name the collision rather than
// surfacing a raw Postgres error.
const isDuplicate = e => e?.code === '23505'

// `id` is supplied by the caller, not left to gen_random_uuid(). The app mints
// uuids client-side and hands them to React as keys and to the cache as the
// identity of every row; if Postgres generated its own, the cache and the
// database would disagree about what a thing is called and every subsequent
// update would silently address a row that does not exist.
//
// It also makes these inserts safe to repeat. A save can land with the answer lost
// on the way back, and then it is sent again: the row's own id is what says "this
// is the one you already made" rather than "someone else has that name".
export async function createClient(teamId, name, id) {
  const { data, error } = await supabase
    .from('clients')
    .insert({ ...(id ? { id } : {}), team_id: teamId, name: String(name ?? '').trim() })
    .select(CLIENT_TREE)
    .single()
  if (isDuplicate(error)) {
    if (id) {
      const { data: mine } = await supabase
        .from('clients')
        .select(CLIENT_TREE)
        .eq('id', id)
        .maybeSingle()
      if (mine) return clientFromRow(mine)
    }
    throw coded(`A client named "${name}" already exists.`, '23505')
  }
  if (error) throw error
  return clientFromRow(data)
}

export async function renameClient(clientId, name) {
  const { error } = await supabase
    .from('clients')
    .update({ name: String(name ?? '').trim() })
    .eq('id', clientId)
  if (isDuplicate(error)) throw coded(`A client named "${name}" already exists.`, '23505')
  if (error) throw error
}

export async function deleteClient(clientId) {
  const { error } = await supabase.from('clients').delete().eq('id', clientId)
  if (error) throw error
}

export async function addLocation(teamId, clientId, details, id) {
  const { data, error } = await supabase
    .from('locations')
    .insert({
      ...(id ? { id } : {}),
      team_id: teamId,
      client_id: clientId,
      ...locationToRow(details),
    })
    .select('*, floors(*, rooms(*))')
    .single()
  if (isDuplicate(error)) {
    if (id) {
      const { data: mine } = await supabase
        .from('locations')
        .select('*, floors(*, rooms(*))')
        .eq('id', id)
        .maybeSingle()
      if (mine) return locationFromRow(mine)
    }
    throw coded('That address and suburb already exist for this client.', '23505')
  }
  if (error) throw await whenParentGone(error, [['clients', clientId]])
  return locationFromRow(data)
}

export async function updateLocation(locationId, details) {
  const { error } = await supabase
    .from('locations')
    .update(locationToRow(details))
    .eq('id', locationId)
  if (isDuplicate(error)) throw coded('That address and suburb already exist for this client.', '23505')
  if (error) throw error
}

export async function deleteLocation(locationId) {
  const { error } = await supabase.from('locations').delete().eq('id', locationId)
  if (error) throw error
}

export async function addFloor(teamId, locationId, floor, position) {
  const { data, error } = await supabase
    .from('floors')
    .insert(floorToRow(floor, locationId, teamId, position))
    .select('*, rooms(*)')
    .single()
  // Its id is the only unique thing about a floor, so this is an insert that
  // already landed.
  if (isDuplicate(error)) return floor
  if (error) throw await whenParentGone(error, [['locations', locationId]])
  return floorFromRow(data)
}

export async function updateFloor(floorId, patch) {
  const row = {}
  if ('label' in patch) row.label = patch.label ?? ''
  if ('position' in patch) row.position = patch.position ?? 0
  const { error } = await supabase.from('floors').update(row).eq('id', floorId)
  if (error) throw error
}

export async function deleteFloor(floorId) {
  const { error } = await supabase.from('floors').delete().eq('id', floorId)
  if (error) throw error
}

export async function addRoom(teamId, floorId, room, position) {
  const { data, error } = await supabase
    .from('rooms')
    .insert(roomToRow(room, floorId, teamId, position))
    .select()
    .single()
  // As for a floor: only its id is unique.
  if (isDuplicate(error)) return room
  if (error) throw await whenParentGone(error, [['floors', floorId]])
  return roomFromRow(data)
}

export async function updateRoom(roomId, patch) {
  const row = {}
  if ('name' in patch) row.name = patch.name ?? ''
  if ('planNumber' in patch) row.plan_number = patch.planNumber ?? ''
  if ('roomType' in patch) row.room_type = patch.roomType ?? ''
  if ('position' in patch) row.position = patch.position ?? 0
  const { error } = await supabase.from('rooms').update(row).eq('id', roomId)
  if (error) throw error
}

export async function deleteRoom(roomId) {
  const { error } = await supabase.from('rooms').delete().eq('id', roomId)
  if (error) throw error
}

/**
 * Replaces a location's floor plan wholesale — the shape FloorsEditor produces.
 *
 * Deletes what disappeared, updates what stayed and inserts what is new, rather
 * than deleting every floor and re-adding: `rooms.id` is what visit_rooms points
 * at, and recreating a room would orphan every result recorded against it.
 * Floors and rooms already pruned by clientStore.pruneFloors are expected here.
 */
export async function saveFloorPlan(teamId, locationId, floors) {
  const before = await supabase
    .from('floors')
    .select('id, rooms(id)')
    .eq('location_id', locationId)
  if (before.error) throw before.error

  const keptFloors = new Set(floors.map(f => f.id).filter(Boolean))
  const goneFloors = before.data.filter(f => !keptFloors.has(f.id)).map(f => f.id)
  if (goneFloors.length) {
    const { error } = await supabase.from('floors').delete().in('id', goneFloors)
    if (error) throw error
  }

  const roomsBefore = new Map(before.data.map(f => [f.id, (f.rooms ?? []).map(r => r.id)]))

  for (const [i, floor] of floors.entries()) {
    let floorId = floor.id
    if (floorId && keptFloors.has(floorId) && roomsBefore.has(floorId)) {
      await updateFloor(floorId, { label: floor.label, position: i })
    } else {
      floorId = (await addFloor(teamId, locationId, floor, i)).id
    }

    const kept = new Set((floor.rooms ?? []).map(r => r.id).filter(Boolean))
    const gone = (roomsBefore.get(floor.id) ?? []).filter(id => !kept.has(id))
    if (gone.length) {
      const { error } = await supabase.from('rooms').delete().in('id', gone)
      if (error) throw error
    }

    for (const [j, room] of (floor.rooms ?? []).entries()) {
      const known = (roomsBefore.get(floor.id) ?? []).includes(room.id)
      if (known) await updateRoom(room.id, { ...room, position: j })
      else await addRoom(teamId, floorId, room, j)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment
// ─────────────────────────────────────────────────────────────────────────────
//
// The items at a site, such as smoke alarms and RCDs, each optionally pinned to a
// room. Removed, never deleted, so a past report still names the alarm it tested.

const assetFromRow = r => ({
  id: r.id,
  locationId: r.location_id,
  roomId: r.room_id ?? null,
  assetType: r.asset_type,
  label: r.label ?? '',
  make: r.make ?? '',
  model: r.model ?? '',
  serial: r.serial ?? '',
  // The pack's own fields for this type, such as a smoke alarm's power source.
  attributes: r.attributes ?? {},
  installedOn: r.installed_on ?? null,
  expiresOn: r.expires_on ?? null,
  removedAt: r.removed_at ?? null,
  createdAt: r.created_at,
})

// What an edit can change, each with what a blank is stored as. Which site an
// item is at, and when it was added, never change.
const ASSET_COLUMNS = {
  roomId: ['room_id', null],
  assetType: ['asset_type', ''],
  label: ['label', ''],
  make: ['make', ''],
  model: ['model', ''],
  serial: ['serial', ''],
  attributes: ['attributes', {}],
  installedOn: ['installed_on', null],
  expiresOn: ['expires_on', null],
  removedAt: ['removed_at', null],
}

const assetToRow = patch =>
  Object.fromEntries(
    Object.entries(ASSET_COLUMNS)
      .filter(([key]) => key in patch)
      .map(([key, [column, blank]]) => [column, patch[key] ?? blank]),
  )

// Every item in the team, removed ones included, in one round trip.
export async function listAssets(teamId) {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(assetFromRow)
}

/**
 * Adds an item under its own id. Its added date is the device's, so an item added
 * offline during a visit still stood at the site when that visit finished.
 */
export async function addAsset(teamId, locationId, asset) {
  const { data, error } = await supabase
    .from('assets')
    .insert({
      id: asset.id,
      team_id: teamId,
      location_id: locationId,
      ...(asset.createdAt ? { created_at: asset.createdAt } : {}),
      ...assetToRow(asset),
    })
    .select()
    .single()
  // Sent again after its answer was lost: it's already in.
  if (isDuplicate(error)) return asset
  if (error) throw await whenParentGone(error, [['locations', locationId], ['rooms', asset.roomId]])
  return assetFromRow(data)
}

export async function updateAsset(assetId, patch) {
  const { data, error } = await supabase
    .from('assets')
    .update(assetToRow(patch))
    .eq('id', assetId)
    .select('id')
  if (error) throw await whenParentGone(error, [['assets', assetId], ['rooms', patch.roomId]])
  // Gone with its site, deleted on another device.
  if (!data?.length) throw coded('This item has been deleted on another device.', '23503')
}

// ─────────────────────────────────────────────────────────────────────────────
// Visits
// ─────────────────────────────────────────────────────────────────────────────

const VISIT_TREE = '*, visit_rooms(*), visit_exports(*)'

export async function listVisits(locationId, kind) {
  let q = supabase.from('visits').select(VISIT_TREE).eq('location_id', locationId)
  if (kind) q = q.eq('kind', kind)
  const { data, error } = await q.order('started_at', { ascending: false })
  if (error) throw error
  return data.map(visitFromRow)
}

// Every visit in the team, with its rooms and exports, in one round trip. The
// cache hydrates the whole tree at once, so asking per location would mean one
// request per site on every sign-in.
export async function listVisitsForTeam(teamId) {
  const { data, error } = await supabase
    .from('visits')
    .select(VISIT_TREE)
    .eq('team_id', teamId)
    .order('started_at', { ascending: false })
  if (error) throw error
  return data.map(visitFromRow)
}

export async function deleteVisitRoom(visitId, roomId) {
  const { error } = await supabase
    .from('visit_rooms')
    .delete()
    .eq('visit_id', visitId)
    .eq('room_id', roomId)
  if (error) throw error
}

export async function getVisit(visitId) {
  const { data, error } = await supabase
    .from('visits')
    .select(VISIT_TREE)
    .eq('id', visitId)
    .single()
  if (error) throw error
  return visitFromRow(data)
}

export async function openVisit(locationId, kind) {
  const { data, error } = await supabase
    .from('visits')
    .select(VISIT_TREE)
    .eq('location_id', locationId)
    .eq('kind', kind)
    .is('completed_at', null)
    .maybeSingle()
  if (error) throw error
  return data ? visitFromRow(data) : null
}

/**
 * Starts a visit, or returns the one already open for this location and kind.
 *
 * The partial unique index makes "only one open visit per kind" true even when
 * two devices ask at the same instant; the loser gets 23505 and is handed the
 * winner's visit, which is what it wanted anyway. A returned id other than the
 * one asked for is how the caller knows it was handed someone else's.
 *
 * 23505 also comes back when this very visit is already in: a save that landed
 * with its answer lost, sent again. So its own id is looked for first.
 *
 * A visit finished before it reached the database goes in finished. It isn't
 * open, so the index has nothing to say about it, and it is an inspection of its
 * own however many others are open at the site.
 */
export async function startVisit(teamId, locationId, kind, technician, userId, id, startedAt, completedAt) {
  const insert = () =>
    supabase
      .from('visits')
      .insert({
        ...(id ? { id } : {}),
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(completedAt ? { completed_at: completedAt } : {}),
        team_id: teamId,
        location_id: locationId,
        kind,
        // Copied, not referenced: changing the default technician later must not
        // rewrite who attended a visit months ago.
        technician: technician ?? '',
        created_by: userId ?? null,
      })
      .select(VISIT_TREE)
      .single()

  const { data, error } = await insert()
  if (!isDuplicate(error)) {
    if (error) throw await whenParentGone(error, [['locations', locationId]])
    return visitFromRow(data)
  }

  if (id) {
    const { data: mine, error: findError } = await supabase
      .from('visits')
      .select(VISIT_TREE)
      .eq('id', id)
      .maybeSingle()
    if (findError) throw findError
    if (mine) return visitFromRow(mine)
  }
  const open = await openVisit(locationId, kind)
  if (open) return open

  // Finished in the moment between, so nothing is in the way any more.
  const retried = await insert()
  if (retried.error) throw await whenParentGone(retried.error, [['locations', locationId]])
  return visitFromRow(retried.data)
}

export async function updateVisit(visitId, patch) {
  const row = {}
  if ('technician' in patch) row.technician = patch.technician ?? ''
  if ('completedAt' in patch) row.completed_at = patch.completedAt
  if ('exportPreference' in patch) row.export_preference = patch.exportPreference ?? null
  if ('siteResults' in patch) row.site_results = patch.siteResults ?? {}
  if ('outcome' in patch) row.outcome = patch.outcome ?? null
  if ('signoff' in patch) row.signoff = patch.signoff ?? null
  const { data, error } = await supabase
    .from('visits')
    .update(row)
    .eq('id', visitId)
    .select('id, completed_at')
  if (error) throw error
  // Every member can write a visit, so no row back means it isn't there any more:
  // deleted on another device, while this one held changes to it.
  if (!data?.length) throw coded('This visit has been deleted on another device.', 'VISIT_GONE')
  // A reopened visit finished again keeps the date it was first finished (0006),
  // whatever this device sent.
  return { completedAt: data[0].completed_at }
}

/** A visit's whole-site step as the database holds it now, or null if the visit has gone. */
export async function getVisitSite(visitId) {
  const { data, error } = await supabase
    .from('visits')
    .select('site_results')
    .eq('id', visitId)
    .maybeSingle()
  if (error) throw error
  return data ? (data.site_results ?? {}) : null
}

export const completeVisit = visitId =>
  updateVisit(visitId, { completedAt: new Date().toISOString() })

export async function deleteVisit(visitId) {
  const { error } = await supabase.from('visits').delete().eq('id', visitId)
  if (error) throw error
}

/**
 * Writes one room's results within a visit.
 *
 * Upsert on (visit_id, room_id) so the first edit creates the row and every
 * later one updates it — the caller never has to know which case it is, and two
 * rapid saves cannot race into two rows.
 */
export async function saveVisitRoom(teamId, visitId, roomId, entry) {
  const { data, error } = await supabase
    .from('visit_rooms')
    .upsert(
      { team_id: teamId, visit_id: visitId, room_id: roomId, ...visitRoomToRow(entry) },
      { onConflict: 'visit_id,room_id' },
    )
    .select()
    .single()
  // The visit first: if that has gone, so has everything in it.
  if (error) throw await whenParentGone(error, [['visits', visitId], ['rooms', roomId]])
  return visitRoomFromRow(data)
}

// Without its test list, which only matters if there is something to merge.
const ROOM_ANSWERS = 'results, readings, troubleshooting, sections_enabled, comments, status, fails, updated_at'

/** One room as the database holds it now, or null if it holds no such row. */
export async function getVisitRoom(visitId, roomId, { withTemplate = false } = {}) {
  const { data, error } = await supabase
    .from('visit_rooms')
    .select(withTemplate ? '*' : ROOM_ANSWERS)
    .eq('visit_id', visitId)
    .eq('room_id', roomId)
    .maybeSingle()
  if (error) throw error
  return data ? visitRoomFromRow(data) : null
}

export async function visitExists(visitId) {
  const { data, error } = await supabase.from('visits').select('id').eq('id', visitId).maybeSingle()
  if (error) throw error
  return !!data
}

/**
 * A room's answers when the room itself has been deleted from the floor plan, on
 * another device, while this one was recording into it. It goes in with no room,
 * under its copied labels: the state a deleted room's results are left in anyway.
 */
export async function saveRoomlessVisitRoom(teamId, visitId, entry) {
  const { error } = await supabase
    .from('visit_rooms')
    .insert({ team_id: teamId, visit_id: visitId, room_id: null, ...visitRoomToRow(entry) })
  if (error) throw await whenParentGone(error, [['visits', visitId]])
}

// No row to delete is fine: another device got there first.
export async function deleteExport(visitId, revision) {
  const { error } = await supabase
    .from('visit_exports')
    .delete()
    .eq('visit_id', visitId)
    .eq('revision', revision)
  if (error) throw error
}

export async function recordExport(teamId, visitId, revision, filename, userId) {
  const { data, error } = await supabase
    .from('visit_exports')
    .upsert(
      {
        team_id: teamId,
        visit_id: visitId,
        revision,
        filename: filename ?? '',
        exported_by: userId ?? null,
      },
      { onConflict: 'visit_id,revision' },
    )
    .select()
    .single()
  if (error) throw await whenParentGone(error, [['visits', visitId]])
  return {
    id: data.id,
    revision: data.revision,
    filename: data.filename ?? '',
    createdAt: data.exported_at,
  }
}
