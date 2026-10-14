# Ask Lightspeed sign-in: deploy notes

Sign-in uses the STFD Supabase Auth project (`qdfwovnhlaaocgawukto`), the same accounts as the STFD apps.

## Set these in Netlify BEFORE merging (Site settings > Environment variables)
| Name | Value |
|---|---|
| `STFD_SUPABASE_URL` | `https://qdfwovnhlaaocgawukto.supabase.co` |
| `STFD_SUPABASE_ANON_KEY` | STFD publishable key (`sb_publishable_PPhY…`, Supabase > STFD > Settings > API Keys) |
| `ASK_ALLOWED_EMAILS` | Comma-separated rollout list, e.g. `taylor@southtexasfad.com,phillip@southtexasfad.com,yvonne@southtexasfad.com,sarah.lasater@gmail.com` |

Leave `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (STFS data) as they are. Those are not the STFD Auth keys. `hq-redeem` does not read them.

## Johns Enterprises HQ handoff

Set these before HQ links will sign anyone in. A missing value makes redeem return 401 and leaves the password form in place.

| Name | Value |
|---|---|
| `HQ_STFD_HANDOFF_SECRET` | Shared secret with PJCJ `hq-handoff-consume`. Sent only as the `x-handoff-secret` header. |
| `PJCJ_ANON_KEY` | PJCJ publishable key (project `inmodrxuivjmypzvygzi`). Sent only as `apikey` on the consume call. |
| `STFD_SUPABASE_SERVICE_ROLE_KEY` | Service-role key for STFD Auth (`qdfwovnhlaaocgawukto`). Server only. Never the STFS data key. |
| `HQ_CONSUME_URL` | Optional. Defaults to `https://inmodrxuivjmypzvygzi.supabase.co/functions/v1/hq-handoff-consume`. |

`STFD_SUPABASE_URL` and `STFD_SUPABASE_ANON_KEY` above are also required. The page posts `{code}` to `/.netlify/functions/hq-redeem`. That function posts `{code, business: "STFS"}` to PJCJ and accepts only `app_key` `stfs_ask`. It mints a session for an email that already exists in STFD Auth. It does not create users or send mail.

A minted session does not skip Ask access. `app_metadata.apps` must still contain `"asklightspeed"`, or the email must still be in `ASK_ALLOWED_EMAILS`.

PJCJ has to accept that consume body. `hq-handoff-consume` must allow `business` `STFS` and return `app_key` `stfs_ask`. The function deployed today allows `STFD` only, and `hq_handoff_codes` only allows `PJCJ` and `STFD`. HQ links work once that side allows STFS.

## Who gets in
`app_metadata.apps` contains `"asklightspeed"` (one entry in an array, or that exact string), **or** the email is in `ASK_ALLOWED_EMAILS`.
Everyone else gets 403. No token or a bad token gets 401. Once every user has the `apps` flag, `ASK_ALLOWED_EMAILS` can be emptied.

## Zero downtime
If `STFD_SUPABASE_URL` or `STFD_SUPABASE_ANON_KEY` is missing when this deploys, every question returns 503, including a POST with no token. Set them first, then merge. A trailing slash on the URL is fine. If STFD Auth itself is unreachable, questions also return 503 rather than a false 401.
Password sign-in stays available. HQ links only work for an email that already has an STFD Auth account. Everyone else uses that password (the same one as the STFD apps).
