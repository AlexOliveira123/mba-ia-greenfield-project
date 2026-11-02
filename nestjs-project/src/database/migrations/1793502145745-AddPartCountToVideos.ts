import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPartCountToVideos1793502145745 implements MigrationInterface {
  name = 'AddPartCountToVideos1793502145745';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" ADD "part_count" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "part_count"`);
  }
}
