-- Ask Lightspeed: past quote -> draft pick list.
--
-- Apply on the STFS project (zhgfzpztvmazueuxkipm) BEFORE the matching
-- Netlify deploy is useful. Read-only. Does not write data, does not call
-- Invoice2go, and does not add a table. Run as the owner of the other
-- ask_* functions (postgres on STFS).
--
-- Taylor asks for materials from a similar past Lightspeed quote. This
-- returns SKUs and quantities as a draft, with on-hand and shortfall from
-- ls_inventory. Optional scale_from / scale_to (both required) rescale
-- every quantity, for example 150 ft down to 100 ft.
--
-- The Lightspeed quote is a template only. The quantity a new job needs
-- still commits on the STFD calculator and job packet. This function does
-- not treat the quote as the official pull list.
--
-- Quote choice: the job number is normalized the same way as
-- ask_by_job_ref (2309, #2309, C2219, S2287). An optional p_quote matches
-- a short code or quote id on that job. Otherwise the latest quote with
-- status CREATED is used, then the latest quote that is not void.
-- Void means deleted_at is set, or status VOID, VOIDED, CANCELLED, or
-- CANCELED. The mirror's live statuses are CREATED, CONVERTED, ARCHIVED.
--
-- Lockdown matches the live ask_* ACLs ({postgres, service_role} execute).
-- anon and authenticated are revoked. Ask calls this with the service role.

create or replace function public.ask_past_quote_template(
  p_job_ref text,
  p_quote text default null,
  p_scale_from numeric default null,
  p_scale_to numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_raw text := upper(coalesce(p_job_ref, ''));
  v_ref text;
  v_type text;
  v_quote_key text;
  v_chosen ls_quotes%rowtype;
  v_factor numeric := 1;
  v_scale boolean := false;
  v_lines jsonb := '[]'::jsonb;
  v_line_n integer := 0;
  v_note text := 'Draft only. This Lightspeed quote is a template, not the official pull list. The quantity a new job needs still commits on the STFD calculator and job packet.';
  v_customer text;
  v_picked text;
  v_other jsonb := '[]'::jsonb;
  v_quotes jsonb := '[]'::jsonb;
  v_void boolean := false;
  v_bad boolean := false;
  v jsonb;
begin
  -- Same priority as ask_by_job_ref / ls_parse_job_ref: hashed C/S, hashed
  -- bare, then a C/S token anywhere. A bare number counts only when it is
  -- the value itself (or after a short job/quote label), so "Option #1"
  -- is not a job.
  v_ref := (regexp_match(v_raw, '#\s*([CS][0-9]{1,4})([^0-9]|$)'))[1];
  if v_ref is null then
    v_ref := (regexp_match(v_raw, '#\s*([0-9]{3,4})([^0-9]|$)'))[1];
  end if;
  if v_ref is null then
    v_ref := (regexp_match(v_raw, '(?:^|[^A-Z0-9])([CS][0-9]{1,4})([^0-9]|$)'))[1];
  end if;
  if v_ref is null then
    v_ref := (regexp_match(
      regexp_replace(btrim(v_raw), '^(JOB|QUOTE|INVOICE|NUMBER|NO|REF)\s+#?\s*', ''),
      '^([0-9]{3,4})([^0-9]|$)'
    ))[1];
  end if;

  v_quote_key := upper(btrim(coalesce(p_quote, '')));
  if v_quote_key <> '' then
    v_quote_key := regexp_replace(v_quote_key, '^(QUOTE|NUMBER|NO|REF|#)\s*', '');
    v_quote_key := regexp_replace(v_quote_key, '^#\s*', '');
  end if;
  v_quote_key := nullif(btrim(v_quote_key), '');

  if v_ref is null then
    return jsonb_build_object(
      'draft', true,
      'official_pull', false,
      'job_ref', null,
      'lines', '[]'::jsonb,
      'scale_applied', false,
      'note', 'No job number found. Use a number like 2309, C2219, or S2287. ' || v_note
    );
  end if;

  v_type := case left(v_ref, 1)
    when 'C' then 'commercial'
    when 'S' then 'subcontractor'
    else 'residential'
  end;

  if p_scale_from is not null and p_scale_to is not null
     and p_scale_from > 0 and p_scale_to > 0 then
    v_scale := true;
    v_factor := p_scale_to / p_scale_from;
  elsif p_scale_from is not null or p_scale_to is not null then
    if p_scale_from is null or p_scale_to is null then
      v_note := v_note || ' Scale was not applied. Pass both the past size and the new size.';
    else
      v_note := v_note || ' Scale was not applied. The past size and the new size both need to be greater than zero.';
    end if;
  end if;

  select q.*
  into v_chosen
  from ls_quotes q
  where (
      q.job_ref = v_ref
      or exists (
        select 1
        from ls_quote_lines ql
        where ql.quote_id = q.quote_id
          and ql.job_ref = v_ref
      )
    )
    and (
      v_quote_key is null
      or upper(btrim(coalesce(q.short_code, ''))) = v_quote_key
      or upper(btrim(q.quote_id)) = v_quote_key
    )
  order by
    case
      when v_quote_key is not null
        and q.deleted_at is null
        and upper(btrim(coalesce(q.status, ''))) not in ('VOID', 'VOIDED', 'CANCELLED', 'CANCELED')
        then 0
      when v_quote_key is not null then 1
      when q.deleted_at is null and upper(btrim(coalesce(q.status, ''))) = 'CREATED' then 0
      when q.deleted_at is null
        and upper(btrim(coalesce(q.status, ''))) not in ('VOID', 'VOIDED', 'CANCELLED', 'CANCELED')
        then 1
      else 2
    end,
    q.ls_created_at desc nulls last,
    q.short_code desc nulls last
  limit 1;

  if not found then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'quote', x.quote,
        'status', x.status
      )
      order by x.ls_created_at desc nulls last
    ), '[]'::jsonb)
    into v_quotes
    from (
      select
        coalesce(nullif(btrim(q.short_code), ''), q.quote_id) as quote,
        q.status,
        q.ls_created_at
      from ls_quotes q
      where q.deleted_at is null
        and upper(btrim(coalesce(q.status, ''))) not in ('VOID', 'VOIDED', 'CANCELLED', 'CANCELED')
        and (
          q.job_ref = v_ref
          or exists (
            select 1
            from ls_quote_lines ql
            where ql.quote_id = q.quote_id
              and ql.job_ref = v_ref
          )
        )
      order by q.ls_created_at desc nulls last
      limit 8
    ) x;

    if v_quote_key is not null then
      v_note := 'No quote with that short code or id is tagged with this job. ' || v_note;
    elsif jsonb_array_length(coalesce(v_quotes, '[]'::jsonb)) = 0 then
      v_note := 'No Lightspeed quote is tagged with this job number. ' || v_note;
    else
      v_note := 'No usable Lightspeed quote is tagged with this job number. ' || v_note;
    end if;

    return jsonb_build_object(
      'draft', true,
      'official_pull', false,
      'job_ref', v_ref,
      'job_ref_type', v_type,
      'lines', '[]'::jsonb,
      'quotes', coalesce(v_quotes, '[]'::jsonb),
      'scale_applied', false,
      'note', v_note
    );
  end if;

  v_void := v_chosen.deleted_at is not null
    or upper(btrim(coalesce(v_chosen.status, ''))) in ('VOID', 'VOIDED', 'CANCELLED', 'CANCELED');

  if v_void then
    return jsonb_build_object(
      'draft', true,
      'official_pull', false,
      'job_ref', v_ref,
      'job_ref_type', v_type,
      'quote', coalesce(nullif(btrim(v_chosen.short_code), ''), v_chosen.quote_id),
      'quote_status', v_chosen.status,
      'lines', '[]'::jsonb,
      'scale_applied', false,
      'note', 'That quote is void, so it was not used as a draft. ' || v_note
    );
  end if;

  if v_quote_key is not null then
    v_picked := 'named';
  elsif upper(btrim(coalesce(v_chosen.status, ''))) = 'CREATED' then
    v_picked := 'created';
  else
    v_picked := 'latest_non_void';
  end if;

  with grouped as (
    select
      ql.product_id,
      case when ql.product_id is null then ql.quote_line_id else null end as solo_line,
      min(ql.sequence) as sequence,
      coalesce(sum(ql.quantity), 0) as qty_raw,
      max(nullif(btrim(ql.note), '')) as line_note
    from ls_quote_lines ql
    where ql.quote_id = v_chosen.quote_id
    group by ql.product_id,
             case when ql.product_id is null then ql.quote_line_id else null end
  ),
  shaped as (
    select
      p.sku,
      left(coalesce(nullif(p.variant_name, ''), p.name, g.line_note, '(no product)'), 120) as name,
      g.sequence,
      round(g.qty_raw, 2) as qty_template,
      round(g.qty_raw * v_factor, 2) as qty_scaled,
      (
        select round(sum(i.inventory_level), 2)
        from ls_inventory i
        where i.product_id = g.product_id
          and i.deleted_at is null
      ) as on_hand
    from grouped g
    left join ls_products p on p.product_id = g.product_id
  ),
  ranked as (
    select
      s.*,
      round(greatest(s.qty_scaled - coalesce(s.on_hand, 0), 0), 2) as shortfall,
      row_number() over (order by s.sequence nulls last, s.sku nulls last, s.name) as rn,
      count(*) over () as n
    from shaped s
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'sku', r.sku,
        'name', r.name,
        'qty_template', r.qty_template,
        'qty_scaled', r.qty_scaled,
        'on_hand', r.on_hand,
        'shortfall', r.shortfall
      )
      || case
        when r.on_hand < 0 then jsonb_build_object(
          'caveat', 'count unreliable: sold without a recorded receipt'
        )
        else '{}'::jsonb
      end
      order by r.rn
    ), '[]'::jsonb),
    coalesce(max(r.n), 0)
  into v_lines, v_line_n
  from ranked r
  where r.rn <= 80;

  v_lines := coalesce(v_lines, '[]'::jsonb);
  v_line_n := coalesce(v_line_n, 0);

  select coalesce(
    nullif(btrim(c.company_name), ''),
    nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')
  )
  into v_customer
  from ls_customers c
  where c.customer_id = v_chosen.customer_id;

  select coalesce(jsonb_agg(x.quote order by x.ls_created_at desc nulls last), '[]'::jsonb)
  into v_other
  from (
    select
      coalesce(nullif(btrim(q.short_code), ''), q.quote_id) as quote,
      q.ls_created_at
    from ls_quotes q
    where q.deleted_at is null
      and upper(btrim(coalesce(q.status, ''))) = 'CREATED'
      and q.quote_id is distinct from v_chosen.quote_id
      and (
        q.job_ref = v_ref
        or exists (
          select 1
          from ls_quote_lines ql
          where ql.quote_id = q.quote_id
            and ql.job_ref = v_ref
        )
      )
    order by q.ls_created_at desc nulls last
    limit 8
  ) x;

  v_other := coalesce(v_other, '[]'::jsonb);

  if v_picked = 'latest_non_void' then
    v_note := v_note || ' No open quote (status CREATED). This draft uses the latest quote that is not void.';
  end if;

  if v_picked <> 'named' and jsonb_array_length(v_other) > 0 then
    v_note := v_note || ' Other open quotes on this job: '
      || (select string_agg(value, ', ') from jsonb_array_elements_text(v_other))
      || '. Pass a short code to use one of those instead.';
  end if;

  if v_chosen.expired_at is not null and v_chosen.expired_at <= now() then
    v_note := v_note || ' That quote is past its expiration date.';
  end if;

  if v_scale then
    v_note := v_note || format(
      ' Quantities are scaled from %s to %s.',
      p_scale_from,
      p_scale_to
    );
  end if;

  select exists (
    select 1
    from jsonb_array_elements(v_lines) e
    where e ? 'on_hand'
      and e->>'on_hand' is not null
      and (e->>'on_hand')::numeric < 0
  )
  into v_bad;

  if v_bad then
    v_note := v_note || ' One or more on-hand counts are negative, so those counts cannot be trusted.';
  end if;

  if v_line_n > 80 then
    v_note := v_note || format(' Showing 80 of %s lines.', v_line_n);
  end if;

  v := jsonb_build_object(
    'draft', true,
    'official_pull', false,
    'job_ref', v_ref,
    'job_ref_type', v_type,
    'quote', coalesce(nullif(btrim(v_chosen.short_code), ''), v_chosen.quote_id),
    'quote_status', v_chosen.status,
    'created_on', (v_chosen.ls_created_at at time zone 'America/Chicago')::date,
    'expired', (v_chosen.expired_at is not null and v_chosen.expired_at <= now()),
    'picked', v_picked,
    'scale_applied', v_scale,
    'line_count', v_line_n,
    'lines', v_lines,
    'note', v_note
  );

  if v_customer is not null then
    v := v || jsonb_build_object('customer', v_customer);
  end if;
  if v_scale then
    v := v || jsonb_build_object(
      'scale_from', p_scale_from,
      'scale_to', p_scale_to,
      'scale_factor', round(v_factor, 6)
    );
  elsif p_scale_from is not null or p_scale_to is not null then
    v := v || jsonb_strip_nulls(jsonb_build_object(
      'scale_from', p_scale_from,
      'scale_to', p_scale_to
    ));
  end if;
  if jsonb_array_length(v_other) > 0 then
    v := v || jsonb_build_object('other_open_quotes', v_other);
  end if;
  if v_line_n > 80 then
    v := v || jsonb_build_object('lines_omitted', v_line_n - 80);
  end if;

  return v;
end;
$function$;

comment on function public.ask_past_quote_template(text, text, numeric, numeric) is
  'Read-only Ask tool. Draft pick list from a past Lightspeed quote (template only; STFD calculator/job packet owns the real pull).';

revoke all on function public.ask_past_quote_template(text, text, numeric, numeric) from public;
revoke all on function public.ask_past_quote_template(text, text, numeric, numeric) from anon;
revoke all on function public.ask_past_quote_template(text, text, numeric, numeric) from authenticated;
grant execute on function public.ask_past_quote_template(text, text, numeric, numeric) to service_role;
