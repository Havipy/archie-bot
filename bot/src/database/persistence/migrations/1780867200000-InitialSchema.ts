import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1780867200000 implements MigrationInterface {
  name = 'InitialSchema1780867200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "namespaces" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(255) NOT NULL,
        "slug" character varying(100) NOT NULL,
        "slackChannelId" character varying(20),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_namespaces" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_namespaces_name" UNIQUE ("name"),
        CONSTRAINT "UQ_namespaces_slug" UNIQUE ("slug"),
        CONSTRAINT "UQ_namespaces_slackChannelId" UNIQUE ("slackChannelId")
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."documents_status_enum" AS ENUM(
        'pending', 'indexing', 'indexed', 'error'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "filename" character varying(512) NOT NULL,
        "mimeType" character varying(127),
        "namespaceId" uuid NOT NULL,
        "uploadedBy" character varying(255) NOT NULL,
        "uploadedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "chunkCount" integer NOT NULL DEFAULT 0,
        "status" "public"."documents_status_enum" NOT NULL DEFAULT 'pending',
        CONSTRAINT "PK_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_documents_namespace" FOREIGN KEY ("namespaceId")
          REFERENCES "namespaces"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."access_rules_type_enum" AS ENUM(
        'public', 'user_id', 'email', 'email_domain', 'slack_group'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "access_rules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "namespaceId" uuid NOT NULL,
        "type" "public"."access_rules_type_enum" NOT NULL,
        "value" character varying(512) NOT NULL,
        "label" character varying(255),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_access_rules" PRIMARY KEY ("id"),
        CONSTRAINT "FK_access_rules_namespace" FOREIGN KEY ("namespaceId")
          REFERENCES "namespaces"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "access_rules"`);
    await queryRunner.query(`DROP TYPE "public"."access_rules_type_enum"`);
    await queryRunner.query(`DROP TABLE "documents"`);
    await queryRunner.query(`DROP TYPE "public"."documents_status_enum"`);
    await queryRunner.query(`DROP TABLE "namespaces"`);
  }
}
