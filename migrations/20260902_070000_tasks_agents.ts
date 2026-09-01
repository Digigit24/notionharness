import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "tasks" ADD COLUMN "agent_id" integer;
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "tasks_agent_idx" ON "tasks" USING btree ("agent_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX "tasks_agent_idx";
    ALTER TABLE "tasks" DROP CONSTRAINT "tasks_agent_id_agents_id_fk";
    ALTER TABLE "tasks" DROP COLUMN "agent_id";
  `)
}
