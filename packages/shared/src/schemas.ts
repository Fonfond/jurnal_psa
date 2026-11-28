import { z } from 'zod';
import { HLC_RE } from './hlc';
import type { JournalEventType } from './types';

export { HLC_RE };

export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'Ожидается UUID',
  );

export const hlcSchema = z.string().regex(HLC_RE, 'Ожидается HLC вида 13:5:8');

export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: 'Ожидается ISO 8601 UTC' });

export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD');

export const roleSchema = z.enum(['worker', 'supervisor', 'admin', 'auditor']);
export const inputMethodSchema = z.enum(['voice', 'manual']);
export const asrEngineSchema = z.enum(['on_device', 'web_speech']);

/** Multi-journal contracts (JRN-03): journals catalogue and per-journal access. */
export const journalAccessLevelSchema = z.enum(['read', 'write', 'manage']);
export const journalKeySchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'Ключ журнала: латиница в нижнем регистре, цифры, _ и -, начинается с буквы или цифры',
  );

export const journalCreateSchema = z
  .object({
    journal_key: journalKeySchema,
    name: z.string().min(2).max(200),
    description: z.string().max(500).nullish(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const journalPatchSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    description: z.string().max(500).nullish(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const journalMemberUpsertSchema = z
  .object({
    access_level: journalAccessLevelSchema.default('write'),
  })
  .strict();

export const journalFilterSchema = uuidSchema.optional();
export const permitStatusSchema = z.enum([
  'draft',
  'active',
  'suspended',
  'closed',
  'annulled',
]);
export const bindingStatusSchema = z.enum([
  'linked',
  'unresolved',
  'not_found',
  'not_required',
]);
export const opTypeSchema = z.enum(['create', 'update', 'delete']);

export const journalEventTypeSchema = z.enum([
  'work',
  'command',
  'switching',
  'grounding',
  'incident',
  'other',
]);

export const commandEventDataSchema = z
  .object({
    issued_by: z.string().min(2).max(200),
    received_at: isoDateTimeSchema.nullish(),
    executed_at: isoDateTimeSchema.nullish(),
    refusal_reason: z.string().max(500).nullish(),
  })
  .strict();

export const switchingOperationSchema = z
  .object({
    operation: z.enum(['open', 'close', 'check', 'measure', 'other']),
    device: z.string().min(1).max(200),
    from_state: z.string().max(80).nullish(),
    to_state: z.string().max(80).nullish(),
    note: z.string().max(300).nullish(),
  })
  .strict();

export const switchingCheckSchema = z
  .object({
    check: z.string().min(2).max(300),
    passed: z.boolean(),
    note: z.string().max(300).nullish(),
  })
  .strict();

/**
 * Switching form (757): ordered operations, checks performed before/after
 * switching, the order that authorised them and the equipment involved.
 * Legacy free-text `sequence`/`points` remain accepted for old clients.
 */
export const switchingEventDataSchema = z
  .object({
    order_no: z.string().max(64).nullish(),
    order_date: dateOnlySchema.nullish(),
    responsible: z.string().max(200).nullish(),
    sequence: z
      .union([z.string().max(500), z.array(switchingOperationSchema).max(50)])
      .nullish(),
    operations: z.array(switchingOperationSchema).max(50).optional(),
    checks: z.array(switchingCheckSchema).max(30).optional(),
    executed_at: isoDateTimeSchema.nullish(),
    points: z.string().max(500).nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const legacySequence =
      typeof value.sequence === 'string'
        ? value.sequence.trim().length > 0
        : Array.isArray(value.sequence) && value.sequence.length > 0;
    const hasOperations = (value.operations?.length ?? 0) > 0;
    if (!hasOperations && !legacySequence && !value.points?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations'],
        message: 'Укажите хотя бы одну операцию переключения или оборудование',
      });
    }
    if (value.operations && value.operations.length === 0 && !legacySequence && !value.points?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations'],
        message: 'Список операций пуст',
      });
    }
  });

export const groundingEventDataSchema = z
  .object({
    action: z.enum(['applied', 'removed']),
    grounding_type: z.enum(['portable', 'fixed']),
    point: z.string().min(2).max(200),
    count: z.number().int().min(0).max(100).optional(),
    tool_number: z.string().max(64).nullish(),
  })
  .strict();

export const incidentEventDataSchema = z
  .object({
    severity: z.enum(['minor', 'major', 'critical']),
    cause: z.string().max(500).nullish(),
    actions: z.string().max(1000).nullish(),
  })
  .strict();

export const otherEventDataSchema = z
  .object({
    description: z.string().max(1000).nullish(),
  })
  .strict();

export const eventDataSchemas: Record<JournalEventType, z.ZodTypeAny> = {
  work: z.object({}).strict(),
  command: commandEventDataSchema,
  switching: switchingEventDataSchema,
  grounding: groundingEventDataSchema,
  incident: incidentEventDataSchema,
  other: otherEventDataSchema,
};

export function validateEventData(
  eventType: JournalEventType,
  data: unknown,
) {
  return eventDataSchemas[eventType].safeParse(data);
}

export const journalReviewCreateSchema = z
  .object({
    /** Journal being reviewed; omitted means the default `main` journal. */
    journal_id: uuidSchema.optional(),
    period_start: dateOnlySchema,
    period_end: dateOnlySchema,
    remarks: z.string().max(2000).optional(),
  })
  .refine(
    (value) => value.period_start <= value.period_end,
    {
      path: ['period_end'],
      message: 'Конец периода должен быть не раньше начала',
    },
  );

const entryFieldsSchema = z.object({
  performed_at: isoDateTimeSchema,
  performed_tz_offset_min: z.number().int().min(-840).max(840),
  performed_at_source: z.enum(['device_auto', 'manual', 'server_corrected']).optional(),
  performed_at_reason_id: uuidSchema.nullish(),
  performed_at_comment: z.string().max(200).nullish(),
  shift_date: dateOnlySchema.nullish(),
  work_type_id: uuidSchema,
  site_id: uuidSchema.nullish(),
  site_name_raw: z.string().trim().min(2).max(120).nullish(),
  site_binding_status: bindingStatusSchema.optional(),
  permit_id: uuidSchema.nullish(),
  permit_number_raw: z.string().min(3).max(32).nullish(),
  permit_binding_status: bindingStatusSchema.optional(),
  permit_status_at_sync: permitStatusSchema.nullish(),
  permit_risk_flag: z.boolean().optional(),
  permit_risk_reason: z.string().max(200).nullish(),
  text: z
    .string()
    .max(2000)
    .refine((value) => value.trim().length >= 10, 'Текст должен быть не короче 10 символов'),
  comment: z.string().max(500).nullish(),
  input_method: inputMethodSchema,
  asr_engine: asrEngineSchema.nullish(),
  asr_confidence: z.number().min(0).max(1).nullish(),
  offline_created: z.boolean().optional(),
  event_type: journalEventTypeSchema.optional(),
  event_data: z.record(z.string(), z.unknown()).nullish(),
  late_entry: z.boolean().optional(),
  /**
   * Journal the entry belongs to (JRN-03). Optional for backward compatibility:
   * old clients omit it and the server assigns the default `main` journal.
   * Ignored on update — an entry never changes its journal.
   */
  journal_id: uuidSchema.optional(),
  /**
   * C-08: explicit consent to replace a server-corrected performed_at.
   * Optional and operation-only; it is not stored on the entry.
   */
  accept_server_time: z.boolean().optional(),
});

export const entryUpdatePayloadSchema = entryFieldsSchema.partial();

export const entryPayloadSchema = entryFieldsSchema
  .superRefine((value, ctx) => {
    if (value.input_method === 'voice' && !value.asr_engine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['asr_engine'],
        message: 'Для голосового ввода обязателен asr_engine',
      });
    }
    if (value.permit_risk_flag && !value.permit_risk_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permit_risk_reason'],
        message: 'Для флага риска обязательна причина',
      });
    }
    if (value.permit_id && value.permit_number_raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permit_number_raw'],
        message: 'Укажите либо permit_id, либо permit_number_raw',
      });
    }
    if (value.site_id && value.site_name_raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['site_name_raw'],
        message: 'Укажите либо site_id, либо site_name_raw',
      });
    }
    if (value.event_type && value.event_data) {
      const eventResult = eventDataSchemas[value.event_type].safeParse(
        value.event_data,
      );
      if (!eventResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['event_data'],
          message: eventResult.error.issues
            .map((issue) => issue.message)
            .join('; '),
        });
      }
    }
    if (
      value.event_type &&
      value.event_type !== 'work' &&
      value.event_type !== 'other' &&
      !value.event_data
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event_data'],
        message: 'Для этого типа события нужны структурированные данные',
      });
    }
  });

/** Shift handover (JRN-02): handover payload and two-sided acceptance actions. */
export const shiftHandoverSchema = z
  .object({
    journal_id: uuidSchema,
    shift_date: dateOnlySchema,
    period_start: isoDateTimeSchema,
    period_end: isoDateTimeSchema,
    handover_comment: z.string().min(5).max(1000),
  })
  .strict()
  .refine((value) => Date.parse(value.period_start) < Date.parse(value.period_end), {
    path: ['period_end'],
    message: 'Конец смены должен быть позже начала',
  });

export const shiftActionSchema = z
  .object({
    action: z.enum(['accept', 'reject']),
    comment: z.string().max(1000).nullish(),
    rejection_reason: z.string().min(3).max(500).nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'reject' && !value.rejection_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejection_reason'],
        message: 'Укажите причину отклонения смены',
      });
    }
  });

export const shiftListQuerySchema = z.object({
  journal_id: uuidSchema.optional(),
  status: z.enum(['handed_over', 'accepted', 'rejected', 'cancelled']).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const syncOpSchema = z.object({  op_id: uuidSchema,
  entity_type: z.enum(['entry', 'shift']).default('entry'),
  entity_id: uuidSchema,
  op_type: opTypeSchema,
  base_version: z.number().int().min(0).nullable(),
  hlc: hlcSchema,
  client_time: isoDateTimeSchema,
  payload: z.record(z.string(), z.unknown()),
  field_clocks: z.record(z.string(), hlcSchema).optional(),
});

export const syncPushSchema = z.object({
  device_id: uuidSchema,
  app_version: z.string().min(1).max(20),
  ops: z.array(syncOpSchema).min(1).max(50),
});

export const changesQuerySchema = z.object({
  since_seq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  /**
   * Optional device binding for the created session (ADR-23). When present the
   * device must belong to the authenticated user and be active.
   */
  device_id: uuidSchema.optional(),
});

export const installIdSchema = z
  .string()
  .min(8, 'install_id должен быть не короче 8 символов')
  .max(128)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    'install_id допускает только латиницу, цифры и символы . _ : -',
  );

/**
 * Device self-registration (ADR-23). The server upserts by (user_id, install_id),
 * so a repeated call is idempotent and keeps the existing device id.
 */
export const deviceRegisterSchema = z
  .object({
    install_id: installIdSchema,
    name: z.string().min(1).max(80).optional(),
    platform: z.string().min(1).max(40).optional(),
    app_version: z.string().min(1).max(20).optional(),
    fingerprint: z.string().min(8).max(128).optional(),
    rotate_key: z.boolean().optional(),
  })
  .strict();

export const signatureRequestSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict()
  .default({});

export const signatureListQuerySchema = z.object({
  entity_type: z.enum(['entry', 'journal_review', 'shift', 'export']),
  entity_id: uuidSchema,
});

export const oidcAuthorizeQuerySchema = z.object({
  /** Same-origin path to return to after the IdP callback. */
  redirect_after: z.string().max(512).optional(),
  /** Optional device id to bind the new session to. */
  device_id: uuidSchema.optional(),
});

export const oidcCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(8).max(256).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

export const permitCsvRowSchema = z.object({
  external_id: z.string().min(1).max(64),
  number: z.string().min(3).max(32),
  year: z.coerce.number().int().min(2000).max(2100),
  type: z.enum(['permit_to_work', 'order', 'other']).default('permit_to_work'),
  status: permitStatusSchema,
  valid_from: isoDateTimeSchema,
  valid_to: isoDateTimeSchema,
  site_code: z.string().min(1),
  description: z.string().min(10).max(2000),
  responsible_login: z.string().min(1),
  external_url: z.string().url().nullish(),
  /** Deep link to the permit PDF in the external system (OQ-03). */
  pdf_url: z.string().url().nullish(),
  pdf_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'Ожидается SHA-256')
    .nullish(),
});

export type EntryPayload = z.infer<typeof entryPayloadSchema>;
export type SyncOpInput = z.infer<typeof syncOpSchema>;
export type SyncPushInput = z.infer<typeof syncPushSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PermitCsvRow = z.infer<typeof permitCsvRowSchema>;
export type JournalReviewCreate = z.infer<typeof journalReviewCreateSchema>;
export type DeviceRegisterInput = z.infer<typeof deviceRegisterSchema>;
export type SignatureRequestInput = z.infer<typeof signatureRequestSchema>;
export type OidcCallbackQuery = z.infer<typeof oidcCallbackQuerySchema>;
export type JournalCreateInput = z.infer<typeof journalCreateSchema>;
export type JournalPatchInput = z.infer<typeof journalPatchSchema>;
export type JournalMemberInput = z.infer<typeof journalMemberUpsertSchema>;
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;
