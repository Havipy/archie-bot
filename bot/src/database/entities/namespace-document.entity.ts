import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Namespace } from './namespace.entity';
import { DocumentStatus, DOCUMENT_STATUSES } from './types';

@Entity('namespace_documents')
export class NamespaceDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 512 })
  filename: string;

  @Column({ type: 'varchar', length: 127, nullable: true })
  mimeType: string | null;

  /** Relative path under uploads/{docId}/filename */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  storagePath: string | null;

  @ManyToOne(() => Namespace, (ns) => ns.namespaceDocuments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'namespaceId' })
  namespace: Namespace;

  @Column({ type: 'uuid' })
  namespaceId: string;

  @Column({ type: 'varchar', length: 255 })
  uploadedBy: string;

  @CreateDateColumn({ type: 'timestamptz' })
  uploadedAt: Date;

  @Column({ type: 'int', default: 0 })
  chunkCount: number;

  @Column({ type: 'enum', enum: DOCUMENT_STATUSES, default: DocumentStatus.PENDING })
  status: DocumentStatus;
}
