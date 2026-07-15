// Whatsapp plugin module implements group members behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeE164 } from "../../text-runtime.js";

const LID_JID_RE = /@(lid|hosted\.lid)$/i;
const DEFAULT_PEOPLE_DIR_RELATIVE = path.join("memory", "people");
const DEFAULT_CONTACTS_FILE_NAME = "_contacts.json";
const DEFAULT_MISSING_PERSON_FILE_NOTE = "people file missing, update `{contactsPath}`";
const NUDGE_WINDOW_MS = 24 * 60 * 60 * 1000;

type ContactEntry = {
  identifiers?: unknown;
  autoName?: unknown;
  nameOverride?: unknown;
  personFile?: unknown;
  nicknames?: unknown;
};

type ContactRecord = {
  displayName?: string;
  personFile?: string;
  nicknames: string[];
};

export type WhatsAppGroupRosterOptions = {
  /** Display name rendered for the agent's own roster entry (default: agent id). */
  selfDisplayName?: string;
  /** Note rendered on the self entry (never the missing-file nudge). */
  selfNote?: string;
  /** Nudge template for members without a person file; {contactsPath} expands. */
  missingPersonFileNote?: string;
  /** Owner pin: matched by display name or person-file basename, sorts second. */
  owner?: {
    name?: string;
    personFile?: string;
  };
  workspaceContacts?: {
    enabled?: boolean;
    peopleDir?: string;
    contactsFile?: string;
  };
};

// Core owns the roster-entry contract (feature 15 consumes it); re-exported
// here so plugin-local callers keep their import site.
import type { ResolvedGroupMemberContext } from "openclaw/plugin-sdk/reply-runtime";
export type { ResolvedGroupMemberContext } from "openclaw/plugin-sdk/reply-runtime";

export type GroupMemberIdentity = {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  e164?: string | null;
  name?: string | null;
  self?: boolean;
};

type ResolvedGroupMember = ResolvedGroupMemberContext & {
  nicknames?: string[];
};

type GroupMemberResolution = {
  members: ResolvedGroupMemberContext[];
  rendered?: string;
};

// The missing-person-file nudge is how the contacts registry gets maintained,
// but rendering it on every group message drowns the context: rate-limit to
// once per person per day (per process; a restart may re-nudge early).
const nudgeLastRenderedAtByPerson = new Map<string, number>();

function shouldRenderMissingPersonFileNudge(personKey: string, nowMs: number): boolean {
  const last = nudgeLastRenderedAtByPerson.get(personKey);
  if (last !== undefined && nowMs - last < NUDGE_WINDOW_MS) {
    return false;
  }
  nudgeLastRenderedAtByPerson.set(personKey, nowMs);
  if (nudgeLastRenderedAtByPerson.size > 2048) {
    const oldest = nudgeLastRenderedAtByPerson.keys().next();
    if (!oldest.done) {
      nudgeLastRenderedAtByPerson.delete(oldest.value);
    }
  }
  return true;
}

export function resetGroupRosterNudgesForTests(): void {
  nudgeLastRenderedAtByPerson.clear();
}

export function noteGroupMember(
  groupMemberNames: Map<string, Map<string, string>>,
  conversationId: string,
  e164?: string,
  name?: string,
) {
  if (!e164 || !name) {
    return;
  }
  const normalized = normalizeE164(e164);
  const key = normalized ?? e164;
  if (!key) {
    return;
  }
  let roster = groupMemberNames.get(conversationId);
  if (!roster) {
    roster = new Map();
    groupMemberNames.set(conversationId, roster);
  }
  roster.set(key, name);
}

function normalizeStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeMemberIdentity(
  value: string | GroupMemberIdentity | undefined,
): GroupMemberIdentity | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const normalized = normalizeE164(value) ?? value.trim();
    if (!normalized) {
      return null;
    }
    return { e164: normalized };
  }
  const e164Source = value.e164 ?? value.phoneNumber ?? undefined;
  const e164 = e164Source ? (normalizeE164(e164Source) ?? e164Source.trim()) : undefined;
  const lid = value.lid?.trim() || (LID_JID_RE.test(value.id ?? "") ? value.id?.trim() : undefined);
  const id = value.id?.trim();
  const name = value.name?.trim() || undefined;
  const self = value.self === true;
  if (!e164 && !lid && !id && !name) {
    return null;
  }
  return {
    ...(id ? { id } : {}),
    ...(lid ? { lid } : {}),
    ...(e164 ? { e164 } : {}),
    ...(name ? { name } : {}),
    ...(self ? { self: true } : {}),
  };
}

function lower(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

// Merge on any shared identifier (e164/lid/id); name-only merges are allowed
// ONLY when neither side has any id, so two "Sam"s with numbers stay distinct.
function hasSharedIdentity(left: GroupMemberIdentity, right: GroupMemberIdentity): boolean {
  return Boolean(
    (left.e164 && right.e164 && left.e164 === right.e164) ||
    (left.lid && right.lid && left.lid === right.lid) ||
    (left.id && right.id && left.id === right.id) ||
    (!left.e164 &&
      !left.lid &&
      !left.id &&
      !right.e164 &&
      !right.lid &&
      !right.id &&
      lower(left.name) &&
      lower(left.name) === lower(right.name)),
  );
}

function mergeIdentity(
  current: GroupMemberIdentity,
  incoming: GroupMemberIdentity,
): GroupMemberIdentity {
  return {
    ...current,
    ...(current.id ? {} : incoming.id ? { id: incoming.id } : {}),
    ...(current.lid ? {} : incoming.lid ? { lid: incoming.lid } : {}),
    ...(current.e164 ? {} : incoming.e164 ? { e164: incoming.e164 } : {}),
    ...(current.name ? {} : incoming.name ? { name: incoming.name } : {}),
    ...(current.self === true || incoming.self === true ? { self: true } : {}),
  };
}

// Contacts identifiers are polymorphic: phone-like strings normalize to e164,
// everything else (LIDs, JIDs, usernames) matches lowercase-exact.
function normalizeIdentifierValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  const normalizedPhone = normalizeE164(trimmed);
  if (normalizedPhone && /^\+\d{5,}$/.test(normalizedPhone)) {
    return [normalizedPhone];
  }
  return [trimmed.toLowerCase()];
}

function contactDisplayName(entry: ContactEntry): string | undefined {
  return normalizeStringValue(entry.nameOverride) ?? normalizeStringValue(entry.autoName);
}

type RosterPaths = {
  peopleDir: string;
  contactsPath: string;
};

function resolveRosterPaths(
  workspaceDir: string,
  options: WhatsAppGroupRosterOptions | undefined,
): RosterPaths {
  const peopleDirRelative =
    normalizeStringValue(options?.workspaceContacts?.peopleDir) ?? DEFAULT_PEOPLE_DIR_RELATIVE;
  const contactsFileName =
    normalizeStringValue(options?.workspaceContacts?.contactsFile) ?? DEFAULT_CONTACTS_FILE_NAME;
  const peopleDir = path.isAbsolute(peopleDirRelative)
    ? peopleDirRelative
    : path.join(workspaceDir, peopleDirRelative);
  return {
    peopleDir,
    contactsPath: path.join(peopleDir, contactsFileName),
  };
}

// Freshness exception (owner: WhatsApp group roster; tests in
// group-members.test.ts): the contacts registry is parsed on every group
// message, so the parsed index is cached per path and re-read only when the
// file's mtime changes — one stat per resolve instead of a full parse.
const contactsIndexCacheByPath = new Map<
  string,
  { mtimeMs: number; index: Map<string, ContactRecord> }
>();

export function resetGroupRosterContactsCacheForTests(): void {
  contactsIndexCacheByPath.clear();
  personFileExistenceCache.clear();
}

// The contacts registry is agent workspace data (operator-owned, read-only
// here). ALL read/stat failures degrade silently to roster-only rendering —
// a broken registry must never kill the message pipeline.
async function loadContactsIndex(contactsPath: string): Promise<Map<string, ContactRecord>> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(contactsPath)).mtimeMs;
  } catch {
    contactsIndexCacheByPath.delete(contactsPath);
    return new Map();
  }
  const cached = contactsIndexCacheByPath.get(contactsPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.index;
  }
  const index = await parseContactsIndex(contactsPath);
  contactsIndexCacheByPath.set(contactsPath, { mtimeMs, index });
  if (contactsIndexCacheByPath.size > 64) {
    const oldest = contactsIndexCacheByPath.keys().next();
    if (!oldest.done) {
      contactsIndexCacheByPath.delete(oldest.value);
    }
  }
  return index;
}

async function parseContactsIndex(contactsPath: string): Promise<Map<string, ContactRecord>> {
  let raw: string;
  try {
    raw = await fs.readFile(contactsPath, "utf8");
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return new Map();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { contacts?: unknown }).contacts)
  ) {
    return new Map();
  }
  const contacts = (parsed as { contacts: ContactEntry[] }).contacts;
  const index = new Map<string, ContactRecord>();
  for (const contact of contacts) {
    const identifiers = Array.isArray(contact.identifiers)
      ? contact.identifiers.filter((value): value is string => typeof value === "string")
      : [];
    if (identifiers.length === 0) {
      continue;
    }
    const displayName = contactDisplayName(contact);
    const personFile = normalizeStringValue(contact.personFile);
    const nicknames = Array.isArray(contact.nicknames)
      ? contact.nicknames.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    const record: ContactRecord = {
      ...(displayName ? { displayName } : {}),
      ...(personFile ? { personFile } : {}),
      nicknames,
    };
    for (const identifier of identifiers) {
      for (const normalized of normalizeIdentifierValue(identifier)) {
        index.set(normalized, record);
      }
    }
  }
  return index;
}

function contactCandidates(identity: GroupMemberIdentity): string[] {
  const candidates = [identity.e164, identity.lid, identity.id].flatMap((value) =>
    value ? normalizeIdentifierValue(value) : [],
  );
  return [...new Set(candidates)];
}

function resolveContactRecord(
  identity: GroupMemberIdentity,
  contacts: Map<string, ContactRecord>,
): ContactRecord | undefined {
  for (const candidate of contactCandidates(identity)) {
    const record = contacts.get(candidate);
    if (record) {
      return record;
    }
  }
  return undefined;
}

// Freshness exception (owner: WhatsApp group roster; tests in
// group-members.test.ts): person-file existence is stat'd per member per
// message, so results are cached briefly. Short TTL so a file created after
// a nudge is picked up within seconds.
const PERSON_FILE_EXISTENCE_TTL_MS = 30_000;
const personFileExistenceCache = new Map<string, { exists: boolean; checkedAtMs: number }>();

async function existingPersonFilePath(
  paths: RosterPaths,
  personFile: string | undefined,
  nowMs: number,
): Promise<string | undefined> {
  if (!personFile) {
    return undefined;
  }
  const absolutePath = path.isAbsolute(personFile)
    ? personFile
    : path.join(paths.peopleDir, personFile);
  const cached = personFileExistenceCache.get(absolutePath);
  if (cached && nowMs - cached.checkedAtMs < PERSON_FILE_EXISTENCE_TTL_MS) {
    return cached.exists ? absolutePath : undefined;
  }
  let exists: boolean;
  try {
    exists = (await fs.stat(absolutePath)).isFile();
  } catch {
    // Degrade silently (incl. EACCES/EISDIR): a bad person-file entry must
    // never kill the message pipeline.
    exists = false;
  }
  personFileExistenceCache.set(absolutePath, { exists, checkedAtMs: nowMs });
  if (personFileExistenceCache.size > 2048) {
    const oldest = personFileExistenceCache.keys().next();
    if (!oldest.done) {
      personFileExistenceCache.delete(oldest.value);
    }
  }
  return exists ? absolutePath : undefined;
}

function renderMissingPersonFileNote(
  paths: RosterPaths,
  options: WhatsAppGroupRosterOptions | undefined,
): string {
  const template =
    normalizeStringValue(options?.missingPersonFileNote) ?? DEFAULT_MISSING_PERSON_FILE_NOTE;
  return template.replaceAll("{contactsPath}", paths.contactsPath);
}

function isOwnerMember(
  member: ResolvedGroupMember,
  options: WhatsAppGroupRosterOptions | undefined,
): boolean {
  const ownerName = lower(options?.owner?.name);
  const ownerPersonFile = normalizeStringValue(options?.owner?.personFile);
  if (!ownerName && !ownerPersonFile) {
    return false;
  }
  const personFileBase = member.personFile ? path.basename(member.personFile) : "";
  return Boolean(
    (ownerName && lower(member.name) === ownerName) ||
    (ownerPersonFile && personFileBase === ownerPersonFile),
  );
}

function sortResolvedMembers(options: WhatsAppGroupRosterOptions | undefined) {
  return (left: ResolvedGroupMember, right: ResolvedGroupMember): number => {
    // Self pins first, the configured owner second, everyone else by name.
    const leftPin = left.self ? 0 : isOwnerMember(left, options) ? 1 : 2;
    const rightPin = right.self ? 0 : isOwnerMember(right, options) ? 1 : 2;
    if (leftPin !== rightPin) {
      return leftPin - rightPin;
    }
    const leftName = lower(left.name) || "￿";
    const rightName = lower(right.name) || "￿";
    if (leftName !== rightName) {
      return leftName.localeCompare(rightName);
    }
    const leftE164 = left.e164 ?? "";
    const rightE164 = right.e164 ?? "";
    if (leftE164 !== rightE164) {
      return leftE164.localeCompare(rightE164);
    }
    return (left.lid ?? left.id ?? "").localeCompare(right.lid ?? right.id ?? "");
  };
}

export function formatResolvedGroupMembers(
  members: readonly ResolvedGroupMemberContext[] | undefined,
): string | undefined {
  if (!members || members.length === 0) {
    return undefined;
  }
  const rendered = members
    .map((member) => {
      const displayName =
        member.name ??
        (member.note ? "Unknown" : (member.e164 ?? member.lid ?? member.id ?? "Unknown"));
      // The e164 bracket is omitted when it would duplicate the display name.
      const primaryIdentity =
        displayName === member.e164 || displayName === member.lid || displayName === member.id
          ? undefined
          : member.e164;
      const brackets = [primaryIdentity, member.lid ?? member.id, member.personFile, member.note]
        .filter((value): value is string => Boolean(value))
        .map((value) => `[${value}]`);
      return brackets.length > 0 ? `${displayName} ${brackets.join("")}`.trim() : displayName;
    })
    .filter((value) => value.trim().length > 0);
  return rendered.length > 0 ? rendered.join(", ") : undefined;
}

type GroupMemberSourceParams = {
  participants: Array<string | GroupMemberIdentity> | undefined;
  roster: Map<string, string> | undefined;
  fallbackE164?: string;
  sender?: GroupMemberIdentity;
  self?: GroupMemberIdentity;
};

function collectGroupMemberIdentities(params: GroupMemberSourceParams): GroupMemberIdentity[] {
  const identities: GroupMemberIdentity[] = [];
  const pushIdentity = (value: string | GroupMemberIdentity | undefined) => {
    const identity = normalizeMemberIdentity(value);
    if (!identity) {
      return;
    }
    const existingIndex = identities.findIndex((entry) => hasSharedIdentity(entry, identity));
    if (existingIndex !== -1) {
      const existing = identities[existingIndex];
      if (existing) {
        identities[existingIndex] = mergeIdentity(existing, identity);
      }
      return;
    }
    identities.push(identity);
  };

  params.participants?.forEach(pushIdentity);
  if (params.roster) {
    for (const [e164, name] of params.roster.entries()) {
      pushIdentity({ e164, name });
    }
  }
  if (identities.length === 0 && params.fallbackE164) {
    pushIdentity({
      e164: params.fallbackE164,
      ...(params.sender?.name ? { name: params.sender.name } : {}),
    });
  }
  pushIdentity(params.sender);
  pushIdentity(params.self);
  return identities;
}

function toRosterOnlyMember(
  identity: GroupMemberIdentity,
  roster: Map<string, string> | undefined,
  selfDisplayName: string | undefined,
): ResolvedGroupMemberContext {
  const rosterName = identity.e164 ? roster?.get(identity.e164) : undefined;
  const name = identity.self ? selfDisplayName : (identity.name ?? rosterName);
  return {
    ...(name ? { name } : {}),
    ...(identity.e164 ? { e164: identity.e164 } : {}),
    ...(identity.lid ? { lid: identity.lid } : {}),
    ...(identity.id ? { id: identity.id } : {}),
    ...(identity.self ? { self: true, pinned: "self" as const } : {}),
  };
}

export function formatGroupMembers(
  params: GroupMemberSourceParams & { options?: WhatsAppGroupRosterOptions },
): string | undefined {
  const identities = collectGroupMemberIdentities(params);
  if (identities.length === 0) {
    return undefined;
  }
  return formatResolvedGroupMembers(
    identities.map((identity) =>
      toRosterOnlyMember(identity, params.roster, params.options?.selfDisplayName),
    ),
  );
}

export async function resolveGroupMembers(
  params: GroupMemberSourceParams & {
    workspaceDir?: string;
    options?: WhatsAppGroupRosterOptions;
    nowMs?: number;
  },
): Promise<GroupMemberResolution> {
  const identities = collectGroupMemberIdentities(params);
  if (identities.length === 0) {
    return { members: [], rendered: undefined };
  }

  const workspaceContactsEnabled =
    params.options?.workspaceContacts?.enabled !== false && Boolean(params.workspaceDir);
  if (!workspaceContactsEnabled || !params.workspaceDir) {
    const members = identities.map((identity) =>
      toRosterOnlyMember(identity, params.roster, params.options?.selfDisplayName),
    );
    members.sort(sortResolvedMembers(params.options));
    return { members, rendered: formatResolvedGroupMembers(members) };
  }

  const paths = resolveRosterPaths(params.workspaceDir, params.options);
  const contacts = await loadContactsIndex(paths.contactsPath);
  const nowMs = params.nowMs ?? Date.now();
  const resolved: ResolvedGroupMember[] = [];
  for (const identity of identities) {
    const contact = resolveContactRecord(identity, contacts);
    const rosterName = identity.e164 ? params.roster?.get(identity.e164) : undefined;
    // nameOverride beats autoName beats inbound push-name beats roster.
    const displayName = identity.self
      ? params.options?.selfDisplayName
      : (contact?.displayName ?? identity.name ?? rosterName);
    const personFilePath = identity.self
      ? undefined
      : await existingPersonFilePath(paths, contact?.personFile, nowMs);
    const personKey = identity.e164 ?? identity.lid ?? identity.id ?? lower(displayName);
    // The self member never gets the missing-file nudge; it gets the
    // configured self note instead.
    const note = identity.self
      ? normalizeStringValue(params.options?.selfNote)
      : !personFilePath && shouldRenderMissingPersonFileNudge(personKey || "unknown", nowMs)
        ? renderMissingPersonFileNote(paths, params.options)
        : undefined;
    resolved.push({
      ...(displayName ? { name: displayName } : {}),
      ...(identity.e164 ? { e164: identity.e164 } : {}),
      ...(identity.lid ? { lid: identity.lid } : {}),
      ...(identity.id ? { id: identity.id } : {}),
      ...(identity.self ? { self: true } : {}),
      ...(contact?.nicknames?.length ? { nicknames: contact.nicknames } : {}),
      ...(personFilePath ? { personFile: personFilePath } : {}),
      ...(note ? { note } : {}),
    });
  }

  resolved.sort(sortResolvedMembers(params.options));
  const members = resolved.map((member) => {
    const resolvedMember: ResolvedGroupMemberContext = {};
    if (member.name) {
      resolvedMember.name = member.name;
    }
    if (member.e164) {
      resolvedMember.e164 = member.e164;
    }
    if (member.lid) {
      resolvedMember.lid = member.lid;
    }
    if (member.id) {
      resolvedMember.id = member.id;
    }
    if (member.personFile) {
      resolvedMember.personFile = member.personFile;
    }
    if (member.note) {
      resolvedMember.note = member.note;
    }
    if (member.self) {
      resolvedMember.self = true;
      resolvedMember.pinned = "self";
    } else if (isOwnerMember(member, params.options)) {
      resolvedMember.pinned = "owner";
    }
    return resolvedMember;
  });
  return {
    members,
    rendered: formatResolvedGroupMembers(members),
  };
}
