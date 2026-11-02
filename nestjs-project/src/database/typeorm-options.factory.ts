import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import databaseConfig from '../config/database.config';

interface TypeOrmExtra {
  autoLoadEntities?: boolean;
  entities?: TypeOrmModuleOptions['entities'];
}

export function buildTypeOrmOptions(
  dbConfig: ConfigType<typeof databaseConfig>,
  extra: TypeOrmExtra = {},
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    synchronize: false,
    ...extra,
  };
}
