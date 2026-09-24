# PermitFrame guide

PermitFrame is a permission-aware campaign production workspace. It checks creator permissions and brand rules before paid generation, then keeps a review trail with each approved output.

> PermitFrame is not merely an image generator. Generation starts only after the recorded permission and claim checks allow the selected campaign plan.

## Start here

1. [Getting started](./getting-started.md) follows the complete first campaign from an empty workspace to owner approval.
2. [DKG and proof](./dkg-and-proof.md) explains the OriginTrail knowledge layer, three proof states, and Base Sepolia public testnet evidence.
3. [Campaign workflow](./campaign-workflow.md) explains the permission check, production plan, model choice, spend controls, generation, and review.
4. [Film and finishing](./film-and-finishing.md) explains short clips, longer Campaign Film, narration, burned captions, and current limitations.
5. [Verification and delivery](./verification-and-delivery.md) explains owner approval, advisory client feedback, privacy, and public proof.

## The product model

PermitFrame keeps four ideas separate:

- **Permission** records what a creator allowed, where it applies, and when it expires.
- **Brand rules** record approved and prohibited claims for a product.
- **Production** creates only the media stages selected in the reviewed plan.
- **Proof** connects a delivered asset to the evidence recorded before and during production.

The permission check is an automated control. It can block known scope, expiry, transformation, media, and claim mismatches. It does not replace human judgment.

## Track 2: knowledge before spend, proof after approval

PermitFrame uses OriginTrail DKG knowledge to make campaign rights decisions and preserve campaign provenance. Before production spend, the policy check evaluates the selected permission, creator, approved media, claims, platform, territory, transformations, validity window, and revocation state.

After the owner approves a campaign, the proof lifecycle is explicit:

```text
private/local → Shared Working Memory → anchored Base Sepolia
```

Shared Working Memory evidence is not an on-chain public proof record. A public verification page becomes available only when the approved campaign record has genuinely finalized. Read [DKG and proof](./dkg-and-proof.md) for the full Track 2 explanation, including what Base Sepolia evidence does and does not prove.

## What PermitFrame does not prove

A PermitFrame attestation records a creator declaration and its integrity. It does not independently verify identity, legal ownership, automatic legal compliance, or the quality of a provider result.

An approval records the workspace owner's decision. Client feedback remains advisory. Public verification shows a point-in-time summary of what PermitFrame recorded, not a legal certificate.

## A safe first test

You can complete creator, media, consent, brand-rule, and campaign setup without paid generation. Stop after the permission check if you only want to validate the workflow.

When you are ready to spend, review the plan, estimate, selected stages, model choice, and spend cap before confirming generation.
