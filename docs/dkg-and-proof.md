# DKG and proof

PermitFrame uses OriginTrail DKG knowledge to make campaign rights decisions and preserve campaign provenance. DKG is not a replacement for human review or legal advice. It is the evidence layer that lets PermitFrame keep the permission decision, production record, and later verification record connected.

This is the Track 2 story in one sentence:

> PermitFrame checks recorded rights before spend, sends only approved production work to Livepeer, and can carry an approved campaign record into an anchored Base Sepolia proof record.

## Where DKG enters the workflow

Before production spend, PermitFrame checks the selected inputs that authorize the campaign:

- The selected permission record.
- The creator.
- The approved source media.
- The permitted claims.
- The platform.
- The territory.
- The requested transformations.
- The validity window.
- The revocation state.

A creator's consent is a link-based attestation. PermitFrame, OriginTrail, Base, and Livepeer do not independently verify the creator's identity, legal ownership, or legal compliance. The attestation records a declaration and its integrity inside the workflow.

## The Track 2 flow

1. **Creator permission** - the creator receives a bounded consent request and attests through the link.
2. **Policy check before spend** - PermitFrame checks the selected permission, creator, approved media, claims, platform, territory, transformations, validity window, and revocation state.
3. **Livepeer production** - only the selected production stages are submitted after the policy check allows the work.
4. **Owner approval** - the workspace owner reviews the completed pack and gives final campaign approval.
5. **Anchored campaign record** - after approval, an explicitly published campaign record can be finalized in Verifiable Memory on Base Sepolia.
6. **Public verification page** - a finalized record can expose its allowlisted campaign evidence and technical links.

A campaign that remains local or shared has not reached the final public proof state. An approval alone does not mean that publication has finalized.

## Three proof states

| State | What it means | Public proof link |
| --- | --- | --- |
| **Local/private** | The record is retained privately in the workspace or local evidence store. | No public proof link. |
| **Shared Working Memory** | DKG evidence may be shared with the configured peers or context graph. It is not an on-chain public proof record. | No finalized Base Sepolia transaction link. |
| **Anchored/finalized** | The approved campaign record has a canonical UAL and finalized Base Sepolia evidence. | Public verification can show the finalized technical details. |

The lifecycle is:

```text
private/local → Shared Working Memory → anchored Base Sepolia
```

PermitFrame keeps the state explicit. It does not infer public proof from a record name or an ID shape.

## What a finalized Base Sepolia record can show

For a real finalized Base Sepolia record, PermitFrame can show the following technical evidence:

- **UAL:** `did:dkg:base:84532/<contract-address>/<token-id>`
- **Knowledge Asset token link:** `https://sepolia.basescan.org/token/<contract-address>?a=<token-id>`
- **Finalization transaction link:** `https://sepolia.basescan.org/tx/<transaction-hash>`

The contract address and token ID are derived from the record's actual UAL. There is no universal contract address hardcoded into the documentation or the product. The transaction link appears only after the DKG publisher reports a genuinely finalized anchored record with the required evidence.

`84532` is the Base Sepolia testnet chain ID. Base Sepolia evidence is public testnet provenance evidence. It is not Base mainnet finality, a legal ownership certificate, or an independent determination that a campaign is legally compliant.

OriginTrail explorer indexing can be incomplete for testnet records. BaseScan provides direct Base Sepolia technical evidence for the Knowledge Asset token and the finalization transaction when those values are available.

## What this proves and does not prove

### What it proves

- PermitFrame recorded a specific permission and campaign decision at a specific point in the workflow.
- The selected production stages and returned outputs were connected to campaign provenance records.
- A finalized Knowledge Asset can have a canonical UAL and Base Sepolia transaction evidence.
- Public verification can point a reviewer to allowlisted evidence instead of exposing private workspace material.

### What it does not prove

- It does not independently verify a creator's identity.
- It does not prove legal ownership of source media.
- It does not provide automatic legal compliance.
- It does not guarantee a Livepeer provider result.
- It does not turn Shared Working Memory into an on-chain public record.
- It does not make client feedback into final owner approval.

## What remains private, shared, and public

| Material | Local/private | Shared Working Memory | Anchored public testnet evidence |
| --- | --- | --- | --- |
| Contracts and contact details | Remains private | Not published by PermitFrame | Not shown. |
| Full prompt text | Not part of public proof | Not published as public proof | Not shown. |
| Source media file (public URL) | PermitFrame retains the URL reference and its fingerprint; the file remains at its external host. | May be represented by minimized evidence. | The original file and its URL are not shown by default. |
| Source media file (private upload) | Stored as an authenticated Cloudinary workspace copy with a byte fingerprint and controlled storage reference. | Only minimized classification or integrity evidence may be represented. | The original, storage reference, Cloudinary identifier, signed delivery URL, and byte hash are not shown. |
| Permission and claim summary | Available to the workspace | May be queried as DKG evidence | Allowlisted summary only. |
| Campaign outputs | Workspace delivery state | Receipt evidence may be shared | Only approved, eligible, finalized outputs. |
| Narration and burned-caption derivatives | Private | Not promoted as public proof by default | Excluded. |

A public verification page is a point-in-time view of the evidence that PermitFrame chose to publish. It is not a live mirror of every later workspace change.

## Where to look in PermitFrame

- **Verification** - open an approved campaign proof from the signed-in workspace.
- **Proof inspector** - inspect the underlying DKG records and their state when you need technical detail.
- **Review & deliver** - open Technical details after approval to see available record links.

Do not treat a blank or incomplete OriginTrail explorer result as proof that a record was not published. Check the explicit PermitFrame state and the direct Base Sepolia evidence when available.

## Further reading

- [OriginTrail DKG overview](https://docs.origintrail.io/)
- [OriginTrail Knowledge Assets and UALs](https://docs.origintrail.io/how-dkg-works/knowledge-assets)
- [OriginTrail DKG networks](https://docs.origintrail.io/general/networks)
- [Base network details and Base Sepolia](https://docs.base.org/base-chain/quickstart/connecting-to-base)
