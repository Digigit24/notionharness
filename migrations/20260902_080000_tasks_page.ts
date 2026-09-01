import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "tasks" ADD COLUMN "page_id" integer;
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "tasks_page_idx" ON "tasks" USING btree ("page_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX "tasks_page_idx";
    ALTER TABLE "tasks" DROP CONSTRAINT "tasks_page_id_pages_id_fk";
    ALTER TABLE "tasks" DROP COLUMN "page_id";
  `)
}
