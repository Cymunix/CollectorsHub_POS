// npm install --prefix <temporary-directory> --no-package-lock @electric-sql/pglite
// node scripts/test-store-management.mjs <temporary-directory>/node_modules/@electric-sql/pglite/dist/index.js
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite')
const db = new PGlite()
// Minimal shared-schema fixture. Real table/column names match NORDVIK's
// organisations, enterprise stores, subscription and feature migrations.
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
CREATE TYPE public.subscription_tier AS ENUM ('free_collector','store','store_pro','platform_admin');
CREATE TABLE public.profiles(id uuid PRIMARY KEY, subscription_tier public.subscription_tier DEFAULT 'free_collector',billing_cycle text,subscription_started_at timestamptz);
CREATE TABLE public.subscription_plans(tier public.subscription_tier PRIMARY KEY,is_public boolean NOT NULL DEFAULT true);
INSERT INTO public.subscription_plans(tier) VALUES ('store'),('store_pro');
CREATE TABLE public.organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_code text DEFAULT 'ORG-TEST',name text,owner_user_id uuid NOT NULL REFERENCES public.profiles(id),logo_url text,banner_url text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE public.stores(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),store_code text DEFAULT 'TEST',store_name text,owner_user_id uuid,organization_id uuid REFERENCES public.organizations(id),status text DEFAULT 'active',is_test_store boolean NOT NULL DEFAULT false);
CREATE TABLE public.store_locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),store_id uuid,store_owner_id uuid,location_name text,street_address text,city text,province text,postal_code text,country text,status text,tax_rate_1 numeric,tax_rate_2 numeric,tax_label_1 text,tax_label_2 text,currency text);
CREATE TABLE public.store_settings(store_id uuid PRIMARY KEY,store_owner_id uuid,store_name text,store_public_profile_enabled boolean,inventory_publicly_visible boolean,enable_marketplace_listings boolean);
CREATE TABLE public.store_features(store_id uuid,feature text,enabled boolean,updated_by uuid,PRIMARY KEY(store_id,feature));
CREATE TABLE public.store_employees(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),store_id uuid,store_owner_id uuid,employee_user_id uuid,auth_user_id uuid,status text,role text);
CREATE TABLE public.store_inventory(id uuid DEFAULT gen_random_uuid(),store_id uuid,store_owner_id uuid,quantity integer);
CREATE TABLE public.store_transactions(id uuid DEFAULT gen_random_uuid(),store_id uuid,total numeric);
CREATE TABLE public.store_customers(id uuid DEFAULT gen_random_uuid(),store_id uuid,name text);
CREATE TABLE public.org_audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organisation_id uuid,actor_user_id uuid,action text,store_id uuid,location_id uuid,before_data jsonb,after_data jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE public.organization_applications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),applicant_user_id uuid NOT NULL REFERENCES public.profiles(id),name text NOT NULL,details text,status text NOT NULL DEFAULT 'pending',review_notes text,reviewed_by uuid,reviewed_at timestamptz,organization_id uuid,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX org_applications_one_pending ON public.organization_applications(applicant_user_id) WHERE status='pending';
CREATE FUNCTION public.create_organization(p_name text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$ DECLARE oid uuid; BEGIN INSERT INTO public.organizations(name,owner_user_id) VALUES(p_name,auth.uid()) RETURNING id INTO oid; RETURN oid; END $$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated,anon,service_role;
CREATE POLICY organizations_owner ON public.organizations TO authenticated USING(owner_user_id=auth.uid()) WITH CHECK(owner_user_id=auth.uid());
CREATE POLICY test_stores ON public.stores TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY test_employees ON public.store_employees TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY test_settings ON public.store_settings TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY test_locations ON public.store_locations TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY test_inventory ON public.store_inventory TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY test_transactions ON public.store_transactions TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY test_customers ON public.store_customers TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY test_applicant ON public.organization_applications FOR SELECT TO authenticated USING(applicant_user_id=auth.uid());
`)
const ids = { admin: '00000000-0000-0000-0000-000000000001', owner: '00000000-0000-0000-0000-000000000002', other: '00000000-0000-0000-0000-000000000003', employee: '00000000-0000-0000-0000-000000000004' }
for (const [name, id] of Object.entries(ids)) {
  await db.query('INSERT INTO auth.users VALUES ($1,$2)', [id, `${name}@example.com`])
  await db.query('INSERT INTO public.profiles VALUES ($1,$2,NULL,NULL)', [id, name === 'admin' ? 'platform_admin' : 'free_collector'])
}
await db.exec(await readFile(new URL('../supabase/store_management.sql', import.meta.url), 'utf8'))
await db.exec(await readFile(new URL('../supabase/store_applications.sql', import.meta.url), 'utf8'))
await db.exec(await readFile(new URL('../supabase/store_applications.sql', import.meta.url), 'utf8'))
// Migration must also be rerunnable without widening permissions.
await db.exec(await readFile(new URL('../supabase/store_management.sql', import.meta.url), 'utf8'))
const actor = async (who, role = 'authenticated') => {
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)", [ids[who] || '', role])
  await db.exec(`SET ROLE ${role}`)
}
let passed = 0
const denied = async (name, action, pattern) => {
  await assert.rejects(action, pattern, name); passed++; console.log(`PASS ${name}`)
}
const rpc = async (action, orgId = null, data = {}) => (await db.query('SELECT public.nordvik_manage_store($1,$2,$3::jsonb) result', [action, orgId, JSON.stringify(data)])).rows[0].result
await actor('owner')
await denied('retailer cannot create through admin RPC', () => rpc('create'), /administrator required/)
await denied('legacy create_organization cannot bypass trigger', () => db.query("SELECT public.create_organization('Unauthorised')"), /Only NORDVIK/)
await denied('direct organisation insert blocked', () => db.query('INSERT INTO public.organizations(name,owner_user_id) VALUES ($1,$2)', ['Other',ids.owner]), /Only NORDVIK|row-level security/)
await denied('profile self-promotion blocked', () => db.query("UPDATE public.profiles SET subscription_tier='platform_admin' WHERE id=$1",[ids.owner]), /cannot be self-assigned/)
await actor('admin')
const data = { legal_name:'Test Retailer',registration_number:'REG-1',contact_name:'Contact',contact_email:'contact@example.com',owner_name:'Owner',owner_email:'owner@example.com',store_name:'Test Store',address:'1 Main St',city:'Halifax',province:'NS',postal:'B3J1A1',gst_hst_status:'not_required',subscription_plan:'store',modules:{collector_scanning:true} }
const org = await rpc('create',null,data)
assert.equal(org.onboarding_status,'draft'); passed++
let detail = await rpc('details',org.id)
const storeId = detail.stores[0].id
assert.equal(Number(detail.locations[0].tax_rate_1), 0); passed++
await denied('draft cannot activate', () => rpc('status',org.id,{status:'active',reason:'Skip review'}), /Invalid onboarding/)
await denied('owner cannot be invited before approval', () => rpc('invite_requested',org.id), /Approve the organisation/)
await denied('invalid registered tax account rejected', () => rpc('create',null,{...data,gst_hst_status:'registered',gst_hst_account_number:'123'}), /GST\/HST account number/)
await rpc('status',org.id,{status:'pending_verification',reason:'Documents received'})
await rpc('status',org.id,{status:'approved',reason:'Registration verified'})
await denied('approved requires owner and tax review to activate', () => rpc('status',org.id,{status:'active',reason:'Activate'}), /Activation requires/)
await rpc('invite_requested',org.id)
await denied('cannot link mismatched owner', () => rpc('link_owner',org.id,{user_id:ids.other}), /must match/)
await rpc('link_owner',org.id,{user_id:ids.owner})
const primaryLocationId = detail.locations[0].id
await denied('unregistered business cannot collect GST/HST', () => rpc('tax_review',org.id,{location_id:primaryLocationId,rate:.15,label:'HST',reason:'Tax review'}), /unregistered/)
await rpc('tax_review',org.id,{location_id:primaryLocationId,rate:0,reason:'Not required to register'})
await rpc('status',org.id,{status:'active',reason:'Approved for launch'})
detail = await rpc('details',org.id)
assert.equal(detail.organization.onboarding_status,'active'); passed++
await db.query('INSERT INTO public.store_inventory(store_id,store_owner_id,quantity) VALUES ($1,$2,7)',[storeId,ids.owner])
await db.query('INSERT INTO public.store_transactions(store_id,total) VALUES ($1,123)',[storeId])
await db.query("INSERT INTO public.store_customers(store_id,name) VALUES ($1,'Existing customer')",[storeId])
await actor('owner')
await db.query('UPDATE public.store_settings SET store_name=$1 WHERE store_id=$2',['Authorised name',storeId]); passed++
await db.query('INSERT INTO public.store_employees(store_id,store_owner_id,auth_user_id,employee_user_id,status,role) VALUES($1,$2,$3,$3,\'active\',\'cashier\')',[storeId,ids.owner,ids.employee]); passed++
await actor('employee')
await denied('cashier cannot promote their employee role', () => db.query("UPDATE public.store_employees SET role='manager' WHERE auth_user_id=$1",[ids.employee]), /administrative permission/)
await denied('cashier cannot edit protected store settings', () => db.query("UPDATE public.store_settings SET store_name='Changed' WHERE store_id=$1",[storeId]), /administrative permission/)
await actor('owner')
await denied('retailer cannot add a location directly', () => db.query("INSERT INTO public.store_locations(store_id,store_owner_id,location_name) VALUES($1,$2,'Unauthorised')",[storeId,ids.owner]), /NORDVIK approval/)
await denied('retailer cannot suspend or activate organisation', () => db.query("UPDATE public.organizations SET onboarding_status='suspended' WHERE id=$1",[org.id]), /Only NORDVIK/)
await denied('retailer cannot detach its store', () => db.query('UPDATE public.stores SET organization_id=NULL WHERE id=$1',[storeId]), /Only NORDVIK|Tenant ownership/)
await actor('other')
assert.equal((await db.query('SELECT * FROM public.stores WHERE id=$1',[storeId])).rows.length,0); passed++
for (const table of ['store_inventory','store_transactions','store_customers']) {
  assert.equal((await db.query(`SELECT * FROM public.${table} WHERE store_id=$1`,[storeId])).rows.length,0); passed++
}
await denied('cross-tenant admin detail API rejected', () => rpc('details',org.id), /administrator required/)
await actor('admin')
await rpc('add_location',org.id,{store_id:storeId,name:'Second site',address:'2 Main St',reason:'Location approved'})
await rpc('status',org.id,{status:'suspended',reason:'Administrative hold'})
await actor('owner')
assert.equal((await db.query('SELECT * FROM public.user_store_ids()')).rows.length,0); passed++
await denied('suspended inventory inserts blocked', () => db.query('INSERT INTO public.store_inventory(store_id,quantity) VALUES($1,0)',[storeId]), /not active|row-level security/)
await actor('','service_role')
await denied('service endpoint cannot write for suspended retailer', () => db.query('INSERT INTO public.store_employees(store_id,status) VALUES($1,\'active\')',[storeId]), /not active/)
await actor('admin')
await denied('audit history immutable even for admin', () => db.query('UPDATE public.org_audit_logs SET action=\'rewritten\''), /permission denied|append-only/)
await denied('organisations cannot be deleted', () => db.query('DELETE FROM public.organizations WHERE id=$1',[org.id]), /Suspend organisations/)
assert.equal((await db.query('SELECT quantity FROM public.store_inventory WHERE store_id=$1',[storeId])).rows[0].quantity,7)
assert.equal((await db.query('SELECT total FROM public.store_transactions WHERE store_id=$1',[storeId])).rows[0].total,'123')
assert.equal((await db.query('SELECT name FROM public.store_customers WHERE store_id=$1',[storeId])).rows[0].name,'Existing customer'); passed++
await rpc('status',org.id,{status:'pending_verification',reason:'Reverification'})
await denied('suspended retailer requires fresh approval', () => rpc('status',org.id,{status:'active',reason:'Skip approval'}), /Invalid onboarding/)
const registered = await rpc('create',null,{...data,legal_name:'Registered Retailer',owner_email:'other@example.com',gst_hst_status:'registered',gst_hst_account_number:'123456789RT0001'})
await rpc('add_location',registered.id,{store_id:(await rpc('details',registered.id)).stores[0].id,name:'Second jurisdiction',address:'3 Main St',reason:'Approved new location'})
let registeredDetail = await rpc('details',registered.id)
const reviewedLocationId = registeredDetail.locations[0].id
await denied('tax review cannot target another organisation location', () => rpc('tax_review',registered.id,{location_id:primaryLocationId,rate:.05,label:'GST',reason:'Review'}), /belonging to this organisation/)
await db.query('UPDATE public.store_locations SET tax_rate_2=.07 WHERE id=$1',[reviewedLocationId])
await rpc('tax_review',registered.id,{location_id:reviewedLocationId,rate:.05,label:'GST',reason:'Reviewed first jurisdiction'})
registeredDetail = await rpc('details',registered.id)
assert.equal(registeredDetail.organization.tax_reviewed_at,null); passed++
assert.equal(Number(registeredDetail.locations.find(l => l.id === reviewedLocationId).tax_rate_2),.07); passed++
await rpc('tax_review',registered.id,{location_id:registeredDetail.locations.find(l => l.id !== reviewedLocationId).id,rate:.1,label:'Test tax',reason:'Reviewed second jurisdiction'})
assert.ok((await rpc('details',registered.id)).organization.tax_reviewed_at); passed++
await rpc('configure',registered.id,{...data,legal_name:'Registered Retailer',owner_email:'other@example.com',gst_hst_status:'registered',gst_hst_account_number:'123456789RT0001'})
assert.ok((await rpc('details',registered.id)).locations.every(l => l.nordvik_tax_reviewed_at === null)); passed++
const submitApplication = async payload => (await db.query('SELECT public.submit_store_application($1::jsonb) result',[JSON.stringify(payload)])).rows[0].result
const reviewApplication = async (id,decision,note) => (await db.query('SELECT public.nordvik_review_store_application($1,$2,$3) result',[id,decision,note])).rows[0].result
const applicationData = {...data,registration_jurisdiction:'Nova Scotia',phone:'9025550100',country:'Canada',subscription_plan:'store_pro',status:'active',approved_by:ids.owner}
const countBeforeSubmission = (await rpc('list')).length
await actor('owner')
await denied('applicant cannot request a Store tier directly', () => db.query("UPDATE public.profiles SET subscription_tier='store_pro' WHERE id=$1",[ids.owner]), /require NORDVIK approval/)
await denied('incomplete application rejected server-side', () => submitApplication({legal_name:'Incomplete'}), /Complete business/)
await denied('application cannot reference another user document', () => submitApplication({...applicationData,proof_of_address_path:ids.other+'/proof.pdf'}), /belong to the applicant/)
const application = await submitApplication(applicationData)
assert.equal(application.status,'pending'); passed++
await denied('duplicate pending application rejected', () => submitApplication(applicationData), /already have an application pending/)
await denied('applicant cannot approve application through review API', () => reviewApplication(application.id,'approved','Self approve'), /administrator required/)
await denied('applicant cannot update application row', () => db.query("UPDATE public.organization_applications SET status='approved' WHERE id=$1",[application.id]), /permission denied|Only NORDVIK/)
await denied('applicant cannot create fake reviewed application', () => db.query("INSERT INTO public.organization_applications(applicant_user_id,name,status) VALUES($1,'Forged','approved')",[ids.owner]), /permission denied|own pending/)
await actor('other')
assert.equal((await db.query('SELECT * FROM public.organization_applications WHERE id=$1',[application.id])).rows.length,0); passed++
await denied('retailer cannot read administrative application queue', () => db.query('SELECT public.nordvik_store_applications()'), /administrator required/)
await actor('admin')
assert.equal((await rpc('list')).length,countBeforeSubmission); passed++
const queued = (await db.query('SELECT public.nordvik_store_applications() result')).rows[0].result.find(a => a.id===application.id)
assert.equal(queued.business_details.subscription_plan,'store'); passed++
assert.equal(queued.business_details.status,undefined); passed++
await denied('application approval requires administrative note', () => reviewApplication(application.id,'approved',''), /review note/)
const approvedApplication = await reviewApplication(application.id,'approved','Business registration reviewed')
const provisioned = await rpc('details',approvedApplication.organization_id)
assert.equal(provisioned.organization.onboarding_status,'approved'); passed++
assert.equal(provisioned.organization.owner_linked,false); passed++
assert.equal(provisioned.organization.tax_reviewed_at,null); passed++
assert.equal(provisioned.stores[0].status,'setup'); passed++
await denied('application approval does not activate retailer access', () => rpc('status',provisioned.organization.id,{status:'active',reason:'Skip remaining review'}), /Activation requires/)
await denied('reviewed application cannot create duplicate organisations', () => reviewApplication(application.id,'approved','Again'), /already reviewed/)
await denied('legacy approval endpoint cannot bypass central review', () => db.query('SELECT public.approve_organization_application($1)',[application.id]), /Store Management|permission denied/)
await actor('other')
const rejected = await submitApplication({...applicationData,owner_email:'other@example.com'})
await actor('admin')
await reviewApplication(rejected.id,'rejected','Please supply complete registration evidence')
await actor('other')
assert.equal((await db.query('SELECT public.my_store_application() result')).rows[0].result.review_notes,'Please supply complete registration evidence'); passed++
await actor('','anon')
await denied('anonymous application submissions rejected', () => submitApplication(applicationData), /permission denied/)
await denied('anonymous admin API blocked', () => rpc('list'), /permission denied/)

// The pre-existing internal test organisation is a targeted maintenance repair,
// not a general bypass of retailer onboarding or a fabricated tax review.
await actor('admin')
const internalTest = await rpc('create',null,{...data,legal_name:'Nordvik'})
await db.query("UPDATE public.organizations SET org_code='ORG-0001' WHERE id=$1",[internalTest.id])
await db.query("UPDATE public.stores SET is_test_store=true,status='active' WHERE organization_id=$1",[internalTest.id])
const mixedStore = (await db.query("INSERT INTO public.stores(store_name,owner_user_id,organization_id,status) VALUES('Mixed production site',$1,$2,'active') RETURNING id",[ids.admin,internalTest.id])).rows[0].id
const repairSql = await readFile(new URL('../supabase/restore_nordvik_test_organization.sql',import.meta.url),'utf8')
const repair = async () => {
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.role','',false)")
  await db.exec(repairSql)
  await actor('admin')
}
await repair()
assert.equal((await rpc('details',internalTest.id)).organization.onboarding_status,'draft'); passed++
await db.query('UPDATE public.stores SET is_test_store=true WHERE id=$1',[mixedStore])
await repair()
const repaired = await rpc('details',internalTest.id)
assert.equal(repaired.organization.onboarding_status,'active'); passed++
assert.equal(repaired.organization.approved_at,null); passed++
assert.equal(repaired.organization.tax_reviewed_at,null); passed++
assert.equal(repaired.audit.filter(a=>a.action==='existing_test_organization_restored').length,1); passed++
assert.ok((await db.query('SELECT public.nordvik_test_organization_ids() result')).rows[0].result.includes(internalTest.id)); passed++
await repair()
assert.equal((await rpc('details',internalTest.id)).audit.filter(a=>a.action==='existing_test_organization_restored').length,1); passed++
assert.equal((await rpc('details',registered.id)).organization.onboarding_status,'draft'); passed++
await rpc('status',internalTest.id,{status:'suspended',reason:'Deliberate test suspension'})
await repair()
assert.equal((await rpc('details',internalTest.id)).organization.onboarding_status,'suspended'); passed++
assert.equal(Number((await db.query('SELECT quantity FROM public.store_inventory WHERE store_id=$1',[storeId])).rows[0].quantity),7); passed++
const standalone = (await db.query("INSERT INTO public.stores(store_name,owner_user_id,status) VALUES('Retailer site',$1,'active') RETURNING id",[ids.owner])).rows[0].id
await actor('owner')
await denied('retailer cannot self-assign test designation',()=>db.query('UPDATE public.stores SET is_test_store=true WHERE id=$1',[standalone]),/Only NORDVIK/)
await denied('test metadata API requires a NORDVIK administrator',()=>db.query('SELECT public.nordvik_test_organization_ids()'),/administrator required/)
console.log(`${passed} store management assertions passed.`)
await db.close()
