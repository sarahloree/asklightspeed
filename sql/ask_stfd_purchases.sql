-- Ask Lightspeed: STFD purchases, with an optional date range and lines.
--
-- Apply on the STFS project (zhgfzpztvmazueuxkipm) BEFORE the matching
-- Netlify deploy is useful. Read-only. Does not insert or update data.
-- Run as the owner of the other ask_* functions (postgres on STFS).
--
-- Replaces ask_stfd_purchases(integer). The old signature is dropped so
-- PostgREST does not see two overloads. A call that sends only p_months
-- still works: extra arguments default, and the JSON keys stay
-- period_months, sales_ex_tax, at_cost, margin, margin_pct, top_items.
--
-- p_from / p_to are inclusive calendar dates in America/Chicago and
-- override p_months. p_sku limits the rollup to a SKU or name fragment
-- and includes lines. p_detail includes lines without a SKU filter.
-- Returns are excluded, same as the previous function.
--
-- top_items is grouped by SKU. The previous body summed the outer line
-- alias inside the top-items subquery, so every row repeated the period
-- total. This file corrects that. The keys of each top item are unchanged
-- (sku, name, units, sales). name prefers the variant name when present
-- so two treated-pine SKUs do not collapse to one label.
--
-- Lockdown matches the live ask_* ACLs: execute for service_role only.

drop function if exists public.ask_stfd_purchases(integer);

create or replace function public.ask_stfd_purchases(
  p_months integer default 1,
  p_from date default null,
  p_to date default null,
  p_sku text default null,
  p_detail boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_months integer := coalesce(p_months, 1);
  v_label text := nullif(left(btrim(coalesce(p_sku, '')), 80), '');
  v_sku text;
  v_from_date date;
  v_to_date date;
  v_from timestamptz;
  v_to timestamptz;
  v_custom boolean;
  v jsonb;
begin
  if v_months < 1 then
    v_months := 1;
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    v_from_date := p_to;
    v_to_date := p_from;
  else
    v_from_date := p_from;
    v_to_date := p_to;
  end if;

  v_custom := v_from_date is not null or v_to_date is not null;
  if v_custom then
    v_from := case
      when v_from_date is null then null
      else (v_from_date::timestamp at time zone 'America/Chicago')
    end;
    v_to := case
      when v_to_date is null then null
      else ((v_to_date + 1)::timestamp at time zone 'America/Chicago')
    end;
  else
    v_from := now() - make_interval(months => v_months);
    v_to := null;
  end if;

  v_sku := v_label;
  if v_sku is not null then
    v_sku := replace(replace(replace(v_sku, '\', '\\'), '%', '\%'), '_', '\_');
  end if;

  with filtered as (
    select
      (s.sale_date at time zone 'America/Chicago')::date as sale_day,
      s.invoice_number,
      s.job_ref,
      p.sku,
      left(coalesce(nullif(p.variant_name, ''), p.name), 120) as name,
      sl.quantity,
      sl.line_total,
      sl.cost_total
    from ls_sale_lines sl
    join ls_sales s on s.sale_id = sl.sale_id
    join customer_entity_map m on m.customer_id = s.customer_id
    left join ls_products p on p.product_id = sl.product_id
    where m.entity = 'STFD'
      and s.state = 'closed'
      and s.deleted_at is null
      and coalesce(sl.is_return, false) = false
      and (v_from is null or s.sale_date >= v_from)
      and (v_to is null or s.sale_date < v_to)
      and (
        v_sku is null
        or coalesce(p.sku, '') ilike v_sku escape '\'
        or coalesce(p.sku, '') ilike '%' || v_sku || '%' escape '\'
        or coalesce(p.name, '') ilike '%' || v_sku || '%' escape '\'
        or coalesce(p.variant_name, '') ilike '%' || v_sku || '%' escape '\'
      )
  ),
  rolled as (
    select
      round(sum(line_total)) as sales_ex_tax,
      round(sum(cost_total)) as at_cost,
      round(sum(line_total - cost_total)) as margin,
      round(100 * sum(line_total - cost_total) / nullif(sum(line_total), 0), 1) as margin_pct,
      (
        select jsonb_agg(row_to_json(t))
        from (
          select
            f.sku,
            f.name,
            round(sum(f.quantity)) as units,
            round(sum(f.line_total)) as sales
          from filtered f
          group by f.sku, f.name
          order by sum(f.line_total) desc nulls last, f.sku
          limit 10
        ) t
      ) as top_items
    from filtered
  ),
  lined as (
    select
      (select count(*) from filtered) as line_count,
      (
        select jsonb_agg(
          jsonb_build_object(
            'sale_date', d.sale_day,
            'invoice_number', d.invoice_number,
            'sku', d.sku,
            'name', d.name,
            'quantity', round(d.quantity, 2),
            'sales_ex_tax', round(d.line_total, 2),
            'at_cost', round(d.cost_total, 2),
            'job_ref', d.job_ref
          )
          order by d.sale_day desc nulls last, d.line_total desc nulls last, d.sku
        )
        from (
          select *
          from filtered
          order by sale_day desc nulls last, line_total desc nulls last, sku
          limit 60
        ) d
      ) as lines
  )
  select
    jsonb_build_object(
      'sales_ex_tax', r.sales_ex_tax,
      'at_cost', r.at_cost,
      'margin', r.margin,
      'margin_pct', r.margin_pct,
      'top_items', r.top_items
    )
    || case
      when v_custom then jsonb_build_object('from', v_from_date, 'to', v_to_date)
      else jsonb_build_object('period_months', v_months)
    end
    || case
      when v_label is not null then jsonb_build_object('sku', v_label)
      else '{}'::jsonb
    end
    || case
      when coalesce(p_detail, false) or v_label is not null then jsonb_build_object(
        'lines', coalesce(l.lines, '[]'::jsonb),
        'lines_truncated', coalesce(l.line_count, 0) > 60
      )
      else '{}'::jsonb
    end
    || case
      when v_label is not null and r.sales_ex_tax is null then jsonb_build_object(
        'note', 'No STFD purchases matched that product in this window.'
      )
      else '{}'::jsonb
    end
  into v
  from rolled r
  cross join lined l;

  return coalesce(v, '{}'::jsonb);
end;
$function$;

comment on function public.ask_stfd_purchases(integer, date, date, text, boolean) is
  'Read-only Ask tool. STFD purchases: period rollup by default, optional Chicago dates, SKU filter, and sale lines.';

revoke all on function public.ask_stfd_purchases(integer, date, date, text, boolean) from public;
revoke all on function public.ask_stfd_purchases(integer, date, date, text, boolean) from anon;
revoke all on function public.ask_stfd_purchases(integer, date, date, text, boolean) from authenticated;
grant execute on function public.ask_stfd_purchases(integer, date, date, text, boolean) to service_role;
