import { join } from 'path';
import * as dotenv from 'dotenv';
import { DataSourceOptions } from 'typeorm';
import { Namespace } from '../entities/namespace.entity';
import { NamespaceDocument } from '../entities/namespace-document.entity';
import { AccessRule } from '../entities/access-rule.entity';
import { Feedback } from '../entities/feedback.entity';

dotenv.config();

const isCompiled = __filename.endsWith('.js');

export const typeOrmOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? 'postgres',
  entities: [Namespace, NamespaceDocument, AccessRule, Feedback],
  migrations: [join(__dirname, 'migrations', isCompiled ? '*.js' : '*.ts')],
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  synchronize: false,
};
