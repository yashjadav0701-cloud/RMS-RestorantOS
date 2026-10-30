# Operator-only restaurant account provisioning

The master migration changes the `auth.users` trigger so a newly created Auth user must have a matching, unexpired row in `public.restaurant_provisioning_allowlist`. This prevents public self-registration from automatically provisioning restaurant tenants. Existing accounts and restaurant data are not changed by this gate.

## Create a new restaurant account

1. In Supabase SQL Editor, authorize the intended owner email for a short window. Replace the email literal with the exact email you intend to create; do not run the sample value as-is.

```sql
INSERT INTO public.restaurant_provisioning_allowlist (email, expires_at)
VALUES (lower('REPLACE_WITH_OWNER_EMAIL'), now() + interval '30 minutes')
ON CONFLICT (email) DO UPDATE
SET created_at = now(), expires_at = EXCLUDED.expires_at;
```

2. Before the 30-minute window expires, create the user through the authorized Supabase Auth Dashboard or trusted backend. The trigger consumes the allowlist row and creates the profile and restaurant workspace using the existing provisioning logic.
3. Verify the new restaurant and its seeded settings/cuisines before sharing credentials. If the email is mistyped or the window expires, repeat step 1 with the correct email.
4. Sign in as the new owner, open the Admin panel using the existing Admin PIN flow, and configure Captain, KOT, Cashier and Manager PINs in the PIN manager. No default PINs are created or exposed.

The allowlist is intentionally not readable or writable by `anon` or `authenticated`. Do not grant those roles access to it.
