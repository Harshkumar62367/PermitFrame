import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing from .env.local");

const sql = neon(process.env.DATABASE_URL);
const [counts] = await sql`
  select
    (select count(*)::int from users) as users,
    (select count(*)::int from workspaces) as workspaces,
    (select count(*)::int from workspace_state) as workspace_states,
    (select count(*)::int from sessions) as total_sessions,
    (select count(*)::int from sessions where expires_at > now()) as active_sessions,
    (select count(*)::int from application_state) as legacy_states,
    (select coalesce(sum(jsonb_array_length(data->'campaigns')), 0)::int from workspace_state) as workspace_campaigns,
    (select coalesce(sum(jsonb_array_length(data->'productFacts')), 0)::int from workspace_state) as workspace_product_facts
`;

const tables = await sql`
  select table_name
  from information_schema.tables
  where table_schema = 'public'
    and table_name in ('application_state', 'users', 'workspaces', 'workspace_state', 'sessions')
  order by table_name
`;

console.log(JSON.stringify({ counts, tables: tables.map((row) => row.table_name) }, null, 2));
