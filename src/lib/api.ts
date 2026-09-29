import { readJSON, writeJSON } from './storage'
import type { Participant, Question, Session, Snapshot } from './types'

export class UserFacingError extends Error {}

/** Empty = same origin (the Go server serves the app, or Vite proxies /api in dev). */
export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '')

const NETWORK_MESSAGE = "Can't reach the server. Check your connection and try again."

async function request<T>(path: string, init: RequestInit = {}, fallback = 'Something went wrong. Please try again.'): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    })
  } catch {
    throw new UserFacingError(NETWORK_MESSAGE)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new UserFacingError((body as { error?: string } | null)?.error ?? fallback)
  return body as T
}

const post = <T>(path: string, body: unknown = {}, headers: Record<string, string> = {}, fallback?: string) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body), headers }, fallback)

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const HOST_KEYS = 'getit.hostKeys'

export function getHostKey(sessionId: string): string | undefined {
  return readJSON<Record<string, string>>(HOST_KEYS, {})[sessionId]
}

export async function createSession(): Promise<Session> {
  const { session, host_key } = await post<{ session: Session; host_key: string }>(
    '/sessions',
    {},
    {},
    'Could not create a session. Please try again.',
  )
  writeJSON(HOST_KEYS, { ...readJSON<Record<string, string>>(HOST_KEYS, {}), [session.id]: host_key })
  return session
}

export async function findSessionByCode(rawCode: string): Promise<Session> {
  const code = normalizeCode(rawCode)
  if (code.length !== 6) throw new UserFacingError('Session codes are 6 letters or numbers.')
  return request<Session>(`/sessions/${code}`, {}, 'Could not look up that session. Please try again.')
}

export async function endSession(session: Session): Promise<void> {
  const hostKey = getHostKey(session.id)
  if (!hostKey) throw new UserFacingError('Only the browser that created this session can end it.')
  await post(`/sessions/${session.code}/end`, {}, { 'X-Host-Key': hostKey }, 'Could not end the session.')
}

export function fetchSnapshot(code: string): Promise<Snapshot> {
  return request<Snapshot>(`/sessions/${code}/snapshot`)
}

export function eventsUrl(code: string): string {
  return `${API_BASE}/api/sessions/${code}/events`
}

// ---------------------------------------------------------------------------
// Participants & questions
// ---------------------------------------------------------------------------

interface StoredParticipant {
  id: string
  name: string
}

const participantKey = (sessionId: string) => `getit.participant.${sessionId}`

export function getStoredParticipant(sessionId: string): StoredParticipant | null {
  return readJSON<StoredParticipant | null>(participantKey(sessionId), null)
}

async function ensureParticipant(session: Session, displayName: string): Promise<string> {
  const stored = getStoredParticipant(session.id)
  if (stored && stored.name === displayName) return stored.id

  const participant = await post<Participant>(`/sessions/${session.code}/participants`, { display_name: displayName })
  writeJSON(participantKey(session.id), { id: participant.id, name: displayName })
  return participant.id
}

export interface SubmitInput {
  session: Session
  displayName: string
  text: string
  /** Stable per draft, so retrying after a network error cannot duplicate the question. */
  requestId: string
}

export async function submitQuestion({ session, displayName, text, requestId }: SubmitInput): Promise<Question> {
  const name = displayName.trim()
  const body = text.trim()
  if (!name) throw new UserFacingError('Please enter your name.')
  if (!body) throw new UserFacingError('Please type a question first.')
  if (body.length > 1000) throw new UserFacingError('Questions are limited to 1000 characters.')

  const participantId = await ensureParticipant(session, name)
  try {
    // The server stores the question and returns immediately; AI classification runs in the background.
    return await post<Question>(
      `/sessions/${session.code}/questions`,
      { participant_id: participantId, text: body, client_request_id: requestId },
      {},
      'Your question could not be submitted. Please try again.',
    )
  } catch (error) {
    // Our saved participant may belong to a wiped database – forget it so the next try re-joins.
    if (error instanceof UserFacingError && error.message.startsWith('Please rejoin')) {
      writeJSON(participantKey(session.id), null)
    }
    throw error
  }
}

export function retryClassification(code: string): Promise<unknown> {
  return post(`/sessions/${code}/retry-classification`).catch((error: unknown) =>
    console.warn('Retry request failed:', error),
  )
}

/** Inserts predefined classroom questions server-side; they flow through the normal AI pipeline. */
export function generateTestQuestions(code: string): Promise<{ count: number; duration_ms: number }> {
  return post(`/sessions/${code}/demo`, {}, {}, 'Could not generate test questions.')
}
