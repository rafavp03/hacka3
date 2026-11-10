import * as z from 'zod/mini'

// Sin compilación JIT (new Function): la CSP no permite unsafe-eval.
z.config({ jitless: true })

export const PERMISSIONS = [
  'files:read',
  'files:refine',
  'refiners:read',
  'refiners:write',
  'media:upload',
  'incidents:read',
  'incidents:create',
  'team:manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const nullableString = z.nullable(z.string())

export const TokenPairSchema = z.looseObject({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
})
export type TokenPair = z.infer<typeof TokenPairSchema>

export const MeSchema = z.looseObject({
  id: z.number(),
  email: z.string(),
  displayName: z.string(),
  team: z.looseObject({ code: z.string(), name: z.string() }),
  role: z.looseObject({ code: z.string(), name: z.string() }),
  permissions: z.array(z.string()),
  clearance: z.looseObject({ granted: z.boolean(), grantedAt: z.optional(nullableString) }),
})
export type Me = z.infer<typeof MeSchema>

export const HealthSchema = z.looseObject({ status: z.string() })

export const BinSchema = z.enum(['WO', 'FC', 'DR', 'MA'])
export type Bin = z.infer<typeof BinSchema>
export const BINS: readonly Bin[] = ['WO', 'FC', 'DR', 'MA']

export const ProgressSchema = z.looseObject({
  WO: z.number(),
  FC: z.number(),
  DR: z.number(),
  MA: z.number(),
  overall: z.number(),
})
export type Progress = z.infer<typeof ProgressSchema>

export const FileSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  rows: z.number(),
  cols: z.number(),
  tileSize: z.number(),
  status: z.enum(['ACTIVE', 'COMPLETE']),
  progress: ProgressSchema,
  refinedGroups: z.number(),
  totalGroups: z.number(),
  mistakes: z.number(),
  updatedAt: z.string(),
})
export type LumonFile = z.infer<typeof FileSchema>

export function pageSchema<T extends z.ZodMiniType>(item: T) {
  return z.looseObject({
    content: z.array(item),
    totalElements: z.number(),
    totalPages: z.number(),
    page: z.number(),
    size: z.number(),
  })
}
export interface Page<T> {
  content: T[]
  totalElements: number
  totalPages: number
  page: number
  size: number
}

export const FilePageSchema = pageSchema(FileSchema)

export const RulesSchema = z.looseObject({
  tremorThreshold: z.number(),
  connectivity: z.union([z.literal(4), z.literal(8)]),
  minGroupSize: z.number(),
  maxGroupSize: z.number(),
  binning: z.looseObject({
    strategy: z.enum(['DIGIT_SUM_MOD', 'MAX_DIGIT_MOD']),
    order: z.array(BinSchema),
  }),
})
export type Rules = z.infer<typeof RulesSchema>

export const TileSchema = z.looseObject({
  tileRow: z.number(),
  tileCol: z.number(),
  originRow: z.number(),
  originCol: z.number(),
  rows: z.number(),
  cols: z.number(),
  values: z.string(),
  tremor: z.string(),
  bins: z.string(),
  version: z.number(),
})
export type TileDto = z.infer<typeof TileSchema>

export const RefineResultSchema = z.looseObject({
  refinementId: z.number(),
  bin: BinSchema,
  size: z.number(),
  file: z.looseObject({
    progress: ProgressSchema,
    refinedGroups: z.number(),
    totalGroups: z.number(),
    mistakes: z.number(),
    status: z.enum(['ACTIVE', 'COMPLETE']),
  }),
})
export type RefineResult = z.infer<typeof RefineResultSchema>

export const DepartmentSchema = z.looseObject({ id: z.number(), code: z.string(), name: z.string() })
export type Department = z.infer<typeof DepartmentSchema>

export const RefinerSchema = z.looseObject({
  id: z.number(),
  fullName: z.string(),
  department: DepartmentSchema,
  title: z.string(),
  extension: z.string(),
  bio: z.string(),
  profileUrl: z.optional(nullableString),
  badge: z.optional(z.nullable(z.looseObject({ url: z.string(), width: z.number(), height: z.number() }))),
  version: z.number(),
  updatedAt: z.string(),
})
export type Refiner = z.infer<typeof RefinerSchema>
export const RefinerPageSchema = pageSchema(RefinerSchema)

export const CheckSchema = z.looseObject({ name: z.string(), passed: z.boolean(), detail: z.optional(z.string()) })
export type Check = z.infer<typeof CheckSchema>

export const MediaTicketSchema = z.looseObject({
  ticketId: z.string(),
  expiresAt: z.string(),
  provider: z.enum(['SUPABASE', 'CLOUDINARY']),
  objectPath: z.optional(z.string()),
  bucket: z.optional(z.string()),
  uploadPublicId: z.optional(z.string()),
  expectedPublicId: z.optional(z.string()),
})
export type MediaTicket = z.infer<typeof MediaTicketSchema>

export const MediaSchema = z.looseObject({
  mediaId: z.number(),
  url: z.string(),
  width: z.number(),
  height: z.number(),
  purpose: z.enum(['BADGE', 'INCIDENT']),
})
export type Media = z.infer<typeof MediaSchema>

export const SeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
export type Severity = z.infer<typeof SeveritySchema>

export const IncidentSchema = z.looseObject({
  id: z.number(),
  title: z.string(),
  description: z.string(),
  severity: SeveritySchema,
  fileId: z.optional(z.nullable(z.number())),
  file: z.optional(z.nullable(z.looseObject({ id: z.number(), name: z.string() }))),
  photos: z.array(z.looseObject({ mediaId: z.number(), url: z.string(), width: z.number(), height: z.number() })),
  createdBy: z.looseObject({ id: z.number(), displayName: z.string() }),
  createdAt: z.string(),
})
export type Incident = z.infer<typeof IncidentSchema>
export const IncidentPageSchema = pageSchema(IncidentSchema)

export const TicketSchema = z.looseObject({ ticket: z.string(), expiresIn: z.optional(z.number()) })

export { z }

export const RegisterResponseSchema = z.looseObject({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
  team: z.looseObject({ code: z.string(), name: z.string() }),
})
