# Campaign workflow

PermitFrame separates campaign authorization from media production. The first question is whether the recorded rights and brand rules allow the work. The second question is what the producer wants to generate.

## 1. Record the source of truth

A campaign can only use inputs that the workspace has recorded:

- A creator label for the person appearing.
- A public source-media reference owned or controlled by that creator.
- A creator-attested permission covering the media, platform, territory, expiry, and required transformations.
- Optional brand rules for approved and prohibited claims.

A creator record is not a permission. A consent request is not active permission until the creator attests it.

![Empty Creator permissions screen with actions for consent, brand rules, and media](../public/docs/empty-creator-permissions.png)

## 2. Brief the campaign

The campaign request includes the selected permission, source media, brand rule, country, and creative brief.

The permission check evaluates the selected campaign against recorded scope. Known mismatches can block the campaign before any provider work starts.

A blocked result is an instruction, not a dead end:

1. Open the linked creator-permission or brand-rule fix.
2. Change only the relevant recorded input.
3. Return to the campaign.
4. Run the permission check again.

The campaign opens in **Creative Studio** only after the check allows creation.

## 3. DKG before spend

PermitFrame uses OriginTrail DKG knowledge to make campaign rights decisions and preserve campaign provenance. Before production spend, the check evaluates the selected permission record, creator, approved source media, permitted claims, platform, territory, transformations, validity window, and revocation state.

A creator's consent is a link-based attestation. It records a declaration and its integrity. It does not independently verify identity, legal ownership, or legal compliance.

The proof lifecycle remains explicit:

```text
private/local → Shared Working Memory → anchored Base Sepolia
```

Shared Working Memory evidence is not an on-chain public proof record. A campaign record becomes public proof only after owner approval and a genuinely finalized publication. See [DKG and proof](./dkg-and-proof.md) for the complete Track 2 flow and the exact technical evidence shown for a finalized record.

## 4. Build the production plan

A production plan is the spendable interpretation of the campaign. It lists the stages, formats, duration, quality profile, model choices, and outputs that can be produced.

For a **Short clip**, the plan normally includes one 3 to 15 second motion deliverable plus any selected still variations and supporting stages.

Each plan change is validated and reapplied before it becomes active. Review the complete plan rather than only the first stage.

## 5. Choose a model safely

### Automatic

**Automatic (recommended)** lets PermitFrame resolve a capability that is available for the selected quality profile and current provider discovery.

Automatic reduces setup and is the best default when the exact model is not strategically important.

### Optional override

Advanced users can save an image model or motion model for matching stages in a short-clip plan.

A saved override persists when the pack is reopened. Provider availability can change. If a saved model is no longer available, the plan cannot be applied until you choose a current model or return to **Automatic**.

The provider reports the capability that actually served a completed run. Review the result rather than assuming the requested model guarantees a particular output.

## 6. Understand spend controls

PermitFrame uses two related controls:

- The optional short-pack maximum spend cap checks known estimates for each production run.
- Every supported Livepeer call also carries its own provider cost ceiling.

A displayed estimate uses live pricing when it can be mapped exactly. When it cannot, PermitFrame says that live pricing is unavailable rather than inventing a number.

The short-pack cap is not a guaranteed lifetime total for every future retry, variation, film scene, or finishing action. Review each new paid action separately.

## 7. Generate selected stages

In **Creative plan**, select the deliverables and review the confirmation summary before generation.

Livepeer performs the selected supported media work, which can include image generation, variations, animation, and other discovered production capabilities. PermitFrame performs the surrounding work:

- Build the selected stage graph.
- Submit the exact requested actions.
- Persist provider job and result records.
- Save returned costs and output references.
- Store completed assets for delivery.
- Create derivative receipts.

Only selected active-plan stages are submitted. Failed provider work is shown honestly and can be retried under the available controls.

## 8. Review the complete pack

The active plan must be complete before owner approval. A partial run can be inspected, but it is not approval-ready until the remaining required stages are ready or the active plan is changed.

### Ratio

When output dimensions are available, PermitFrame compares the actual ratio with the requested ratio. A known mismatch is marked **Needs ratio review** and excluded from delivery until corrected.

Unknown dimensions remain unknown. PermitFrame does not invent a mismatch.

### Automated review

The visual critique is advisory. It may report no issue, flag an output for attention, or say that the output was not assessed automatically.

An automated pass is not a human approval. A flag is a request for review, not an automatic rejection.

### Human review

The owner checks visual quality, campaign fit, claims, format, and delivery readiness. The owner then uses **Approve pack** when the complete pack is acceptable.

## 9. DKG evidence after production

After the owner approves the pack, PermitFrame can preserve minimized campaign provenance. The lifecycle is:

```text
private/local → Shared Working Memory → anchored Base Sepolia
```

Shared Working Memory evidence may be available to configured DKG peers, but it is not an on-chain public proof record. A finalized Base Sepolia record can provide a canonical UAL, a Knowledge Asset token link, and a finalization transaction link. Those links appear only when the publisher reports a genuinely finalized anchored record.

The contract address and token ID are derived from the actual UAL. The documentation does not hardcode a contract address. Base Sepolia is a public testnet, not mainnet finality or a legal ownership certificate. See [DKG and proof](./dkg-and-proof.md) for the full explanation.

## What is private and what can be shared

| Material | Default treatment |
| --- | --- |
| Source media file (URL reference) | Remains with the creator or its host. PermitFrame records a reference and fingerprint. |
| Source media file (upload) | Authenticated Cloudinary copy (original and variants require signed access). PermitFrame records a byte hash; only a time-limited download link (expires one hour after creation) leaves storage, toward the production service at generation time. |
| Full prompt text | Not included in public proof. A prompt hash can support integrity evidence. |
| Workspace records | Visible to the signed-in workspace. |
| Client review | Limited to eligible, durably stored outputs and a minimized claim summary. |
| Public verification | Limited to approved, shareable outputs and allowlisted evidence. |
| Narration and burned-caption derivatives | Private finishing outputs. They do not automatically enter client share or public verification. |

## Human and automated responsibilities

| Layer | Automated support | Human responsibility |
| --- | --- | --- |
| Permission | Compare recorded scope, media, expiry, platform, territory, transformations, and claims. | Record accurate inputs and respond to blockers. |
| Production plan | Build stages and attach known cost ceilings. | Choose the right scope, model, and spend control. |
| Generation | Submit selected Livepeer work and record real outcomes. | Confirm spend and retry only when appropriate. |
| Quality review | Report ratio and advisory visual signals. | Inspect every output and decide whether the pack is acceptable. |
| Approval | Enforce readiness gates and record the owner decision. | Give final campaign approval. |
| Client review | Record a recommendation or change request. | Resolve feedback and retain final approval authority. |

## What the proof trail does not mean

The proof trail shows what PermitFrame recorded. It does not establish identity, legal ownership, automatic legal compliance, or a guarantee from the production provider.

Creator attestations prove the declaration and its integrity. The owner approval proves the recorded workspace decision. Neither replaces legal review or a provider service guarantee. For the Track 2 proof lifecycle, see [DKG and proof](./dkg-and-proof.md).
