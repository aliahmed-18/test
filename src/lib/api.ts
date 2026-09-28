import { supabase } from './supabase'
import { readJSON, uuid, writeJSON } from './storage'
import type { Participant, Session } from './types'

export class UserFacingError extends Error {}

const NETWORK_MESSAGE = "Can't reach the server. Check your connection and try again."

function isNetworkError(error: unknown): boolean {
  if (!navigator.onLine) return true
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '')
  return /failed to fetch|network|load failed|fetch/i.test(message)
}

function toUserError(error: unknown, fallback: string): UserFacingError {
  if (error instanceof UserFacingError) return error
  return new UserFacingError(isNetworkError(error) ? NETWORK_MESSAGE : fallback)
}

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

export async function createSession(): Promise<{ id: string; code: string }> {
  try {
    const { data, error } = await supabase.rpc('create_session')
    if (error) throw error
    const row = (Array.isArray(data) ? data[0] : data) as { id: string; code: string; host_key: string }
    writeJSON(HOST_KEYS, { ...readJSON<Record<string, string>>(HOST_KEYS, {}), [row.id]: row.host_key })
    return { id: row.id, code: row.code }
  } catch (error) {
    throw toUserError(error, 'Could not create a session. Please try again.')
  }
}

export async function findSessionByCode(rawCode: string): Promise<Session> {
  const code = normalizeCode(rawCode)
  if (code.length !== 6) throw new UserFacingError('Session codes are 6 letters or numbers.')
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, code, status, created_at, ended_at')
      .eq('code', code)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new UserFacingError(`No session found with code ${code}. Check the code and try again.`)
    return data as Session
  } catch (error) {
    throw toUserError(error, 'Could not look up that session. Please try again.')
  }
}

export async function endSession(sessionId: string): Promise<void> {
  const hostKey = getHostKey(sessionId)
  if (!hostKey) throw new UserFacingError('Only the browser that created this session can end it.')
  const { error } = await supabase.rpc('end_session', { p_session_id: sessionId, p_host_key: hostKey })
  if (error) throw toUserError(error, 'Could not end the session.')
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

async function ensureParticipant(sessionId: string, displayName: string): Promise<string> {
  const stored = getStoredParticipant(sessionId)
  if (stored && stored.name === displayName) return stored.id

  const id = uuid()
  const { error } = await supabase.from('participants').insert({ id, session_id: sessionId, display_name: displayName })
  if (error) throw error
  writeJSON(participantKey(sessionId), { id, name: displayName })
  return id
}

function sessionEndedOrRlsError(error: { code?: string }): boolean {
  // 42501 = RLS rejected the insert: the session is no longer active.
  return error.code === '42501'
}

export interface SubmitInput {
  session: Session
  displayName: string
  text: string
  /** Stable per draft, so retrying after a network error cannot duplicate the question. */
  requestId: string
}

export async function submitQuestion({ session, displayName, text, requestId }: SubmitInput): Promise<void> {
  const name = displayName.trim()
  const body = text.trim()
  if (!name) throw new UserFacingError('Please enter your name.')
  if (!body) throw new UserFacingError('Please type a question first.')
  if (body.length > 1000) throw new UserFacingError('Questions are limited to 1000 characters.')

  try {
    const participantId = await ensureParticipant(session.id, name)
    const { error } = await supabase.from('questions').insert({
      session_id: session.id,
      participant_id: participantId,
      text: body,
      client_request_id: requestId,
    })
    // 23505 = this exact submission already reached the server (a retry) – treat as success.
    if (error && error.code !== '23505') {
      if (sessionEndedOrRlsError(error)) throw new UserFacingError('This session has ended. Questions are closed.')
      throw error
    }
  } catch (error) {
    throw toUserError(error, 'Your question could not be submitted. Please try again.')
  }

  // Do not wait for the AI – confirm to the student immediately.
  triggerClassification(session.id)
}

/** Fire-and-forget request to the classification worker. */
export function triggerClassification(sessionId: string, options: { retryFailed?: boolean } = {}): Promise<void> {
  return supabase.functions
    .invoke('classify-questions', { body: { session_id: sessionId, retry_failed: options.retryFailed ?? false } })
    .then(({ error }) => {
      if (error) console.warn('Classification request failed:', error.message)
    })
    .catch((error: unknown) => console.warn('Classification request failed:', error))
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

// Deliberately mixes paraphrases of the same concept with different concepts.
// The AI decides the groups – nothing here is pre-labelled.
const DEMO_QUESTIONS: Array<[student: string, question: string]> = [
  ['Maya', 'What is a constructor?'],
  ['Omar', 'What is an attribute?'],
  ['Lena', 'When is a constructor called?'],
  ['Jonas', 'What is a getter?'],
  ['Priya', 'What does new Student() do?'],
  ['Omar', 'What properties does an object have?'],
  ['Maya', 'Why do we use constructors?'],
  ['Lena', 'How can I retrieve a private attribute?'],
  ['Jonas', 'What is the difference between a class and an object?'],
  ['Priya', 'Can a constructor take parameters?'],
  ['Sam', 'Where do we store data inside an object?'],
  ['Sam', 'Is a class like a blueprint?'],
]

export async function generateTestQuestions(
  session: Session,
  onProgress?: (inserted: number, total: number) => void,
): Promise<void> {
  const participantIds = new Map<string, string>()
  const people = [...new Set(DEMO_QUESTIONS.map(([name]) => name))]
  const { data, error } = await supabase
    .from('participants')
    .insert(people.map((name) => ({ id: uuid(), session_id: session.id, display_name: `${name} (demo)` })))
    .select('id, display_name')
  if (error) throw toUserError(error, 'Could not create demo students.')
  for (const p of data as Pick<Participant, 'id' | 'display_name'>[]) {
    participantIds.set(p.display_name.replace(' (demo)', ''), p.id)
  }

  for (const [index, [name, text]] of DEMO_QUESTIONS.entries()) {
    const { error: insertError } = await supabase.from('questions').insert({
      session_id: session.id,
      participant_id: participantIds.get(name),
      text,
      client_request_id: uuid(),
    })
    if (insertError) throw toUserError(insertError, 'Could not insert demo questions.')
    onProgress?.(index + 1, DEMO_QUESTIONS.length)
    // Same pipeline as a real student submission.
    triggerClassification(session.id)
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}
