import 'reflect-metadata';
import * as dotenv from 'dotenv';

dotenv.config();

import { DataSource } from 'typeorm';
import { typeOrmOptions } from './typeorm.options';

export default new DataSource(typeOrmOptions);
