export type ErrorCode =
  | 'quota'
  | 'credits'
  | 'auth'
  | 'model'
  | 'vision'
  | 'blocked'
  | 'rate'
  | 'server'
  | 'network'
  | 'format'
  | 'other'

export interface AppError {
  code: ErrorCode
  /** What went wrong and what to do about it, for the user. */
  message: string
  /** Raw provider message, for troubleshooting. */
  detail?: string
}

/** Errors that would hit every remaining page the same way, so the job stops instead of burning through them. */
export const FATAL_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['quota', 'credits', 'auth', 'model', 'vision'])

/** IPC only carries `error.message`, so the structured error travels inside it. */
const PREFIX = 'APP_ERROR:'

export function appError(error: AppError): Error {
  return new Error(PREFIX + JSON.stringify(error))
}

export function isAppError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(PREFIX)
}

export function toAppError(err: unknown): AppError {
  const message = (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
    ''
  )
  if (message.startsWith(PREFIX)) {
    try {
      return JSON.parse(message.slice(PREFIX.length)) as AppError
    } catch {
      // Fall through to the raw message.
    }
  }
  return { code: 'other', message }
}
