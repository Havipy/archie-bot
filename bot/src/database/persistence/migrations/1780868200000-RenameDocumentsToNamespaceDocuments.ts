import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameDocumentsToNamespaceDocuments1780868200000 implements MigrationInterface {
  name = 'RenameDocumentsToNamespaceDocuments1780868200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "documents" RENAME TO "namespace_documents"`);
    await queryRunner.query(`
      ALTER INDEX IF EXISTS "IDX_documents_namespace_libraryAsset"
      RENAME TO "IDX_namespace_documents_namespace_libraryAsset"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER INDEX IF EXISTS "IDX_namespace_documents_namespace_libraryAsset"
      RENAME TO "IDX_documents_namespace_libraryAsset"
    `);
    await queryRunner.query(`ALTER TABLE "namespace_documents" RENAME TO "documents"`);
  }
}
