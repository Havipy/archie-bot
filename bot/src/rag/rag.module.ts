import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { RagService } from './rag.service';
import { ConversationService } from './conversation.service';
import { NamespaceRouterService } from './namespace-router.service';
import { NamespaceProfileService } from './namespace-profile.service';

@Module({
  imports: [TypeOrmModule.forFeature([NamespaceDocument])],
  providers: [RagService, ConversationService, NamespaceRouterService, NamespaceProfileService],
  exports: [RagService, ConversationService, NamespaceProfileService],
})
export class RagModule {}
