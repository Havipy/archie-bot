import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Feedback, FeedbackRating } from '../database/entities/feedback.entity';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    @InjectRepository(Feedback)
    private readonly feedbackRepo: Repository<Feedback>,
  ) {}

  async record(input: {
    userId: string;
    question: string;
    answer: string;
    rating: FeedbackRating;
    bases: string[];
    topScore: number;
  }): Promise<void> {
    try {
      await this.feedbackRepo.insert({
        userId: input.userId,
        question: input.question.slice(0, 4000),
        answer: input.answer.slice(0, 8000) || null,
        rating: input.rating,
        bases: input.bases.join(', ').slice(0, 512) || null,
        topScore: input.topScore,
      });
      this.logger.log(`Feedback ${input.rating} from ${input.userId}: ${input.question.slice(0, 60)}`);
    } catch (err) {
      this.logger.warn('Failed to record feedback', err);
    }
  }
}
