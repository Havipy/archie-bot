import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Namespace } from '../database/entities/namespace.entity';
import { NamespaceDocument } from '../database/entities/namespace-document.entity';
import { AccessRule } from '../database/entities/access-rule.entity';
import { IndexerModule } from '../indexer/indexer.module';
import { RagModule } from '../rag/rag.module';
import { SlackModule } from '../slack/slack.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminRateLimitGuard } from './admin-rate-limit.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Namespace, NamespaceDocument, AccessRule]),
    IndexerModule,
    RagModule,
    SlackModule,
  ],
  providers: [AdminService, AdminAuthGuard, AdminRateLimitGuard],
  controllers: [AdminController],
})
export class AdminModule {}
