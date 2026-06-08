import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLibraryAssets1780868100000 implements MigrationInterface {
  name = 'AddLibraryAssets1780868100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "library_assets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "filename" character varying(512) NOT NULL,
        "mimeType" character varying(127),
        "storagePath" character varying(1024) NOT NULL,
        "contentHash" character varying(64) NOT NULL,
        "sizeBytes" integer NOT NULL,
        "uploadedBy" character varying(255) NOT NULL,
        "uploadedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_library_assets" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_library_assets_contentHash" UNIQUE ("contentHash")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN "libraryAssetId" uuid,
      ADD CONSTRAINT "FK_documents_libraryAsset"
        FOREIGN KEY ("libraryAssetId") REFERENCES "library_assets"("id")
        ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_documents_namespace_libraryAsset"
      ON "documents" ("namespaceId", "libraryAssetId")
      WHERE "libraryAssetId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_documents_namespace_libraryAsset"`);
    await queryRunner.query(`ALTER TABLE "documents" DROP CONSTRAINT "FK_documents_libraryAsset"`);
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "libraryAssetId"`);
    await queryRunner.query(`DROP TABLE "library_assets"`);
  }
}
