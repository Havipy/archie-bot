import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Namespace } from '../database/entities/namespace.entity';
import { AccessRule } from '../database/entities/access-rule.entity';
import { Feedback } from '../database/entities/feedback.entity';
import { RagModule } from '../rag/rag.module';
import { SlackService } from './slack.service';
import { AccessService } from './access.service';
import { IntentRouterService } from './intent-router.service';
import { FeedbackService } from './feedback.service';
@Module({
  imports: [TypeOrmModule.forFeature([Namespace, AccessRule, Feedback]), RagModule],
  providers: [SlackService, AccessService, IntentRouterService, FeedbackService],
  exports: [SlackService, AccessService],
})
export class SlackModule {}
