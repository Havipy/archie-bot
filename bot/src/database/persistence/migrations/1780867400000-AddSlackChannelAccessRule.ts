import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSlackChannelAccessRule1780867400000 implements MigrationInterface {
  name = 'AddSlackChannelAccessRule1780867400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."access_rules_type_enum" ADD VALUE IF NOT EXISTS 'slack_channel'`,
    );
  }

  // Postgres can't drop a single enum value — down is a no-op.
  public async down(): Promise<void> {}
}
