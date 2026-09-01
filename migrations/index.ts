import * as migration_20260831_181832_initial from './20260831_181832_initial';
import * as migration_20260901_034500_teable_databases_base_id from './20260901_034500_teable_databases_base_id';
import * as migration_20260902_000000_user_databases from './20260902_000000_user_databases';
import * as migration_20260902_020000_pages_generic_source_links from './20260902_020000_pages_generic_source_links';
import * as migration_20260902_030000_drop_teable_databases from './20260902_030000_drop_teable_databases';
import * as migration_20260902_040000_pillar2_system_tables from './20260902_040000_pillar2_system_tables';
import * as migration_20260902_050000_tasks_revision_numeric from './20260902_050000_tasks_revision_numeric';

export const migrations = [
  {
    up: migration_20260831_181832_initial.up,
    down: migration_20260831_181832_initial.down,
    name: '20260831_181832_initial'
  },
  {
    up: migration_20260901_034500_teable_databases_base_id.up,
    down: migration_20260901_034500_teable_databases_base_id.down,
    name: '20260901_034500_teable_databases_base_id'
  },
  {
    up: migration_20260902_000000_user_databases.up,
    down: migration_20260902_000000_user_databases.down,
    name: '20260902_000000_user_databases'
  },
  {
    up: migration_20260902_020000_pages_generic_source_links.up,
    down: migration_20260902_020000_pages_generic_source_links.down,
    name: '20260902_020000_pages_generic_source_links'
  },
  {
    up: migration_20260902_030000_drop_teable_databases.up,
    down: migration_20260902_030000_drop_teable_databases.down,
    name: '20260902_030000_drop_teable_databases'
  },
  {
    up: migration_20260902_040000_pillar2_system_tables.up,
    down: migration_20260902_040000_pillar2_system_tables.down,
    name: '20260902_040000_pillar2_system_tables'
  },
  {
    up: migration_20260902_050000_tasks_revision_numeric.up,
    down: migration_20260902_050000_tasks_revision_numeric.down,
    name: '20260902_050000_tasks_revision_numeric'
  },
];
