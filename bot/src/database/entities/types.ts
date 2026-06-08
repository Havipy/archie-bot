export const DocumentStatus = {
  PENDING: 'pending',
  INDEXING: 'indexing',
  INDEXED: 'indexed',
  ERROR: 'error',
} as const;

export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const AccessMode = {
  PUBLIC: 'public',
  RESTRICTED: 'restricted',
} as const;

export type AccessMode = (typeof AccessMode)[keyof typeof AccessMode];

export const AccessRuleType = {
  EMAIL: 'email',
  EMAIL_DOMAIN: 'email_domain',
  SLACK_GROUP: 'slack_group',
  SLACK_CHANNEL: 'slack_channel',
} as const;

export type AccessRuleType = (typeof AccessRuleType)[keyof typeof AccessRuleType];

export const DOCUMENT_STATUSES = Object.values(DocumentStatus);
export const ACCESS_RULE_TYPES = Object.values(AccessRuleType);
export const ACCESS_MODES = Object.values(AccessMode);
