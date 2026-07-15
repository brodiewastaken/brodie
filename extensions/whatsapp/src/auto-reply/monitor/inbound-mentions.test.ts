// Whatsapp tests cover inbound native mention projection.
import { describe, expect, it } from "vitest";
import { projectWhatsAppInboundMentions } from "./inbound-mentions.js";

describe("projectWhatsAppInboundMentions", () => {
  it("projects every native target occurrence and preserves unresolved native ids", () => {
    const adaLid = "277038292303944@lid";
    const selfLid = "216372600647751@lid";
    const unresolvedLid = "999999999999999@lid";

    expect(
      projectWhatsAppInboundMentions({
        text: "(@277038292303944）ask @216372600647751🫡, then [@277038292303944] and @999999999999999",
        mentionedJids: [adaLid, selfLid, unresolvedLid],
        members: [
          { name: "Ada", e164: "+15551234567", lid: adaLid, id: adaLid },
          {
            name: "brodie",
            e164: "+15557654321",
            lid: selfLid,
            id: selfLid,
            self: true,
          },
        ],
      }),
    ).toBe(
      "(@Ada [+15551234567][277038292303944@lid]）ask @brodie [+15557654321][216372600647751@lid]🫡, then [@Ada [+15551234567][277038292303944@lid]] and @999999999999999",
    );
  });

  it("does not rewrite numeric text without matching native mention metadata", () => {
    expect(
      projectWhatsAppInboundMentions({
        text: "call @277038292303944",
        mentionedJids: [],
        members: [
          {
            name: "Ada",
            e164: "+15551234567",
            lid: "277038292303944@lid",
          },
        ],
      }),
    ).toBe("call @277038292303944");
  });

  it("projects a phone-form token when structured metadata carries the target LID", () => {
    expect(
      projectWhatsAppInboundMentions({
        text: "@+15551234567 check",
        mentionedJids: ["277038292303944@lid"],
        members: [
          {
            name: "Ada",
            e164: "+15551234567",
            lid: "277038292303944@lid",
          },
        ],
      }),
    ).toBe("@Ada [+15551234567][277038292303944@lid] check");
  });
});
