import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDocumentStoragePath1780867300000 implements MigrationInterface {
  name = 'AddDocumentStoragePath1780867300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN "storagePath" character varying(1024)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "storagePath"`);
  }
}
