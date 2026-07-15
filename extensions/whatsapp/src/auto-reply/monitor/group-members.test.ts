// Whatsapp tests cover group members plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  formatGroupMembers,
  noteGroupMember,
  resetGroupRosterContactsCacheForTests,
  resetGroupRosterNudgesForTests,
  resolveGroupMembers,
  type WhatsAppGroupRosterOptions,
} from "./group-members.js";

// Configured example values (brodie's live config); the module itself has no
// personal literals.
const ROSTER_OPTIONS: WhatsAppGroupRosterOptions = {
  selfDisplayName: "brodie",
  selfNote: "you know who you are lol",
  owner: { name: "abhay", personFile: "abhay.md" },
};

async function createWorkspaceFixture(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-group-members-"));
  await fs.mkdir(path.join(workspaceDir, "memory", "people"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "memory", "people", "_contacts.json"),
    JSON.stringify(
      {
        version: 1,
        contacts: [
          {
            identifiers: ["+15550001001", "2710527070277@lid"],
            autoName: "brodie",
          },
          {
            identifiers: ["+15550001002", "138487546249285@lid"],
            autoName: "Abhay",
            personFile: "abhay.md",
          },
          {
            identifiers: ["+15550001003", "63342261579793@lid"],
            autoName: "Kirtan",
            personFile: "kirtan.md",
            nicknames: ["Kirt"],
          },
          {
            identifiers: ["+15550001004", "179723644707051@lid"],
            autoName: "Monday",
            personFile: "monday.md",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const fileName of ["abhay.md", "kirtan.md", "monday.md"]) {
    await fs.writeFile(path.join(workspaceDir, "memory", "people", fileName), `# ${fileName}\n`);
  }
  return workspaceDir;
}

beforeEach(() => {
  resetGroupRosterNudgesForTests();
  resetGroupRosterContactsCacheForTests();
});

describe("noteGroupMember", () => {
  it("normalizes member phone numbers before storing", () => {
    const groupMemberNames = new Map<string, Map<string, string>>();

    noteGroupMember(groupMemberNames, "g1", "+1 (555) 123-4567", "Alice");

    expect(groupMemberNames.get("g1")?.get("+15551234567")).toBe("Alice");
  });

  it("ignores incomplete member values", () => {
    const groupMemberNames = new Map<string, Map<string, string>>();

    noteGroupMember(groupMemberNames, "g1", undefined, "Alice");
    noteGroupMember(groupMemberNames, "g1", "+15551234567", undefined);

    expect(groupMemberNames.get("g1")).toBeUndefined();
  });
});

describe("formatGroupMembers", () => {
  it("deduplicates participants and appends named roster members", () => {
    const roster = new Map<string, string>([
      ["+16660000000", "Bob"],
      ["+17770000000", "Carol"],
    ]);

    const formatted = formatGroupMembers({
      participants: ["+1 (555) 000-0000", "+15550000000", "+16660000000"],
      roster,
    });

    expect(formatted).toBe("+15550000000, Bob [+16660000000], Carol [+17770000000]");
  });

  it("deduplicates the self identity when it is also the fallback", () => {
    const formatted = formatGroupMembers({
      participants: [],
      roster: undefined,
      fallbackE164: "+1 (555) 222-3333",
      self: { e164: "+15552223333", self: true },
      options: ROSTER_OPTIONS,
    });

    expect(formatted).toBe("brodie [+15552223333]");
  });

  it("returns undefined when no members can be resolved", () => {
    expect(
      formatGroupMembers({
        participants: [],
        roster: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("resolveGroupMembers", () => {
  it("renders contacts-enriched members with self and owner pinned first", async () => {
    const workspaceDir = await createWorkspaceFixture();

    const result = await resolveGroupMembers({
      workspaceDir,
      options: ROSTER_OPTIONS,
      participants: [
        { e164: "+15550001003", lid: "63342261579793@lid" },
        { e164: "+15550001004", lid: "179723644707051@lid" },
        { e164: "+15550001002", lid: "138487546249285@lid", name: "Abhay" },
      ],
      roster: undefined,
      sender: {
        e164: "+15550001002",
        lid: "138487546249285@lid",
        name: "Abhay",
      },
      self: {
        e164: "+15550001001",
        lid: "2710527070277@lid",
        name: "brodie",
        self: true,
      },
    });

    expect(result.members).toEqual([
      {
        name: "brodie",
        e164: "+15550001001",
        lid: "2710527070277@lid",
        note: "you know who you are lol",
        self: true,
        pinned: "self",
      },
      {
        name: "Abhay",
        e164: "+15550001002",
        lid: "138487546249285@lid",
        personFile: path.join(workspaceDir, "memory", "people", "abhay.md"),
        pinned: "owner",
      },
      {
        name: "Kirtan",
        e164: "+15550001003",
        lid: "63342261579793@lid",
        personFile: path.join(workspaceDir, "memory", "people", "kirtan.md"),
      },
      {
        name: "Monday",
        e164: "+15550001004",
        lid: "179723644707051@lid",
        personFile: path.join(workspaceDir, "memory", "people", "monday.md"),
      },
    ]);
    expect(result.rendered).toBe(
      [
        `brodie [+15550001001][2710527070277@lid][you know who you are lol]`,
        `Abhay [+15550001002][138487546249285@lid][${path.join(workspaceDir, "memory", "people", "abhay.md")}]`,
        `Kirtan [+15550001003][63342261579793@lid][${path.join(workspaceDir, "memory", "people", "kirtan.md")}]`,
        `Monday [+15550001004][179723644707051@lid][${path.join(workspaceDir, "memory", "people", "monday.md")}]`,
      ].join(", "),
    );
  });

  it("renders named unknowns with a contacts-update note when no person file exists", async () => {
    const workspaceDir = await createWorkspaceFixture();

    const result = await resolveGroupMembers({
      workspaceDir,
      options: ROSTER_OPTIONS,
      participants: [{ e164: "+15550001111", lid: "15550001111@lid", name: "Mystery Guy" }],
      roster: undefined,
    });

    expect(result.rendered).toBe(
      `Mystery Guy [+15550001111][15550001111@lid][people file missing, update \`${path.join(workspaceDir, "memory", "people", "_contacts.json")}\`]`,
    );
  });

  it("renders Unknown when the member has no name and no contact match", async () => {
    const workspaceDir = await createWorkspaceFixture();

    const result = await resolveGroupMembers({
      workspaceDir,
      options: ROSTER_OPTIONS,
      participants: [{ e164: "+15550002222", lid: "15550002222@lid" }],
      roster: undefined,
    });

    expect(result.rendered).toBe(
      `Unknown [+15550002222][15550002222@lid][people file missing, update \`${path.join(workspaceDir, "memory", "people", "_contacts.json")}\`]`,
    );
  });

  it("rate-limits the missing-person-file nudge to once per person per day", async () => {
    const workspaceDir = await createWorkspaceFixture();
    const params = {
      workspaceDir,
      options: ROSTER_OPTIONS,
      participants: [{ e164: "+15550003333", name: "Nudged" }],
      roster: undefined,
    };

    const first = await resolveGroupMembers({ ...params, nowMs: 1_000 });
    expect(first.members[0]?.note).toContain("people file missing");

    const second = await resolveGroupMembers({ ...params, nowMs: 2_000 });
    expect(second.members[0]?.note).toBeUndefined();

    const nextDay = await resolveGroupMembers({
      ...params,
      nowMs: 1_000 + 24 * 60 * 60 * 1000,
    });
    expect(nextDay.members[0]?.note).toContain("people file missing");
  });

  it("never merges two name-only members with distinct identifiers", async () => {
    const workspaceDir = await createWorkspaceFixture();

    const result = await resolveGroupMembers({
      workspaceDir,
      options: ROSTER_OPTIONS,
      participants: [
        { e164: "+15550004444", name: "Sam" },
        { e164: "+15550005555", name: "Sam" },
      ],
      roster: undefined,
    });

    expect(result.members).toHaveLength(2);
  });

  it("uses a custom nudge template with {contactsPath} expansion", async () => {
    const workspaceDir = await createWorkspaceFixture();

    const result = await resolveGroupMembers({
      workspaceDir,
      options: {
        ...ROSTER_OPTIONS,
        missingPersonFileNote: "registry stale: {contactsPath}",
      },
      participants: [{ e164: "+15550006666", name: "Custom" }],
      roster: undefined,
    });

    expect(result.members[0]?.note).toBe(
      `registry stale: ${path.join(workspaceDir, "memory", "people", "_contacts.json")}`,
    );
  });

  it("reuses the parsed contacts index until the registry mtime changes", async () => {
    const workspaceDir = await createWorkspaceFixture();
    const contactsPath = path.join(workspaceDir, "memory", "people", "_contacts.json");
    const params = {
      workspaceDir,
      options: ROSTER_OPTIONS,
      participants: [{ e164: "+15550001003" }],
      roster: undefined,
    };

    // Pin an exact whole-second mtime so it can be restored losslessly.
    const pinnedTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await fs.utimes(contactsPath, pinnedTime, pinnedTime);
    const first = await resolveGroupMembers({ ...params, nowMs: 1_000 });
    expect(first.members[0]?.name).toBe("Kirtan");

    // Overwrite with a different name but the SAME mtime: cached index wins.
    await fs.writeFile(
      contactsPath,
      JSON.stringify({
        contacts: [{ identifiers: ["+15550001003"], autoName: "Renamed" }],
      }),
      "utf8",
    );
    await fs.utimes(contactsPath, pinnedTime, pinnedTime);
    const cachedRun = await resolveGroupMembers({ ...params, nowMs: 2_000 });
    expect(cachedRun.members[0]?.name).toBe("Kirtan");

    // Bump the mtime: index re-parses.
    await fs.utimes(contactsPath, new Date(), new Date(Date.now() + 5_000));
    const freshRun = await resolveGroupMembers({ ...params, nowMs: 3_000 });
    expect(freshRun.members[0]?.name).toBe("Renamed");
  });

  it("degrades silently when the contacts registry is unreadable", async () => {
    const workspaceDir = await createWorkspaceFixture();
    const contactsPath = path.join(workspaceDir, "memory", "people", "_contacts.json");
    await fs.rm(contactsPath);
    await fs.mkdir(contactsPath); // EISDIR on read

    const result = await resolveGroupMembers({
      workspaceDir,
      options: ROSTER_OPTIONS,
      participants: [{ e164: "+15550007777", name: "Roster Only" }],
      roster: undefined,
    });

    expect(result.members[0]?.name).toBe("Roster Only");
  });
});
