import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attestGuard,
  buildConsentPublicView,
  cancelGuard,
  consentCompletionCopy,
  consentLifecycle,
  declineGuard,
  invitePublicationStatus,
  toConsentPublicMedia,
  validateAttestation,
  validateAttestationAcks,
  validateConsentRequest
} from "./consent-validation";
import type { ConsentDraft } from "./types";

const DRAFT: ConsentDraft = {
  creatorId: "creator_maya",
  platforms: ["instagram", "youtube"],
  countries: ["GR", "US"],
  allowedTransformations: ["edit", "animate", "crop", "upscale"],
  validUntil: "2027-03-01",
  sourceMediaIds: ["media_maya_01"]
};

const VALID = {
  platforms: ["instagram"],
  countries: ["GR"],
  allowedTransformations: ["edit", "crop"],
  validUntil: "2027-02-01"
};

describe("validateAttestation", () => {
  it("accepts a narrowed subset with a future expiry", () => {
    const r = validateAttestation(VALID, DRAFT, "2026-09-20");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value.platforms, ["instagram"]);
      assert.deepEqual(r.value.countries, ["GR"]);
      assert.equal(r.value.validUntil, "2027-02-01");
    }
  });

  it("normalizes case but rejects widening beyond the draft offer", () => {
    const narrowed = validateAttestation(
      { ...VALID, platforms: ["Instagram"], countries: ["gr"] },
      DRAFT,
      "2026-09-20"
    );
    assert.equal(narrowed.ok, true);

    const platformWidened = validateAttestation({ ...VALID, platforms: ["tiktok"] }, DRAFT, "2026-09-20");
    assert.equal(platformWidened.ok, false);
    if (!platformWidened.ok) assert.match(platformWidened.error, /narrow/i);

    const countryWidened = validateAttestation({ ...VALID, countries: ["DE"] }, DRAFT, "2026-09-20");
    assert.equal(countryWidened.ok, false);
    if (!countryWidened.ok) assert.match(countryWidened.error, /narrow/i);

    const narrowDraft: ConsentDraft = { ...DRAFT, allowedTransformations: ["edit"] };
    const transformWidened = validateAttestation(
      { ...VALID, allowedTransformations: ["edit", "crop"] },
      narrowDraft,
      "2026-09-20"
    );
    assert.equal(transformWidened.ok, false);
    if (!transformWidened.ok) assert.match(transformWidened.error, /narrow/i);
  });

  it("rejects unknown platforms, bad country codes, and empty selections", () => {
    for (const body of [
      { ...VALID, platforms: ["myspace"] },
      { ...VALID, platforms: [] },
      { ...VALID, countries: ["Greece"] },
      { ...VALID, countries: [] },
      { ...VALID, allowedTransformations: "edit" },
      { ...VALID, allowedTransformations: ["teleport"] }
    ]) {
      assert.equal(validateAttestation(body, DRAFT, "2026-09-20").ok, false);
    }
  });

  it("rejects malformed and non-future expiry dates", () => {
    for (const validUntil of ["20-09-2027", "2027/09/01", "2026-09-20", "2025-01-01", ""]) {
      const r = validateAttestation({ ...VALID, validUntil }, DRAFT, "2026-09-20");
      assert.equal(r.ok, false);
    }
  });

  it("accepts expiry equal to or earlier than the offered date", () => {
    for (const validUntil of ["2027-03-01", "2027-02-01", "2026-10-05"]) {
      const r = validateAttestation({ ...VALID, validUntil }, DRAFT, "2026-09-20");
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value.validUntil, validUntil);
    }
  });

  it("rejects expiry later than the offered date with the exact message", () => {
    for (const validUntil of ["2027-03-02", "2027-06-01", "2028-01-01"]) {
      const r = validateAttestation({ ...VALID, validUntil }, DRAFT, "2026-09-20");
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, "Attestation can only shorten the offered expiry, not extend it.");
    }
  });
});

describe("consentCompletionCopy", () => {
  it("uses published wording when a real UAL exists", () => {
    const copy = consentCompletionCopy("published");
    assert.equal(copy.state, "published");
    assert.equal(copy.lead, "Your Permission Passport is published to the proof ledger.");
    assert.equal(copy.status, "Published - public proof is available for this permission record.");
  });

  it("uses saved/local wording without live/published claims when no UAL exists", () => {
    const copy = consentCompletionCopy("saved");
    assert.equal(copy.state, "saved");
    assert.equal(copy.lead, "Your permission record was saved.");
    assert.equal(copy.status, "Saved - public proof is not available yet.");
    for (const text of [copy.lead, copy.status]) {
      assert.ok(!/live/i.test(text), "must not say live without ledger proof");
      assert.ok(!/publish/i.test(text), "must not imply publication without a UAL");
    }
  });

  it("uses conservative wording for unconfirmable older links", () => {
    const copy = consentCompletionCopy("unknown");
    assert.equal(copy.state, "unknown");
    assert.equal(copy.lead, "Your permission was recorded.");
    assert.equal(copy.status, "Public proof status for this older link cannot be confirmed here.");
    for (const text of [copy.lead, copy.status]) {
      assert.ok(!/live/i.test(text), "must not say live when unconfirmed");
      assert.ok(!/publish/i.test(text), "must not say published when unconfirmed");
      assert.ok(!/public proof is available/i.test(text), "must not imply available proof when unconfirmed");
    }
  });
});

describe("invitePublicationStatus", () => {
  const OLD_PUBLISHED = { id: "passport_old", ual: "did:dkg:test/old/1" };
  const NEW_LOCAL = { id: "passport_new" };

  it("never lets an older published passport mark this link published", () => {
    // Same creator, prior passport with UAL, but this invite's passport is local.
    assert.equal(
      invitePublicationStatus({ passportId: "passport_new" }, [OLD_PUBLISHED, NEW_LOCAL]),
      "saved"
    );
  });

  it("reports published only for the linked passport with a UAL", () => {
    assert.equal(invitePublicationStatus({ passportId: "passport_old" }, [OLD_PUBLISHED, NEW_LOCAL]), "published");
    // Empty-string UAL is not proof.
    assert.equal(invitePublicationStatus({ passportId: "passport_new" }, [{ id: "passport_new", ual: "" }]), "saved");
  });

  it("reports unknown for legacy links and missing passports", () => {
    assert.equal(invitePublicationStatus({}, [OLD_PUBLISHED]), "unknown");
    assert.equal(invitePublicationStatus({ passportId: "passport_gone" }, [OLD_PUBLISHED, NEW_LOCAL]), "unknown");
    assert.equal(invitePublicationStatus({ passportId: "passport_old" }, []), "unknown");
  });
});

describe("buildConsentPublicView", () => {
  const DRAFT_BODY = {
    platforms: ["instagram"],
    countries: ["GR"],
    allowedTransformations: ["edit"],
    validUntil: "2027-03-01"
  };
  const CREATOR = { name: "Maya", handle: "@maya" };
  const MEDIA = [{ title: "Maya portrait", type: "image" as const, url: "https://cdn.example/m1.png", isPrivateUpload: false }];

  it("approved links expose only the status, never passport ids or UALs", () => {
    const view = buildConsentPublicView(
      { status: "approved", draft: DRAFT_BODY, passportId: "passport_new", purpose: "Spring launch", linkExpiresAt: "2027-04-01" },
      MEDIA,
      [
        { id: "passport_old", ual: "did:dkg:test/old/1" },
        { id: "passport_new" }
      ],
      CREATOR,
      "2027-01-10"
    );
    assert.deepEqual(view, {
      status: "approved",
      draft: DRAFT_BODY,
      purpose: "Spring launch",
      media: MEDIA,
      linkExpiresAt: "2027-04-01",
      publicationStatus: "saved",
      creator: CREATOR
    });
    const leaked = JSON.stringify(view);
    assert.ok(!leaked.includes("passport_new"), "no passport id may leave");
    assert.ok(!leaked.includes("did:dkg:test/old/1"), "no UAL may leave");
  });

  it("exposes media previews without internal source-media IDs", () => {
    const view = buildConsentPublicView(
      { status: "viewed", draft: DRAFT_BODY, purpose: "Spring launch", linkExpiresAt: "2027-04-01" },
      MEDIA,
      [],
      CREATOR,
      "2027-01-10"
    );
    // Exact shape proof: media items carry only title/type/url/flag - the
    // store row's internal id has nowhere to hide (deepEqual would fail on it).
    assert.deepEqual(view.media, MEDIA);
    for (const item of view.media) {
      assert.deepEqual(Object.keys(item).sort(), ["isPrivateUpload", "title", "type", "url"]);
    }
    assert.deepEqual(Object.keys(view).sort(), ["creator", "draft", "linkExpiresAt", "media", "purpose", "status"]);
  });

  it("legacy completed links read as approved with unknown proof", () => {
    const view = buildConsentPublicView(
      { status: "completed", draft: DRAFT_BODY },
      [],
      [],
      CREATOR,
      "2027-01-10"
    );
    assert.deepEqual(view, {
      status: "approved",
      draft: DRAFT_BODY,
      purpose: "",
      media: [],
      publicationStatus: "unknown",
      creator: CREATOR
    });
  });

  it("pending links carry no publication status at all", () => {
    const view = buildConsentPublicView({ status: "pending", draft: DRAFT_BODY }, [], [], CREATOR, "2027-01-10");
    assert.deepEqual(view, { status: "pending", draft: DRAFT_BODY, purpose: "", media: [], creator: CREATOR });
    assert.ok(!("publicationStatus" in view));
  });

  it("expired-by-link links read as expired without leaking internals", () => {
    const view = buildConsentPublicView(
      { status: "viewed", draft: DRAFT_BODY, purpose: "Spring launch", linkExpiresAt: "2027-01-01" },
      MEDIA,
      [],
      CREATOR,
      "2027-02-01"
    );
    assert.equal(view.status, "expired");
    assert.ok(!("publicationStatus" in view));
  });
});

describe("toConsentPublicMedia", () => {
  it("passes URL references through with a preview url", () => {
    assert.deepEqual(
      toConsentPublicMedia({ title: "t", type: "image", url: "https://cdn.example/m.png", source: "url" }),
      { title: "t", type: "image", url: "https://cdn.example/m.png", isPrivateUpload: false }
    );
  });

  it("strips uploads to presentation data only, retaining only an opaque image position", () => {
    const out = toConsentPublicMedia({
      title: "t",
      type: "video",
      url: "private:cloudinary:src_abcdef123456",
      source: "upload"
    });
    assert.deepEqual(out, { title: "t", type: "video", isPrivateUpload: true });
    assert.deepEqual(Object.keys(out).sort(), ["isPrivateUpload", "title", "type"]);
    const dump = JSON.stringify(out);
    for (const banned of ["private:cloudinary", "src_abcdef123456", "cloudinary", "storage", "hash", "http"]) {
      assert.ok(!dump.includes(banned), `leaks ${banned}`);
    }
    assert.deepEqual(
      toConsentPublicMedia({ title: "image", type: "image", url: "private:cloudinary:src_abcdef123456", source: "upload" }, 2),
      { title: "image", type: "image", isPrivateUpload: true, previewIndex: 2 }
    );
  });

  it("buildConsentPublicView carries an upload flag item with no url key", () => {
    const view = buildConsentPublicView(
      {
        status: "pending",
        draft: {
          platforms: ["instagram"],
          countries: ["GR"],
          allowedTransformations: ["edit"],
          validUntil: "2027-03-01"
        }
      },
      [{ title: "t", type: "image", isPrivateUpload: true }],
      [],
      { name: "Maya", handle: "@maya" },
      "2027-01-10"
    );
    assert.deepEqual(view.media, [{ title: "t", type: "image", isPrivateUpload: true }]);
  });
});

describe("validateConsentRequest", () => {
  const LOOKUP = {
    creators: [{ id: "creator_maya" }],
    sourceMedia: [
      { id: "media_1", creatorId: "creator_maya" },
      { id: "media_2", creatorId: "creator_maya" },
      { id: "media_x", creatorId: "creator_jo" }
    ]
  };
  const BODY = {
    creatorId: "creator_maya",
    sourceMediaIds: ["media_1", "media_2"],
    platforms: ["instagram"],
    countries: ["GR"],
    allowedTransformations: [] as string[],
    validUntil: "2027-03-01",
    purpose: "Spring footwear launch across Instagram."
  };

  it("accepts source-linked scope with empty transforms as display-only", () => {
    const r = validateConsentRequest(BODY, LOOKUP, "2026-09-20");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value.sourceMediaIds, ["media_1", "media_2"]);
      assert.deepEqual(r.value.allowedTransformations, []);
      assert.equal(r.value.purpose, BODY.purpose);
    }
  });

  it("requires non-empty, single-creator, known media and creator", () => {
    assert.equal(validateConsentRequest({ ...BODY, sourceMediaIds: [] }, LOOKUP, "2026-09-20").ok, false);
    const mixed = validateConsentRequest({ ...BODY, sourceMediaIds: ["media_1", "media_x"] }, LOOKUP, "2026-09-20");
    assert.equal(mixed.ok, false);
    if (!mixed.ok) assert.match(mixed.error, /exactly one creator/);
    const missing = validateConsentRequest({ ...BODY, sourceMediaIds: ["media_nope"] }, LOOKUP, "2026-09-20");
    assert.equal(missing.ok, false);
    const noCreator = validateConsentRequest({ ...BODY, creatorId: "creator_ghost" }, LOOKUP, "2026-09-20");
    assert.equal(noCreator.ok, false);
  });

  it("requires explicit scope and a capped purpose", () => {
    assert.equal(validateConsentRequest({ ...BODY, platforms: [] }, LOOKUP, "2026-09-20").ok, false);
    assert.equal(validateConsentRequest({ ...BODY, countries: [] }, LOOKUP, "2026-09-20").ok, false);
    assert.equal(validateConsentRequest({ ...BODY, validUntil: "2026-09-20" }, LOOKUP, "2026-09-20").ok, false);
    assert.equal(validateConsentRequest({ ...BODY, purpose: "  " }, LOOKUP, "2026-09-20").ok, false);
    assert.equal(validateConsentRequest({ ...BODY, purpose: "x".repeat(141) }, LOOKUP, "2026-09-20").ok, false);
    assert.equal(validateConsentRequest({ ...BODY, purpose: "x".repeat(140) }, LOOKUP, "2026-09-20").ok, true);
  });
});

describe("consentLifecycle and guards", () => {
  it("maps legacy completed to approved and derives link expiry", () => {
    assert.equal(consentLifecycle({ status: "completed" }, "2027-01-10"), "approved");
    assert.equal(consentLifecycle({ status: "pending", linkExpiresAt: "2027-04-01" }, "2027-01-10"), "pending");
    assert.equal(consentLifecycle({ status: "viewed", linkExpiresAt: "2027-04-01" }, "2027-01-10"), "viewed");
    assert.equal(consentLifecycle({ status: "viewed", linkExpiresAt: "2027-01-01" }, "2027-02-01"), "expired");
    // Legacy rows without a link expiry never link-expire.
    assert.equal(consentLifecycle({ status: "pending" }, "2029-01-01"), "pending");
    assert.equal(consentLifecycle({ status: "declined" }, "2027-01-10"), "declined");
    assert.equal(consentLifecycle({ status: "cancelled" }, "2027-01-10"), "cancelled");
  });

  it("pending and viewed attest and decline; terminal states refuse honestly", () => {
    assert.deepEqual(attestGuard("pending"), { ok: true });
    assert.deepEqual(attestGuard("viewed"), { ok: true });
    assert.deepEqual(declineGuard("pending"), { ok: true });
    assert.deepEqual(declineGuard("viewed"), { ok: true });
    for (const terminal of ["approved", "declined", "cancelled", "expired"] as const) {
      assert.equal(attestGuard(terminal).ok, false);
      assert.equal(declineGuard(terminal).ok, false);
    }
    assert.equal(attestGuard("approved").ok, false);
    if (!attestGuard("approved").ok) assert.match((attestGuard("approved") as { error: string }).error, /already attested/);
  });

  it("cancel guard keeps approved and declined terminal", () => {
    assert.deepEqual(cancelGuard("pending"), { ok: true });
    assert.deepEqual(cancelGuard("viewed"), { ok: true });
    for (const terminal of ["approved", "declined", "cancelled", "expired"] as const) {
      assert.equal(cancelGuard(terminal).ok, false);
    }
  });
});

describe("validateAttestationAcks", () => {
  it("requires both explicit acknowledgements", () => {
    assert.deepEqual(validateAttestationAcks({ acknowledgements: [true, true] }), { ok: true });
    assert.deepEqual(validateAttestationAcks({ acknowledgements: { rights: true, use: true } }), { ok: true });
    for (const acknowledgements of [undefined, [], [true], [true, false], { rights: true }, "yes"] as const) {
      const r = validateAttestationAcks({ acknowledgements });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /both acknowledgement/);
    }
  });
});
