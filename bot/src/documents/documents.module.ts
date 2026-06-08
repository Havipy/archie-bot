import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { SlackModule } from '../slack/slack.module';
import { DocumentsController } from './documents.controller';

@Module({
  imports: [TypeOrmModule.forFeature([NamespaceDocument]), SlackModule],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
