# PermitFrame

**From creator consent to verified campaign pack — without generating outside the rights you purchased.**

PermitFrame is a verified, agentic campaign-production platform for UGC agencies, brands and creator managers. It compiles creator permissions and verified product facts from the **OriginTrail DKG** into enforceable production policy, then builds the complete campaign pack through the **Livepeer Agent**. Every derivative carries a receipt linking back to the source media, the permission passport and the claim evidence.

Built for **Track 2 (Livepeer Agent + OriginTrail DKG)** of the Atumera Livepeer Agent Hackathon.

---

## The demo in 60 seconds

1. **Blocked.** Open the *TikTok / Germany* campaign. The DKG query returns no applicable permission passport (tiktok not permitted, DE not covered) and "waterproof" is on the prohibited-claims list. PermitFrame refuses to spend inference money and shows the three precise reasons with evidence references.
2. **Allowed.** Open the *Instagram / Greece* campaign. Rights and claims verify. The agent compiles a constrained production brief (brand guidelines + verified-claims-only rules) and generates **keyframe → square variation → 5s vertical video** through the Livepeer Agent, with live cost per output.
3. **Review & approve.** Request one reviewer revision, then approve the pack — a Campaign Production Record is published and every output already has a Derivative Receipt Knowledge Asset.
4. **Verify.** Each output has a public verification page: media hash, generation capability, prompt hash (prompt stays private), claims used, and the full lineage — source media, permission passport, product facts.

## What the DKG actually controls (not blockchain-flavoured storage)

Before Livepeer is ever called, the policy engine runs **real SPARQL queries** against the knowledge graph:

- *Which passports cover this creator + platform + country + date?* → decides **whether** generation may run at all
- *Which claims are verified for this product?* → decides which advertising claims the prompts may state, and which are prohibited
- *Which transformations are permitted?* → decides **which** capabilities may be used (animate vs image-only)

Every decision is displayed with its query ("Show the SPARQL queries the agent ran"), blockers carry evidence references, and allowed requests show a "Why this was allowed" panel.

### Knowledge Assets

| # | Asset | Purpose |
|---|-------|---------|
| 1 | Creator Permission Passport | platforms, territories, transformations, validity, creator attestation |
| 2 | Verified Product Facts | approved claims, prohibited claims, brand guidelines, evidence notes |
| 3 | Source Media Record | reference URL + content hash (never the bytes) |
| 4 | Campaign Production Record | the campaign and its policy decision |
| 5 | Derivative Receipt (per output) | output URL/hash, capability, prompt hash, claims used, full lineage |
| 6 | Permission Amendment / Revocation | rights changes over time |

## Architecture

```
Next.js (App Router, TypeScript)
├── src/app            UI: dashboard, campaign workspace, public verify page, creator consent portal
├── src/app/api        Route handlers (thin controllers)
└── src/server         Framework-agnostic backend core (liftable into a dedicated service)
    ├── policy/        Preflight engine: DKG queries → allow/block + compiled prompt constraints
    ├── livepeer/      MCP client (raw surface, exact-dispatch run_capability) + production pipeline
    ├── dkg/           OriginTrail DKG V10 Edge Node adapter + local-evidence adapter, KA schemas, SPARQL
    └── store.ts       Operational state (campaigns, jobs) — rights/facts truth lives in the DKG layer
```

The Livepeer integration is **orchestrator-grade**: the policy engine plans the pipeline, the raw MCP surface dispatches exact capabilities (`flux-schnell` text-to-image / image-to-image, `seedance-mini-i2v` image-to-video), and the client auto-recovers when a capability is disabled by using the replacement the network itself recommends. Every job records livepeer job id, capability actually served, and **cost in USD** from the network's billing fields.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

First load auto-seeds the demo workspace (fictional sustainable shoe brand **Verdi Steps**, creator **Maya Chen**, both demo campaigns) and publishes the Knowledge Assets through the configured DKG adapter.

### Environment (`.env.local`)

```bash
# Livepeer Agent (raw MCP surface, exact-dispatch)
LIVEPEER_MCP_URL=https://agent.livepeer.org/api/mcp/raw
LIVEPEER_MCP_BEARER=            # optional: sk_... key from app.daydream.live
                                # empty = keyless demo credit (~$10 / address)

# OriginTrail DKG V10 Edge Node
DKG_MODE=edge
DKG_CLI_BIN=dkg
DKG_CONTEXT_GRAPH=permitframe
DKG_CONTEXT_GRAPH_ID=<primary-operational-wallet-address>/permitframe

# Custom capabilities (optional overrides)
LIVEPEER_IMAGE_CAPABILITY=flux-schnell
LIVEPEER_VIDEO_CAPABILITY=seedance-mini-i2v
```

**DKG modes.** Without DKG configuration the app runs in *local evidence mode*: identical Knowledge Asset schemas and SPARQL semantics persisted under `.data/dkg/`, clearly labelled in the UI. `DKG_MODE=edge` uses an OriginTrail **DKG V10 Edge Node** (Base Sepolia testnet): `npm i -g @origintrail-official/dkg`, `dkg init --role edge --network testnet`, then `dkg start`. Passport/facts/media/campaign/receipt publishes first create Shared Working Memory evidence: an assertion URI and Merkle root, with every preflight decision using live SPARQL against the node. A real, explorer-resolvable UAL exists only after the separate Verifiable Memory on-chain publish succeeds.

**Livepeer auth.** The raw surface honours keyless demo credit; for reliable demos create a key at app.daydream.live and set `LIVEPEER_MCP_BEARER`.

## Privacy & responsible-data model

- Contracts, contact details and raw prompts **never** enter the DKG — only minimized rules, hashes and references.
- Prompts are published solely as SHA-256 hashes; media as reference URLs + content hashes.
- Every asset carries a visibility label (`private` / `shared` / `public`).
- Attestations prove **the declaration and its integrity** — not that the creator legally owns every right they grant. The verification page states this explicitly.

## Tech stack

Next.js 16 (App Router) · TypeScript · React 19 · Tailwind CSS 4 · OriginTrail DKG V10 Edge Node · Livepeer Agent MCP (streamable HTTP JSON-RPC)

## Roadmap after the hackathon

Open-core: PermitFrame Core (schemas, policy engine, agent orchestration, receipt verifier) stays open; the hosted SaaS adds workspaces, approvals, billing and integrations. Next: rights-expiration calendar, platform presets, batch variants, campaign proof-bundle export, policy simulator ("what changes if the region/claim changes?").
