import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Namespace } from './namespace.entity';
import { AccessRuleType, ACCESS_RULE_TYPES } from './types';

export type { AccessRuleType } from './types';

@Entity('access_rules')
export class AccessRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  namespaceId: string;

  @ManyToOne(() => Namespace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'namespaceId' })
  namespace: Namespace;

  @Column({ type: 'enum', enum: ACCESS_RULE_TYPES })
  type: AccessRuleType;

  @Column({ type: 'varchar', length: 512 })
  value: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  label: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
