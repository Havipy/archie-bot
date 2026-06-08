import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropNamespaceSlackChannelId1780867500000 implements MigrationInterface {
  name = 'DropNamespaceSlackChannelId1780867500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "namespaces" DROP CONSTRAINT IF EXISTS "UQ_namespaces_slackChannelId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "namespaces" DROP COLUMN IF EXISTS "slackChannelId"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "namespaces" ADD COLUMN "slackChannelId" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "namespaces" ADD CONSTRAINT "UQ_namespaces_slackChannelId" UNIQUE ("slackChannelId")`,
    );
  }
}
