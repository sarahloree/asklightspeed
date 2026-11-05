-- Ask Lightspeed: one job number -> what sold and what is still quoted.
--
-- Apply on the STFS project (zhgfzpztvmazueuxkipm) BEFORE the matching
-- Netlify deploy is useful. Read-only. Does not insert or update data.
-- Run as the owner of the other ask_* functions (postgres on STFS).
--
-- Job numbers are the Invoice2go-style refs already parsed from the
-- Lightspeed note into job_ref. This does not call Invoice2go.
-- Input is normalized the same way as ls_parse_job_ref: upper-case,
-- optional leading #, C/S prefix kept (2309, C2219, S2287, C108).
--
-- Lockdown matches the live ask_* ACLs ({postgres, service_role} execute).
-- anon and authenticated are revoked. These functions are SECURITY DEFINER
-- and read the sales mirror; Ask calls them only with the service role.

create or replace function public.ask_by_job_ref(p_job_ref text)
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
  v_sales jsonb;
  v_open jsonb;
  v_closed jsonb;
  v_sales_n integer;
  v_open_n integer;
  v_closed_n integer;
  v_voided integer;
  v jsonb;
begin
  -- Same priority as ls_parse_job_ref: hashed C/S, hashed bare, then a
  -- C/S token anywhere. A bare number counts only when it is the value
  -- itself (or after a short "job"/"quote" label), so a year buried in a
  -- sentence is not treated as a residential job.
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

  if v_ref is null then
    return jsonb_build_object(
      'job_ref', null,
      'sales', '[]'::jsonb,
      'open_quotes', '[]'::jsonb,
      'closed_quotes', '[]'::jsonb,
      'note', 'No job number found. Use a number like 2309, C2219, or S2287.'
    );
  end if;

  v_type := case left(v_ref, 1)
    when 'C' then 'commercial'
    when 'S' then 'subcontractor'
    else 'residential'
  end;

  -- Sales tagged with the ref, plus sales converted from a quote that is.
  with sale_ids as (
    select s.sale_id
    from ls_sales s
    where s.deleted_at is null
      and s.state is distinct from 'voided'
      and s.job_ref = v_ref
    union
    select s.sale_id
    from ls_sale_lines sl
    join ls_sales s on s.sale_id = sl.sale_id
    where sl.job_ref = v_ref
      and s.deleted_at is null
      and s.state is distinct from 'voided'
    union
    select s.sale_id
    from ls_sales s
    join ls_quotes q on q.quote_id = s.source_quote_id
    where q.job_ref = v_ref
      and q.deleted_at is null
      and s.deleted_at is null
      and s.state is distinct from 'voided'
  ),
  ranked as (
    select
      s.sale_id,
      s.invoice_number,
      s.sale_date,
      s.state,
      s.note,
      s.total_price,
      s.total_tax,
      s.is_return,
      s.job_ref,
      s.job_ref_confidence,
      s.customer_id,
      row_number() over (order by s.sale_date desc nulls last, s.invoice_number) as rn,
      count(*) over () as n
    from sale_ids i
    join ls_sales s on s.sale_id = i.sale_id
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'invoice_number', r.invoice_number,
        'sale_date', (r.sale_date at time zone 'America/Chicago')::date,
        'state', r.state,
        'customer', coalesce(
          nullif(btrim(c.company_name), ''),
          nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')
        ),
        'total_ex_tax', round(r.total_price, 2),
        'total_tax', round(r.total_tax, 2),
        'is_return', coalesce(r.is_return, false),
        'job_ref_on_sale', r.job_ref,
        'job_ref_confidence', r.job_ref_confidence,
        'matched_via', case
          when r.job_ref = v_ref or exists (
            select 1 from ls_sale_lines slm
            where slm.sale_id = r.sale_id and slm.job_ref = v_ref
          ) then 'sale'
          else 'converted_quote'
        end,
        'note', nullif(left(regexp_replace(coalesce(r.note, ''), '\s+', ' ', 'g'), 160), ''),
        'line_count', lines.line_count,
        'sku_count', lines.sku_count,
        'skus_omitted', lines.skus_omitted,
        'by_sku', lines.by_sku
      )
      order by r.sale_date desc nulls last, r.invoice_number
    ), '[]'::jsonb),
    coalesce(max(r.n), 0)
  into v_sales, v_sales_n
  from ranked r
  left join ls_customers c on c.customer_id = r.customer_id
  cross join lateral (
    select
      count(*)::integer as line_count,
      count(distinct sl.product_id)::integer as sku_count,
      greatest(count(distinct sl.product_id) - 40, 0)::integer as skus_omitted,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'sku', g.sku,
            'name', g.name,
            'quantity', g.quantity,
            'line_total', g.line_total
          )
          order by g.line_total desc nulls last, g.sku
        )
        from (
          select
            max(p.sku) as sku,
            left(max(coalesce(nullif(p.variant_name, ''), p.name, '(no product)')), 120) as name,
            round(sum(sl2.quantity), 2) as quantity,
            round(sum(sl2.line_total), 2) as line_total
          from ls_sale_lines sl2
          left join ls_products p on p.product_id = sl2.product_id
          where sl2.sale_id = r.sale_id
          group by sl2.product_id
          order by sum(sl2.line_total) desc nulls last
          limit 40
        ) g
      ), '[]'::jsonb) as by_sku
    from ls_sale_lines sl
    where sl.sale_id = r.sale_id
  ) lines
  where r.rn <= 12;

  with quote_ids as (
    select q.quote_id
    from ls_quotes q
    where q.deleted_at is null
      and q.job_ref = v_ref
    union
    select q.quote_id
    from ls_quote_lines ql
    join ls_quotes q on q.quote_id = ql.quote_id
    where ql.job_ref = v_ref
      and q.deleted_at is null
  ),
  open_ranked as (
    select
      q.*,
      row_number() over (order by q.ls_created_at desc nulls last, q.short_code) as rn,
      count(*) over () as n
    from quote_ids i
    join ls_quotes q on q.quote_id = i.quote_id
    where upper(q.status) = 'CREATED'
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'quote', coalesce(nullif(btrim(r.short_code), ''), r.quote_id),
        'status', r.status,
        'created_on', (r.ls_created_at at time zone 'America/Chicago')::date,
        'expires_on', (r.expired_at at time zone 'America/Chicago')::date,
        'expired', (r.expired_at is not null and r.expired_at <= now()),
        'customer', coalesce(
          nullif(btrim(c.company_name), ''),
          nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')
        ),
        'total_ex_tax', round(r.total_price, 2),
        'total_tax', round(r.total_tax, 2),
        'job_ref_confidence', r.job_ref_confidence,
        'note', nullif(left(regexp_replace(coalesce(r.note, ''), '\s+', ' ', 'g'), 160), ''),
        'line_count', lines.line_count,
        'sku_count', lines.sku_count,
        'skus_omitted', lines.skus_omitted,
        'by_sku', lines.by_sku
      )
      order by r.ls_created_at desc nulls last
    ), '[]'::jsonb),
    coalesce(max(r.n), 0)
  into v_open, v_open_n
  from open_ranked r
  left join ls_customers c on c.customer_id = r.customer_id
  cross join lateral (
    select
      count(*)::integer as line_count,
      count(distinct ql.product_id)::integer as sku_count,
      greatest(count(distinct ql.product_id) - 40, 0)::integer as skus_omitted,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'sku', g.sku,
            'name', g.name,
            'quantity', g.quantity,
            'line_total', g.line_total
          )
          order by g.line_total desc nulls last, g.sku
        )
        from (
          select
            max(p.sku) as sku,
            left(max(coalesce(nullif(p.variant_name, ''), p.name, '(no product)')), 120) as name,
            round(sum(ql2.quantity), 2) as quantity,
            round(sum(ql2.quantity * ql2.price), 2) as line_total
          from ls_quote_lines ql2
          left join ls_products p on p.product_id = ql2.product_id
          where ql2.quote_id = r.quote_id
          group by ql2.product_id
          order by sum(ql2.quantity * ql2.price) desc nulls last
          limit 40
        ) g
      ), '[]'::jsonb) as by_sku
    from ls_quote_lines ql
    where ql.quote_id = r.quote_id
  ) lines
  where r.rn <= 8;

  with quote_ids as (
    select q.quote_id
    from ls_quotes q
    where q.deleted_at is null
      and q.job_ref = v_ref
    union
    select q.quote_id
    from ls_quote_lines ql
    join ls_quotes q on q.quote_id = ql.quote_id
    where ql.job_ref = v_ref
      and q.deleted_at is null
  ),
  closed_ranked as (
    select
      q.quote_id,
      q.short_code,
      q.status,
      q.ls_created_at,
      q.total_price,
      q.job_ref_confidence,
      q.customer_id,
      row_number() over (order by q.ls_created_at desc nulls last, q.short_code) as rn,
      count(*) over () as n
    from quote_ids i
    join ls_quotes q on q.quote_id = i.quote_id
    where upper(q.status) in ('CONVERTED', 'ARCHIVED')
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'quote', coalesce(nullif(btrim(r.short_code), ''), r.quote_id),
        'status', r.status,
        'created_on', (r.ls_created_at at time zone 'America/Chicago')::date,
        'customer', coalesce(
          nullif(btrim(c.company_name), ''),
          nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '')
        ),
        'total_ex_tax', round(r.total_price, 2),
        'job_ref_confidence', r.job_ref_confidence
      )
      order by r.ls_created_at desc nulls last
    ), '[]'::jsonb),
    coalesce(max(r.n), 0)
  into v_closed, v_closed_n
  from closed_ranked r
  left join ls_customers c on c.customer_id = r.customer_id
  where r.rn <= 8;

  select count(*)::integer into v_voided
  from ls_sales s
  where s.deleted_at is null
    and s.state = 'voided'
    and (
      s.job_ref = v_ref
      or exists (
        select 1 from ls_sale_lines sl
        where sl.sale_id = s.sale_id and sl.job_ref = v_ref
      )
      or exists (
        select 1 from ls_quotes q
        where q.quote_id = s.source_quote_id
          and q.job_ref = v_ref
          and q.deleted_at is null
      )
    );

  v := jsonb_build_object(
    'job_ref', v_ref,
    'job_ref_type', v_type,
    'sales', coalesce(v_sales, '[]'::jsonb),
    'open_quotes', coalesce(v_open, '[]'::jsonb),
    'closed_quotes', coalesce(v_closed, '[]'::jsonb)
  );

  if coalesce(v_sales_n, 0) > 12 then
    v := v || jsonb_build_object('sales_omitted', v_sales_n - 12);
  end if;
  if coalesce(v_open_n, 0) > 8 then
    v := v || jsonb_build_object('open_quotes_omitted', v_open_n - 8);
  end if;
  if coalesce(v_closed_n, 0) > 8 then
    v := v || jsonb_build_object('closed_quotes_omitted', v_closed_n - 8);
  end if;
  if coalesce(v_voided, 0) > 0 then
    v := v || jsonb_build_object('voided_sales', v_voided);
  end if;
  if coalesce(v_sales_n, 0) = 0
     and coalesce(v_open_n, 0) = 0
     and coalesce(v_closed_n, 0) = 0 then
    v := v || jsonb_build_object(
      'note', 'No sales or quotes are tagged with this job number.'
    );
  end if;

  return v;
end;
$function$;

comment on function public.ask_by_job_ref(text) is
  'Read-only Ask tool. Sales and quotes for one normalized job_ref (note / Invoice2go-style number).';

revoke all on function public.ask_by_job_ref(text) from public;
revoke all on function public.ask_by_job_ref(text) from anon;
revoke all on function public.ask_by_job_ref(text) from authenticated;
grant execute on function public.ask_by_job_ref(text) to service_role;
