import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmOptions } from './database/persistence/typeorm.options';
import { RagModule } from './rag/rag.module';
import { IndexerModule } from './indexer/indexer.module';
import { SlackModule } from './slack/slack.module';
import { AdminModule } from './admin/admin.module';
import { DocumentsModule } from './documents/documents.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...typeOrmOptions,
      migrationsRun: true,
    }),
    RagModule,
    IndexerModule,
    SlackModule,
    AdminModule,
    DocumentsModule,
  ],
})
export class AppModule {}
