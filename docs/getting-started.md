# Getting started

This guide takes a new workspace from empty setup to an owner-approved campaign. Follow the steps in order because each step supplies an input for the next one.

![Empty Campaigns screen with the first-run actions](../public/docs/empty-campaigns-first-run.png)

## Before you begin

You need:

- A signed-in PermitFrame workspace.
- A creator you have permission to work with.
- A public HTTPS reference to approved source media.
- A clear campaign purpose, platform, territory, and expiry.
- Brand-approved claims when the campaign will make product claims.

Creating the setup records does not generate media. Paid work begins only after you review and confirm a production plan.

## First-run path

### 1. Add a creator

Open **Media library** and choose **Add the first creator**.

Enter the creator name and, optionally, a handle. This record identifies who appears in the workflow. It does not verify identity or legal ownership, and it does not create permission by itself.

### 2. Add creator-owned media

Still in **Media library**, add a source image or video. **Upload from computer** is recommended; **Use public URL** remains as the advanced path.

- Choose the creator explicitly.
- For uploads: pick a file (images up to 10 MB, video up to 25 MB), optionally title it, and select **Upload**. The original is stored as an authenticated Cloudinary copy; only a time-limited download link (expires one hour after creation) is shared with the production service at generation time.
- For URL references: paste a public HTTPS reference, confirm the media type, and select **Register**. PermitFrame records the reference and a fingerprint; the source file remains with the creator or the service that hosts it.

![Media library with the first creator form and source asset registration visible](../public/docs/creator-media-onboarding.png)

### 3. Request and receive consent

Open **Creator permissions**, select **New consent request**, and complete the three-step request flow.

1. Select one or more media items belonging to one creator.
2. Choose platforms, territories, optional transformations, a future expiry, and the campaign purpose.
3. Review the frozen request and select **Create and send request**.

Send the request link to the creator. The creator can narrow the offered terms but cannot widen them. A permission becomes active only after the creator completes **Attest my permission**.

If you selected no transformation, the request is display-only and will not authorize derivative campaign production.

![Creator permissions with the three-step consent request form open](../public/docs/consent-request-flow.png)

### 4. Add brand rules if needed

Open **Brand rules** and add the product that the campaign will represent.

Record:

- Brand and product.
- Approved claims.
- Prohibited claims.
- Brand guidance.
- Evidence notes for the claims.

A campaign that makes no product claim can continue without this step. If the brief includes a claim, keep the wording aligned with the approved list.

### 5. Create a campaign and run the permission check

Open **Campaigns**, select **New campaign**, and complete the campaign request.

Choose the exact creator permission, source media, brand rule, covered country, and creative brief. Then select **Create & run permission check**.

- **Changes needed before creation** means the recorded inputs do not authorize this campaign. Fix the linked permission or brand-rule issue, then check again.
- **Approved to create** opens the campaign in **Creative Studio**. No paid work has started yet.

### 6. Choose a production plan

In **Creative Studio**, choose **Short clip** or **Campaign film**.

For a short clip, review:

- Campaign recipe and pack scope.
- Deliverable formats and optional motion.
- Requested duration from 3 to 15 seconds.
- Quality profile.
- Optional model override.
- Optional maximum spend cap.

**Automatic (recommended)** resolves a currently available production capability. A manual image or motion model is advanced use. Model availability can change. If a saved override is no longer available, change it before applying the plan.

### 7. Review the plan before generation

Read the full production plan before spending.

Check:

- Every selected stage.
- Every requested format.
- The displayed estimate, or the notice that live pricing is unavailable.
- The model or capability selected for each stage family.
- The spend cap and the number of outputs.

Select **Apply new production plan** if the plan needs to change. Apply it again whenever the requested scope changes.

### 8. Generate only after reviewing the plan

In **Creative plan**, select the deliverables you want and review the confirmation summary. Select **Generate selected assets** only when the scope and estimate are acceptable.

Livepeer performs the selected image, variation, animation, or other supported media-generation stages. PermitFrame orchestrates the plan, records provider outcomes and returned costs, stores completed assets, and prepares evidence.

The queue shows real progress. A failed stage remains a failure with an honest retry path. PermitFrame does not substitute a placeholder output.

### 9. Review ratio and quality signals

Open **Review & deliver** after the active plan is complete.

Review each asset for:

- Requested format and actual ratio.
- Visual quality and campaign fit.
- Automated review findings.
- Storage and delivery status.
- Any failed, blocked, or unassessed stage.

A known ratio mismatch can block delivery. Automated visual review is advisory and does not approve an asset. The workspace owner makes the final human decision.

### 10. Verify shared proof and client delivery

When every required stage is ready, the owner can select **Approve pack**.

After approval, you can:

- Create a client share link for review.
- Open the campaign in **Verification**.
- Share the public proof page after its publication status becomes **Public verification ready**.

Client recommendations and change requests are advisory. Only the authenticated workspace owner can give final campaign approval. For the difference between local, shared, and anchored proof, see [DKG and proof](./dkg-and-proof.md).

## If the permission check blocks you

Use the reason shown on the campaign:

- Fix creator permissions when media, territory, platform, expiry, or transformation scope is missing.
- Fix brand rules when a claim is unapproved, prohibited, or unsupported.
- Re-run the permission check after changing the relevant record.

Do not try to work around a blocked result. The blocker is the product preventing an unrecorded right from becoming paid production.

## What success looks like

A successful first run leaves you with:

- A creator record and creator-owned source reference.
- An active creator permission created by attestation.
- Optional brand rules tied to the campaign product.
- A campaign that passed the recorded permission check.
- A reviewed plan with selected stages and cost controls.
- Human-reviewed outputs with ratio and quality status.
- Owner approval, advisory client feedback, and a point-in-time proof record when publication completes.
