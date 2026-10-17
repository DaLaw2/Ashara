-- One line per schema object of the public schema and one per table's rows, sorted, as a single
-- text value. Two databases with equal fingerprints have the same tables, columns, constraints,
-- indexes, triggers, functions, types, views, sequences, policies and comments, and the same rows.
-- A column whose default is drawn when a row is written (a random id, the current time) is left
-- out of the rows: no two databases agree on it. schema_migrations is the runner's own table: its
-- shape is fingerprinted, its rows are not.
WITH
  ns AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
  ext_member AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
  rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
     WHERE c.relnamespace = (SELECT oid FROM ns)
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
       AND c.oid NOT IN (SELECT objid FROM ext_member)
  ),
  col AS (
    SELECT r.oid AS relid, r.relname, r.relkind, a.attnum, a.attname,
           format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, a.attidentity, a.attgenerated,
           coalesce(co.collname, '-') AS collation_name,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM rel r
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation co ON co.oid = a.attcollation
  ),
  drawn AS (
    SELECT relid, array_agg(attname::text) AS names
      FROM col
     WHERE default_expr ~ '(gen_random_uuid|now|uuid_generate_v4|clock_timestamp)\(\)|CURRENT_TIMESTAMP'
     GROUP BY relid
  ),
  lines AS (
    SELECT format('extension %s schema=%s', e.extname, n.nspname) AS line
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    UNION ALL
    SELECT format('relation %s kind=%s persistence=%s rls=%s force_rls=%s',
                  relname, relkind, relpersistence, relrowsecurity, relforcerowsecurity)
      FROM rel
    UNION ALL
    SELECT format('column %s #%s %s type=%s not_null=%s default=%s identity=%s generated=%s collation=%s',
                  relname, row_number() OVER (PARTITION BY relid ORDER BY attnum), attname, type, attnotnull,
                  coalesce(default_expr, '-'), attidentity, attgenerated, collation_name)
      FROM col
    UNION ALL
    SELECT format('constraint %s %s %s', coalesce(c.conrelid::regclass::text, c.contypid::regtype::text),
                  c.conname, pg_get_constraintdef(c.oid))
      FROM pg_constraint c
     WHERE c.connamespace = (SELECT oid FROM ns) AND c.oid NOT IN (SELECT objid FROM ext_member)
    UNION ALL
    SELECT format('index %s', pg_get_indexdef(i.indexrelid))
      FROM pg_index i JOIN rel r ON r.oid = i.indrelid
    UNION ALL
    SELECT format('trigger %s enabled=%s', pg_get_triggerdef(t.oid), t.tgenabled)
      FROM pg_trigger t JOIN rel r ON r.oid = t.tgrelid
     WHERE NOT t.tgisinternal
    UNION ALL
    SELECT format('function %s', pg_get_functiondef(p.oid))
      FROM pg_proc p
     WHERE p.pronamespace = (SELECT oid FROM ns) AND p.prokind IN ('f', 'p')
       AND p.oid NOT IN (SELECT objid FROM ext_member)
    UNION ALL
    SELECT format('enum %s %s', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typnamespace = (SELECT oid FROM ns)
     GROUP BY t.typname
    UNION ALL
    SELECT format('domain %s base=%s not_null=%s default=%s', t.typname, format_type(t.typbasetype, t.typtypmod),
                  t.typnotnull, coalesce(t.typdefault, '-'))
      FROM pg_type t
     WHERE t.typnamespace = (SELECT oid FROM ns) AND t.typtype = 'd'
    UNION ALL
    SELECT format('view %s %s', relname, pg_get_viewdef(oid))
      FROM rel
     WHERE relkind IN ('v', 'm')
    UNION ALL
    SELECT format('sequence %s type=%s start=%s increment=%s min=%s max=%s cache=%s cycle=%s',
                  r.relname, format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, s.seqmax,
                  s.seqcache, s.seqcycle)
      FROM pg_sequence s JOIN rel r ON r.oid = s.seqrelid
    UNION ALL
    SELECT format('policy %s %s %s %s %s using=%s check=%s', pol.tablename, pol.policyname, pol.permissive,
                  pol.roles, pol.cmd, coalesce(pol.qual, '-'), coalesce(pol.with_check, '-'))
      FROM pg_policies pol
     WHERE pol.schemaname = 'public'
    UNION ALL
    SELECT format('rule %s %s', ru.tablename, ru.definition)
      FROM pg_rules ru
     WHERE ru.schemaname = 'public'
    UNION ALL
    SELECT format('comment %s %s %s', d.classoid::regclass, coalesce(r.relname, (SELECT p.proname FROM pg_proc p WHERE p.oid = d.objoid)), d.objsubid)
           || ' ' || d.description
      FROM pg_description d LEFT JOIN rel r ON r.oid = d.objoid AND d.classoid = 'pg_class'::regclass
     WHERE r.oid IS NOT NULL
        OR (d.classoid = 'pg_proc'::regclass
            AND d.objoid IN (SELECT oid FROM pg_proc WHERE pronamespace = (SELECT oid FROM ns))
            AND d.objoid NOT IN (SELECT objid FROM ext_member))
    UNION ALL
    SELECT format('rows %s %s', r.relname, (xpath('/row/rows/text()', query_to_xml(
             format('SELECT coalesce(jsonb_agg(x ORDER BY x::text), ''[]''::jsonb) AS rows
                       FROM (SELECT to_jsonb(t) - %L::text[] AS x FROM public.%I t) s',
                    coalesce(dr.names, '{}'::text[]), r.relname),
             false, true, '')))[1]::text)
      FROM rel r LEFT JOIN drawn dr ON dr.relid = r.oid
     WHERE r.relkind IN ('r', 'p') AND r.relname <> 'schema_migrations'
  )
SELECT string_agg(line, E'\n' ORDER BY line) AS fingerprint FROM lines;
