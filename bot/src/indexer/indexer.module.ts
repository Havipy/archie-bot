import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { RagModule } from '../rag/rag.module';
import { ConfluenceSyncService } from './confluence-sync.service';
import { IndexerService } from './indexer.service';
import { ParserService } from './parser.service';

@Module({
  imports: [TypeOrmModule.forFeature([NamespaceDocument]), RagModule],
  providers: [IndexerService, ParserService, ConfluenceSyncService],
  exports: [IndexerService, ParserService, ConfluenceSyncService],
})
export class IndexerModule {}
