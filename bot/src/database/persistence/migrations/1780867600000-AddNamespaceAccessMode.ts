import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceAccessMode1780867600000 implements MigrationInterface {
  name = 'AddNamespaceAccessMode1780867600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."namespaces_accessMode_enum" AS ENUM('public', 'restricted')`,
    );
    await queryRunner.query(
      `ALTER TABLE "namespaces" ADD COLUMN "accessMode" "public"."namespaces_accessMode_enum" NOT NULL DEFAULT 'restricted'`,
    );
    await queryRunner.query(`
      UPDATE "namespaces" n SET "accessMode" = 'public'
      WHERE EXISTS (
        SELECT 1 FROM "access_rules" r
        WHERE r."namespaceId" = n.id AND r.type = 'public'
      )
    `);
    await queryRunner.query(`DELETE FROM "access_rules" WHERE type = 'public'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "namespaces" DROP COLUMN "accessMode"`);
    await queryRunner.query(`DROP TYPE "public"."namespaces_accessMode_enum"`);
  }
}
