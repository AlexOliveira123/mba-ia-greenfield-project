import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMetadataAndFailureReasonToVideos1793637809022 implements MigrationInterface {
  name = 'AddMetadataAndFailureReasonToVideos1793637809022';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "metadata" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "failure_reason" text`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP COLUMN IF EXISTS "failure_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" DROP COLUMN IF EXISTS "metadata"`,
    );
  }
}
