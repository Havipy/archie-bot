import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { NamespaceDocument } from './namespace-document.entity';
import { AccessMode, ACCESS_MODES } from './types';

@Entity('namespaces')
export class Namespace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  name: string;

  /** URL-friendly slug — Pinecone namespace key */
  @Column({ type: 'varchar', length: 100, unique: true })
  slug: string;

  /** public = everyone; restricted = OR over access_rules */
  @Column({ type: 'enum', enum: ACCESS_MODES, default: AccessMode.RESTRICTED })
  accessMode: AccessMode;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => NamespaceDocument, (doc) => doc.namespace)
  namespaceDocuments: NamespaceDocument[];
}
