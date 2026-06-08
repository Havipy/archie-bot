import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFeedback1780868000000 implements MigrationInterface {
  name = 'AddFeedback1780868000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."feedback_rating_enum" AS ENUM('up', 'down')`);
    await queryRunner.query(`
      CREATE TABLE "feedback" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" character varying(255) NOT NULL,
        "question" text NOT NULL,
        "answer" text,
        "rating" "public"."feedback_rating_enum" NOT NULL,
        "bases" character varying(512),
        "topScore" real,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feedback" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "feedback"`);
    await queryRunner.query(`DROP TYPE "public"."feedback_rating_enum"`);
  }
}
