import * as migration_20260831_181832_initial from './20260831_181832_initial';

export const migrations = [
  {
    up: migration_20260831_181832_initial.up,
    down: migration_20260831_181832_initial.down,
    name: '20260831_181832_initial'
  },
];
