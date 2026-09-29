import { useCallback, useEffect, useState } from 'react'
import { eventsUrl, fetchSnapshot, UserFacingError } from '../lib/api'
import type { LiveEvent, Participant, Question, QuestionGroup, Session } from '../lib/types'

export type ConnectionState = 'connecting' | 'live' | 'reconnecting'

interface LiveSessionState {
  session: Session | null
  participants: Participant[]
  questions: Question[]
  groups: QuestionGroup[]
  loading: boolean
  error: string | null
  connection: ConnectionState
  reload: () => void
}

/** Insert or replace a row by id. */
function upsert<T extends { id: string }>(list: T[], row: T): T[] {
  const index = list.findIndex((item) => item.id === row.id)
  if (index === -1) return [...list, row]
  const next = list.slice()
  next[index] = row
  return next
}

const RECONNECT_MS = 3000

/**
 * Subscribes to the Go server's event stream for one session. The first
 * message is a full snapshot; later messages are row upserts. After any
 * disconnect the browser reconnects and receives a fresh snapshot, so nothing
 * that happened while offline is missed.
 */
export function useLiveSession(code: string): LiveSessionState {
  const [session, setSession] = useState<Session | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [groups, setGroups] = useState<QuestionGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [attempt, setAttempt] = useState(0)

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let closed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const source = new EventSource(eventsUrl(code))

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as LiveEvent
      switch (event.type) {
        case 'snapshot':
          setSession(event.data.session)
          setParticipants(event.data.participants)
          setQuestions(event.data.questions)
          setGroups(event.data.groups)
          setLoading(false)
          setError(null)
          setConnection('live')
          break
        case 'session':
          setSession(event.data)
          break
        case 'participant':
          setParticipants((list) => upsert(list, event.data))
          break
        case 'question':
          setQuestions((list) => upsert(list, event.data))
          break
        case 'group':
          setGroups((list) => upsert(list, event.data))
          break
      }
    }

    source.onerror = () => {
      if (closed) return
      setConnection('reconnecting')
      if (source.readyState !== EventSource.CLOSED) return // the browser is retrying on its own

      // The stream was refused (e.g. unknown code, server restarting). Find out why.
      fetchSnapshot(code)
        .then(() => {
          if (!closed) retryTimer = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS)
        })
        .catch((err: unknown) => {
          if (closed) return
          const message = err instanceof UserFacingError ? err.message : 'Could not load the session.'
          if (/no session found|6 letters/i.test(message)) {
            setError(message)
            setLoading(false)
          } else {
            retryTimer = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS)
          }
        })
    }

    const onOffline = () => setConnection('reconnecting')
    window.addEventListener('offline', onOffline)

    return () => {
      closed = true
      clearTimeout(retryTimer)
      source.close()
      window.removeEventListener('offline', onOffline)
    }
  }, [code, attempt])

  return { session, participants, questions, groups, loading, error, connection, reload }
}
