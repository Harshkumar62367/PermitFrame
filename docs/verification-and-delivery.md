# Verification and delivery

Delivery has two review layers. The workspace owner makes the final campaign decision. A client can review an eligible pack and leave advisory feedback.

## Review the pack

Open the campaign and find **Review & deliver**.

Review every output and its status:

- Requested format and actual dimensions.
- Known ratio mismatch or unknown dimensions.
- Automated visual-review result.
- Storage state.
- Provider capability that produced the result.
- Private or delivery-blocked status.

The active production plan must be complete. Known ratio mismatches remain excluded from delivery. Automated visual findings remain advisory even when they report an issue.

The owner is the human reviewer. An automated pass does not replace inspection, and a flag does not decide the campaign by itself.

## Owner approval

Only the authenticated workspace owner can select **Approve pack**.

Approval requires a complete eligible pack with real completed outputs, durable storage, no known ratio block, and current campaign authorization.

When approval succeeds, PermitFrame first records the campaign decision. Publication can continue separately in the background.

The visible status is intentional:

- **Campaign record saved** means the approval and minimized campaign record are stored, but public verification is not yet final.
- **Public verification ready** means the publication state is finalized and a public proof page can be opened.

Do not describe an approved campaign as publicly verified until the second status is visible.

## DKG proof states

PermitFrame uses OriginTrail DKG knowledge to make campaign rights decisions and preserve campaign provenance. The proof lifecycle is explicit:

| State | Meaning | Public proof link |
| --- | --- | --- |
| **Local/private** | The record is retained privately in the workspace or local evidence store. | None. |
| **Shared Working Memory** | DKG evidence may be shared with configured peers, but it is not an on-chain public proof record. | None. |
| **Anchored/finalized** | The approved campaign record has a canonical UAL and finalized Base Sepolia evidence. | Available after genuine finalization. |

A creator's consent is a link-based attestation. It does not independently verify identity, legal ownership, or legal compliance.

For a real finalized Base Sepolia record, technical details can show:

- UAL: `did:dkg:base:84532/<contract-address>/<token-id>`
- Knowledge Asset token link: `https://sepolia.basescan.org/token/<contract-address>?a=<token-id>`
- Finalization transaction link: `https://sepolia.basescan.org/tx/<transaction-hash>`

The contract address and token ID come from the actual UAL. No universal contract address is assumed. The transaction link appears only after the DKG publisher reports a genuinely finalized anchored record. Chain ID `84532` is Base Sepolia testnet, not mainnet finality.

OriginTrail explorer indexing can be incomplete for testnet records. BaseScan provides the direct Base Sepolia technical evidence when the record has a finalized UAL and transaction. See [DKG and proof](./dkg-and-proof.md) for the full Track 2 explanation.

## Client delivery

After an eligible output is durably stored, create a client share link from the campaign.

The share page works without requiring the reviewer to sign in. It exposes only the allowlisted pack and the minimum campaign context needed for review.

A client can:

- Recommend approval.
- Request changes with a note.

Both choices are advisory. They do not change the campaign into its final approved state. The agency owner reviews the feedback and remains responsible for final approval.

The share link does not establish the reviewer's identity.

## Public verification

The signed-in **Verification** page helps an owner find campaign proof. The resulting public proof page can be shared without a PermitFrame sign-in.

A public proof page can include:

- Approved shareable outputs.
- Claims verified before production.
- Creator, platform, territory, and expiry summary.
- Brand-rule summary.
- Campaign caption text.
- Technical record details when publication has genuinely finalized.

Public proof is a point-in-time snapshot. It is not a live view of every later workspace change. When the campaign record is genuinely finalized, Technical details can show the canonical UAL, the Base Sepolia Knowledge Asset token link, and the finalization transaction link. Those are public testnet provenance links, not legal ownership evidence.

## Privacy boundaries

| Item | Workspace | Client share | Public proof |
| --- | --- | --- | --- |
| Contracts and contact details | Private | Not shown | Not shown |
| Full prompt text | Not used as public proof | Not shown | Not shown |
| Prompt fingerprint | Available as evidence | Usually minimized | Only when allowlisted |
| Source media reference | Recorded for workflow | Not shown by default | Not shown by default |
| Completed shareable output | Available | Eligible outputs only | Approved eligible outputs only |
| Narration derivative | Private | Excluded | Excluded |
| Burned-caption derivative | Private | Excluded | Excluded |
| Technical publication evidence | Available in the workspace | Not required | Shown only after finalization |
| DKG local/private evidence | Retained privately | Not shared as a public proof link | Not shown |
| DKG Shared Working Memory | May be retained locally | May be shared with DKG peers | Not an on-chain public proof record |
| Anchored Base Sepolia evidence | Available after finalization | Not required for client review | Allowlisted technical links only |

Do not infer that every generated output is shareable. Storage state, privacy, campaign status, and delivery eligibility all matter.

## Proof-ready checklist

Before sharing a public proof page, confirm:

1. The owner selected **Approve pack**.
2. Every required plan stage is ready.
3. Known ratio mismatches are resolved.
4. The reviewed output is durably stored and eligible for delivery.
5. The campaign status says **Public verification ready**.
6. The proof page shows the intended assets and claim summary.
7. You understand that the page records PermitFrame evidence, not legal ownership or automatic compliance.

## If proof is not ready

### Campaign record saved

Publication may still be in progress. Keep the page in the workspace and check again after the publication state settles.

### Storage is pending

The provider result can remain intact while durable storage is retried. Do not approve or publish an undeliverable output.

### A ratio needs review

Correct the output or change the active plan. A known mismatch is not eligible for owner approval until it is resolved.

### Client feedback conflicts with the owner decision

Record the feedback, revise if needed, and let the authenticated owner make the final campaign decision. The client response itself never grants final approval.

## Limits of verification

A public proof page shows what PermitFrame recorded. It does not independently verify identity, legal ownership, automatic legal compliance, or guaranteed provider output.

Creator attestation proves the declaration and integrity of that record. Owner approval proves the recorded owner decision. Base Sepolia evidence proves public testnet provenance for a finalized record, not mainnet finality or legal ownership. Use legal review for questions that require legal assurance. See [DKG and proof](./dkg-and-proof.md) for the full trust boundary.
