# PermitFrame

**PermitFrame helps creative teams turn approved creator rights and brand rules into platform-ready AI campaign assets — with a reviewable proof trail.**

## User problem and target customer

An agency creative producer or brand marketing manager needs AI campaign assets fast, but every asset carries rights risk: *may this creator appear here? Is this claim approved? Is this territory covered?* Today those checks live in spreadsheets, inboxes, and memory — a blocked-by-rights surprise arrives after money is spent, or worse, after publishing. PermitFrame moves the rights decision **before** generation spend and attaches reviewable proof to every output.

## Product workflow

1. **Creator permissions** — invite a creator; they attest platforms, territories, expiry, and usage on a consent link. Only attestation creates the permission.
2. **Brand rules** — set approved claims, required disclosures, and prohibited language per product.
3. **Campaigns** — brief a campaign. The permission check runs automatically:
   - **Changes needed before creation** — precise reasons plus where to fix them; nothing can generate.
   - **Approved to create** — the campaign opens in Campaign Studio.
4. **Campaign Studio** — refine the brief, select deliverables (vertical 9:16, feed 1:1, landscape 16:9), generate with the production service, review outputs, approve the pack.
5. **Verification** — every output links to a proof page: the asset, verified claims, creator permission, and brand rules behind it.

## Why Livepeer Agent is essential

Generation is not a mock: the studio dispatches exact capabilities (`flux-schnell` text-to-image, `seedance-mini-i2v` image-to-video, chosen from **live MCP discovery**, never a hardcoded claim) through the Livepeer Agent raw surface. The orchestrator runs only producer-selected stages, chains stage outputs, records the real capability served (including network-recommended auto-recovery), per-stage cost in USD, job ids, and output URLs. A failed provider call surfaces honestly with retry — outputs, receipts, and verification links only ever reference real results.

## How OriginTrail DKG materially changes behaviour

**Before generation:** the policy engine runs real SPARQL against the DKG — which permissions cover creator + platform + country + date, which claims facts support, which transformations are allowed. The compiled decision gates spend: blocked campaigns cannot start jobs, at the API layer, not just in the UI.

**After generation:** each output gets a Derivative Receipt; approval publishes a minimized campaign record. Routine records live in Shared Working Memory; only a finalized Verifiable Memory publish earns **Public verification ready** — the UI keys this off an explicit persisted publication state, never ID-shape guessing.

## What stays private, what is shared, what is publicly verifiable

- **Private:** contracts, contact details, full prompts (stored as SHA-256 hashes), source media bytes (only reference URL + content hash recorded).
- **Shared:** minimized permission/claim references and receipts in Shared Working Memory for preflight and review.
- **Publicly verifiable:** only records whose publisher job genuinely finalized — shown with explorer links inside Technical details. Attestations prove the declaration and its integrity, not legal ownership.

## Setup and run

```bash
npm install
npm run dev          # http://localhost:3000
```

`.env.local` requires: `DATABASE_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` for login; `DKG_MODE=edge`, `DKG_CLI_BIN=dkg`, `DKG_API_PORT=9200`, `DKG_CONTEXT_GRAPH_ID=<agent-address>/permitframe` for the real DKG path (`local` mode keeps identical schemas offline); `LIVEPEER_MCP_URL` defaults to the hosted agent, optional `LIVEPEER_MCP_BEARER` for the API-key path. DKG capabilities can be pinned via `LIVEPEER_IMAGE_CAPABILITY` / `LIVEPEER_VIDEO_CAPABILITY`.

Edge Node: `npm i -g @origintrail-official/dkg`, `dkg init --role edge --network testnet`, then keep `dkg start` running. Check with `dkg status`, `dkg wallet`, `dkg publisher job <id>`; app health at `/api/health` (signed in) and discovery at `/api/livepeer`.

## Demo flow

1. Sign in → Campaigns → New campaign with a deliberately off-rights brief → **Changes needed before creation** with reasons and fix links.
2. Fix via Creator permissions (invite + attest) or Brand rules → re-check → **Approved to create** → Campaign Studio.
3. Edit brief controls → select the vertical deliverable → Generate → confirm estimate → watch the queue → review the real output.
4. Approve & publish → **Campaign record saved**, then **Public verification ready** once the publisher finalizes → open the Verify link.

In-product example fillers are labeled **Guided scenario**. Health: `node --env-file=.env.local scripts/check-neon.mjs`. Quality gates: `npx tsc --noEmit`, `npx eslint src/`, `npm run build`, `npm test`.

## Known limitations

- The DKG Edge Node daemon must be running; when it is down, preflight, publishing, and verification fail explicitly with retries — nothing is faked.
- Anonymous (logged-out) `/verify/*` and `/share/*` requests currently fail because verification reads are session-scoped; public client review links require the viewer to be signed in.
- Keyless Livepeer access depends on hosted quota; set `LIVEPEER_MCP_BEARER` for the key path.
- On-chain finalization needs a funded node wallet and takes minutes; statuses stay at “Campaign record saved” until it genuinely finalizes.

Built for **Track 2 (Livepeer Agent + OriginTrail DKG)** of the Atumera Livepeer Agent Hackathon.

## Tech stack

Next.js 16 (App Router) · TypeScript · React 19 · Tailwind CSS 4 · OriginTrail DKG V10 Edge Node · Livepeer Agent MCP (streamable HTTP JSON-RPC)
