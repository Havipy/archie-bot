import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type FeedbackRating = 'up' | 'down';

@Entity('feedback')
export class Feedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  userId: string;

  @Column({ type: 'text' })
  question: string;

  @Column({ type: 'text', nullable: true })
  answer: string | null;

  @Column({ type: 'enum', enum: ['up', 'down'] })
  rating: FeedbackRating;

  @Column({ type: 'varchar', length: 512, nullable: true })
  bases: string | null;

  @Column({ type: 'real', nullable: true })
  topScore: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
