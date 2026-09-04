import * as migration_20260831_181832_initial from './20260831_181832_initial';
import * as migration_20260901_034500_teable_databases_base_id from './20260901_034500_teable_databases_base_id';
import * as migration_20260902_000000_user_databases from './20260902_000000_user_databases';
import * as migration_20260902_020000_pages_generic_source_links from './20260902_020000_pages_generic_source_links';
import * as migration_20260902_030000_drop_teable_databases from './20260902_030000_drop_teable_databases';
import * as migration_20260902_040000_pillar2_system_tables from './20260902_040000_pillar2_system_tables';
import * as migration_20260902_050000_tasks_revision_numeric from './20260902_050000_tasks_revision_numeric';
import * as migration_20260902_060000_followers_page_entity_type from './20260902_060000_followers_page_entity_type';
import * as migration_20260902_061000_agent_runtime_profiles from './20260902_061000_agent_runtime_profiles';
import * as migration_20260902_070000_tasks_agents from './20260902_070000_tasks_agents';
import * as migration_20260902_080000_tasks_page from './20260902_080000_tasks_page';
import * as migration_20260902_090000_approvals from './20260902_090000_approvals';
import * as migration_20260902_100000_pages_project from './20260902_100000_pages_project';
import * as migration_20260902_120000_saved_views from './20260902_120000_saved_views';
import * as migration_20260902_130000_tasks_archived from './20260902_130000_tasks_archived';
import * as migration_20260902_140000_push_notifications from './20260902_140000_push_notifications';
import * as migration_20260902_150000_spend_caps from './20260902_150000_spend_caps';
import * as migration_20260903_130000_hermes_config from './20260903_130000_hermes_config';
import * as migration_20260903_140000_project_resources from './20260903_140000_project_resources';
import * as migration_20260904_010000_agents_hermes_profile from './20260904_010000_agents_hermes_profile';
import * as migration_20260904_120000_runtime_profile_handshake from './20260904_120000_runtime_profile_handshake';

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
  {
    up: migration_20260902_060000_followers_page_entity_type.up,
    down: migration_20260902_060000_followers_page_entity_type.down,
    name: '20260902_060000_followers_page_entity_type'
  },
  {
    up: migration_20260902_061000_agent_runtime_profiles.up,
    down: migration_20260902_061000_agent_runtime_profiles.down,
    name: '20260902_061000_agent_runtime_profiles'
  },
  {
    up: migration_20260902_070000_tasks_agents.up,
    down: migration_20260902_070000_tasks_agents.down,
    name: '20260902_070000_tasks_agents'
  },
  {
    up: migration_20260902_080000_tasks_page.up,
    down: migration_20260902_080000_tasks_page.down,
    name: '20260902_080000_tasks_page'
  },
  {
    up: migration_20260902_090000_approvals.up,
    down: migration_20260902_090000_approvals.down,
    name: '20260902_090000_approvals'
  },
  {
    up: migration_20260902_100000_pages_project.up,
    down: migration_20260902_100000_pages_project.down,
    name: '20260902_100000_pages_project'
  },
  {
    up: migration_20260902_120000_saved_views.up,
    down: migration_20260902_120000_saved_views.down,
    name: '20260902_120000_saved_views'
  },
  {
    up: migration_20260902_130000_tasks_archived.up,
    down: migration_20260902_130000_tasks_archived.down,
    name: '20260902_130000_tasks_archived'
  },
  {
    up: migration_20260902_140000_push_notifications.up,
    down: migration_20260902_140000_push_notifications.down,
    name: '20260902_140000_push_notifications'
  },
  {
    up: migration_20260902_150000_spend_caps.up,
    down: migration_20260902_150000_spend_caps.down,
    name: '20260902_150000_spend_caps'
  },
  {
    up: migration_20260903_130000_hermes_config.up,
    down: migration_20260903_130000_hermes_config.down,
    name: '20260903_130000_hermes_config'
  },
  {
    up: migration_20260903_140000_project_resources.up,
    down: migration_20260903_140000_project_resources.down,
    name: '20260903_140000_project_resources'
  },
  {
    up: migration_20260904_010000_agents_hermes_profile.up,
    down: migration_20260904_010000_agents_hermes_profile.down,
    name: '20260904_010000_agents_hermes_profile'
  },
  {
    up: migration_20260904_120000_runtime_profile_handshake.up,
    down: migration_20260904_120000_runtime_profile_handshake.down,
    name: '20260904_120000_runtime_profile_handshake'
  },
];
