# Ask Lightspeed sign-in: deploy notes

Sign-in uses the STFD Supabase Auth project (`qdfwovnhlaaocgawukto`), the same accounts as the STFD apps.

## Set these in Netlify BEFORE merging (Site settings > Environment variables)
| Name | Value |
|---|---|
| `STFD_SUPABASE_URL` | `https://qdfwovnhlaaocgawukto.supabase.co` |
| `STFD_SUPABASE_ANON_KEY` | STFD publishable key (`sb_publishable_PPhY…`, Supabase > STFD > Settings > API Keys) |
| `ASK_ALLOWED_EMAILS` | Comma-separated rollout list, e.g. `taylor@southtexasfad.com,phillip@southtexasfad.com,yvonne@southtexasfad.com,sarah.lasater@gmail.com` |

Leave `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (STFS data) as they are.

## Who gets in
`app_metadata.apps` contains `"asklightspeed"`, **or** the email is in `ASK_ALLOWED_EMAILS`.
Everyone else gets 403. No token or a bad token gets 401. Once every user has the `apps` flag, `ASK_ALLOWED_EMAILS` can be emptied.

## Zero downtime
If the env vars are missing when this deploys, every question returns 503. Set them first, then merge.
Signed-in users must already have a password in STFD Auth (same one they use for the STFD apps).
