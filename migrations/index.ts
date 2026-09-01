import * as migration_20260831_181832_initial from './20260831_181832_initial';
import * as migration_20260901_034500_teable_databases_base_id from './20260901_034500_teable_databases_base_id';

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
];
