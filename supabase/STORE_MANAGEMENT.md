Store Management is implemented in the POS platform administration console and
uses the existing organisations, stores, locations, profiles, subscription plans,
store features, employees, and org_audit_logs. It introduces no separate user or
organisation directory.

Deployment order

1. Back up and test against a staging copy with the existing NORDVIK organisation,
   enterprise store, subscription and store_features migrations installed.
2. Run `supabase/store_management.sql`, then `supabase/store_applications.sql` as the database migration owner. The scripts
   is transactional and rerunnable. It makes no inventory, transaction or customer
   record changes. It adds triggers to existing tenant tables to reject writes
   while their organisation/store is inactive.
3. Deploy `nordvik-store-owner-invite` and redeploy `create-store-employee` using
   its existing deployment name, `dynamic-function`. Keep JWT verification enabled.
   The invite endpoint also verifies the user JWT and platform role itself.
4. Configure `RETAILER_OWNER_INVITE_REDIRECT_URL` to the existing NORDVIK account
   password setup page and allowlist it in Supabase Auth redirect URLs. Supabase's
   server-side service key is used only inside the Edge Function. The existing
   website handles password setup; no second account system is introduced.
5. Ship the POS and NORDVIK website builds after the migrations and functions are deployed.

The website's Choose Store form now submits structured data to the existing
organization_applications table. Store+ is hidden from public plan selection;
legacy subscriber records are retained. Store Management in both products shows
the application queue. Administrative approval provisions an Approved organisation
through the same central workflow; owner invitation, per-location tax review and
activation remain separate. Applicants can see their status/review notes, and
rejected applicants can submit corrected details. Submission never grants a
Store tier or creates an organisation. Apply the shared migrations only once;
the website contains the same scripts under supabase/migrations/202610210001*
and 202610210002*. Its full deployment notes are in supabase/STORE_ONBOARDING.md.

Apply restore_nordvik_test_organization.sql afterward (website migration
202610210003_restore_nordvik_test_organization.sql). This corrects the Draft
default for the known, pre-existing ORG-0001 only when every associated store is
already an active test store. It restores internal test access, adds an audit
entry and leaves owner, tax, inventory, transactions and customers unchanged.
It does not manufacture production approval or tax-review timestamps, restore a
deliberately suspended organisation, or exempt other organisations from review.
Store Management derives its Test organisation badge from the existing store
test flags; those flags can only be changed by NORDVIK administrators.

Existing organisations deliberately enter Draft, including those currently in
operation: do not roll this out during trading without preparing their reviews.
They are not grandfathered into approval. In Store Management select Manage →
Configure Draft Onboarding, supply their business details and *current owner's*
email, submit for verification, explicitly approve, link/invite the owner, review
taxes, then activate. Their existing store, employee, inventory, transaction and
customer IDs remain intact. Existing standalone stores retain access; new
standalone store creation is blocked. Provisioned draft stores temporarily use
the creating administrator's owner ID to satisfy the existing non-null foreign
key; linking the designated owner updates the existing store/location/settings
ownership before activation.

Activation is a separate transaction following Approved. Suspended organisations
must return through Pending Verification and Approved before reactivation.
Suspension does not delete records or cancel financial obligations. Existing
sessions lose store access through user_store_ids() immediately; write triggers
also protect legacy SECURITY DEFINER RPCs and service endpoints. Employee
creation/password changes explicitly check active status before Auth mutations.

GST/HST registration supports registered, not registered, and not required.
Registered businesses must provide a nine-digit business number followed by RT
and four account digits. New locations start at zero tax, irrespective of
province. Save Tax Review explicitly writes reviewed GST/HST rates to the existing
location tax fields for each selected location. Every location needs review
before initial activation. Other applicable taxes need their own configuration;
the second existing tax rate is preserved. It does not infer
tax obligations, enable collection on creation, or create billing purchases.
Activation assigns the selected existing Store/Store Pro subscription tier to
the owner's existing profile; it does not charge a payment method.

Platform privileges continue to use profiles.subscription_tier = platform_admin.
The new profile trigger prevents client self-assignment of platform privileges;
existing non-platform subscription purchase flows remain intact. Bootstrap/revoke platform administrators through trusted
server provisioning (service_role), never through public signup metadata.
Organisation/store/location deletion is rejected; use suspension. Audit rows
are append-only and record actor, timestamps and before/after snapshots; invite
requests/failures and administrative decision notes are also recorded.

Verification

`npm run build`

The isolated database regression suite uses PostgreSQL via PGlite and a minimal
fixture matching the shared schema. It runs the migration twice and tests direct
API/legacy RPC bypasses, RLS isolation, privilege escalation, status transitions,
owner matching, tax controls, suspension and retained operational records:

```
npm install --prefix <temporary-directory> --no-package-lock @electric-sql/pglite
node scripts/test-store-management.mjs <temporary-directory>/node_modules/@electric-sql/pglite/dist/index.js
```

Before production, repeat the checks against the full staging schema and verify
the invitation email/password setup flow with staging SMTP. Tests do not send
emails, deploy functions or run migrations against the live project.
