# NORDVIK Identity in CollectorsHub POS

Identity verification for customers who sell merchandise to a store (buybacks, trade-ins and the buyback part of exchanges). NORDVIK Identity is built as its own service so other NORDVIK apps can use it later.

## Boundaries

**NORDVIK Identity** owns everything identity-related:

- identity profiles
- verification sessions and attempts
- consent records
- evidence (ID images and live photos)
- decisions and manual review
- the identity photo
- revocation
- a tamper-evident audit trail

Its parts:

- **Database:** `supabase/nordvik_identity.sql`. These tables are locked: RLS is on, with no policies and no grants for app users.
- **API:** the Edge Function `supabase/functions/nordvik-identity` (v1 routes, listed at the top of the file). Only this service, using the service role, reads or writes the tables.
- **Private storage:** the bucket `identity-evidence` holds the evidence and the identity photos.
- **Phone page:** `nordvik-identity/mobile/index.html`, a static page hosted over HTTPS.

**CollectorsHub POS** handles the store side:

- creating customers
- starting verifications (the wizard)
- showing the status and identity card
- the reviewer screen (Admin → Identity Reviews)

**Blocking buybacks** happens in two places:

- **In the POS:** checkout is blocked for unverified sellers.
- **In the database:** a trigger on `store_transactions` rejects `trade_in` and `exchange` rows when the customer isn't verified. Every client is covered, and the POS screen can't be used to get around it.

**Account mapping:** `identity_profiles.account_id` points to `profiles.id`. Existing customer ids aren't changed.

**The identity photo is not the CollectorsHub profile picture:**

| | Identity photo | Profile picture |
|---|---|---|
| Field | `identity_profiles.portrait_path` | `profiles.avatar_url` |
| Storage | the private `identity-evidence` bucket | ordinary storage |
| Retrieved through | its own endpoint (`/profiles/{id}/portrait`, with a purpose, logged) | ordinary profile endpoints |

Neither one ever replaces the other. The POS never falls back to the profile picture.

## Statuses

- **A person's status** (`identity_profiles.verification_status`): `unverified`, `pending`, `processing`, `manual_review`, `verified`, `failed`, `expired`, `revoked`.
  - `expired` takes effect when the ID used expires.
  - `revoked` always takes precedence.
- **A session's status** is separate. A failed new attempt doesn't remove an earlier valid verification.
- **Only NORDVIK Identity sets `verified`**, in one of two ways:
  - an approved provider's automated result. None is connected yet.
  - an authorised reviewer's decision. A reviewer can't decide a verification they started.

## What's needed to deploy

1. Run `supabase/customer_full_name.sql`, then `supabase/nordvik_identity.sql`.
2. Deploy `supabase/functions/nordvik-identity`. If Supabase gives it a different name, set `IDENTITY_FUNCTION` in `src/identity/nordvikIdentity.js` and the `API` address in the phone page to match.
3. Host `nordvik-identity/mobile/index.html` over HTTPS, for example on the CollectorsHub website at `/identity/verify`. Then set the function's secret `MOBILE_VERIFY_URL` to that address.
4. Add reviewers by inserting their user ids into `identity_reviewers`, using the service role. Reviewers should be NORDVIK Identity staff, not store employees.
5. Schedule `POST /v1/identity/maintenance/purge`, authenticated with the service role key, daily. It deletes evidence 7 days after a decision and ID details after 90 days.
6. Redeploy `create-customer-account` (deployed as `hyper-worker`).

## Outstanding dependencies (not built: nothing here fakes them)

- **An evaluated verification provider:**
  - document authenticity checks
  - OCR, PDF417 and MRZ reading
  - face comparison
  - liveness / presentation-attack detection

  Plug it into `PROVIDERS` in the Edge Function. Its thresholds must come from its own false-accept / false-reject testing. Until one is connected, every submission goes to manual review.
- **White-background headshots:** these need the provider's (or a dedicated) background-removal model. Until then, an approved customer's unedited live photo is kept as an interim identity photo, marked `live_photo_unprocessed`. It gets regenerated once a provider exists.
- **Liveness on the phone page:** only brightness, blur and (where the browser supports it) face-count guidance runs today. Real liveness detection needs the provider.
- **Legal review:** a privacy/legal review of the consent notice (v3) and the retention periods for Canadian privacy law, before real customers use it.
- **Rate limiting on the phone endpoints:** today it's per function instance, plus a cap on failed attempts per token. Put a gateway or WAF in front for production.

## Tests run (2026-10-08)

All of these used the dev preview with a **mock** NORDVIK Identity, which is clearly labelled in `src/devPreview.jsx`, a simulated camera, and no real provider.

| Test | Result |
|---|---|
| Consent typed by the customer, then both sides of a driver's licence by webcam | Passed |
| ID details; a name mismatch with the account | Flagged |
| Phone QR generated, with countdown and "Waiting for customer" | Passed |
| Back to webcam, face photo, submit | "Waiting for review" (mock: manual_review), with 3 evidence items and consent recorded |
| Service unreachable | Clear error; the wizard stops |
| Phone page with a bad link | Refused; the token is removed from the address bar |
| Identity card, verified (mock photo, legal name, date of birth) and unverified (silhouette, Verify Customer) | Displayed correctly |

**Not tested yet:** anything that needs the deployed function, SQL, storage, a real phone, or a real webcam or scanner. That includes:

- QR expiry and reuse
- cross-customer session substitution
- server-side buyback enforcement
- portrait access permissions
- revocation
- multi-store status

## Buyback identification (three methods)

`supabase/buyback_identification.sql` must run **after** `nordvik_identity.sql`, because it replaces that file's buyback trigger. A store can buy from a customer who is identified in one of three ways. These are separate records, never one "verified" flag:

| Method | Level | How it's recorded |
|---|---|---|
| `nordvik_identity` | Account (NORDVIK Identity status) | Automatically by the server when the transaction is recorded |
| `manual_id_check` | This transaction only | An employee confirms they examined the ID (POS card → "Manually check ID for this transaction"). The account stays unverified. |
| `guest_manual_id_check` | This transaction only | Guest Buyback Information: details plus the confirmation. No account needed. |

**Records** (`store_buyback_identifications`):

- The employee is always the signed-in user, set by the server.
- Records are append-only. A manager's correction is a new record that points to the original.
- Each record is linked to the transaction by the `store_transactions` trigger. The trigger also fills in the legacy `id_verified` / `id_type` / `id_verified_by_employee_id` columns.
- Head office sees them under Stores → ID rules → Identification log.

**Matching:** a manual check or guest record is valid for 30 minutes and for one transaction.

- **Registered customers:** matched by the customer.
- **Guests:** matched by the employee who recorded the details.

**Rules per location** (Stores → ID rules), with a store default:

- which ID types are accepted
- which of date of birth, address, contact and ID number must be recorded
- a minimum age
- whether manual checks and guest buybacks are allowed
- a note naming the requirement the rules follow

The server checks the rules again. Set them to match each location's second-hand dealer obligations.

**Tested with mock data** (dev preview):

- **Manual check:** stays blocked until the date of birth and the confirmation are given. It sends only the fields the rules require.
- **Guest check:** stays blocked until every required field is filled in.
- **Card:** shows the unverified buyback options, and the "ID checked manually" state (never shown as verified).
- **Rules:** save correctly.
- **Log:** displays correctly.

**Not tested against a database yet:** the trigger, the matching, and the append-only guard.

## Demo verification (development / testing only): JoeTest

`supabase/demo_joetest.sql` (run after the identity SQL files) makes the existing `JoeTest` account the reference customer for the identity interface.

**What it does:**

- **Account:** finds the account by username. It refuses if the account is missing, duplicated, or already has a real verification. No other account is touched.
- **Status:** sets `verified_method = 'demo'` and `is_demo = true`, with a fictional date of birth (1990-04-12).
- **Name:** uses the account's own name, "Joe Test" only if that's what the account says.
- **Records:** writes a demo session and attempt labelled as such (provider `demo`, no document, no images), plus an audit event.

**Where it counts:**

- **Test stores only:** a demo verification is recognised only at stores with `stores.is_test_store` (Nordvik Test Store). There it shows as **Demo Verified** (purple, with a "not a real identity check" note) and allows test buybacks, recorded as `demo_identity`.
- **Everywhere else:** JoeTest is unverified, no photo is served, and demo never satisfies a production buyback (`identity_buyback_allowed` excludes it).
- **Real verification:** a real verification clears the demo flag.

**Photo:** a fictional illustrated headshot on white, at `nordvik-identity/demo/joetest-demo-headshot.png`. Upload it to the private bucket at `identity-evidence/portraits/demo/joetest-demo.png`. It's the NORDVIK Identity photo only; JoeTest's CollectorsHub profile picture isn't changed.
