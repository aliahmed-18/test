import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Participant, Question, QuestionGroup, Session } from '../lib/types'

export type ConnectionState = 'connecting' | 'live' | 'reconnecting'

interface LiveSessionState {
  session: Session | null
  participants: Participant[]
  questions: Question[]
  groups: QuestionGroup[]
  loading: boolean
  error: string | null
  connection: ConnectionState
  reload: () => Promise<void>
}

type Row = { id: string }

/** Apply an INSERT/UPDATE/DELETE realtime event to a list keyed by id. */
function applyChange<T extends Row>(list: T[], payload: RealtimePostgresChangesPayload<T>): T[] {
  if (payload.eventType === 'DELETE') {
    const oldId = (payload.old as Partial<T>).id
    return list.filter((item) => item.id !== oldId)
  }
  const row = payload.new as T
  const index = list.findIndex((item) => item.id === row.id)
  if (index === -1) return [...list, row]
  const next = list.slice()
  next[index] = row
  return next
}

/**
 * Loads everything for one session and keeps it in sync through Supabase
 * Realtime. On (re)connection it refetches, so nothing is missed while offline.
 */
export function useLiveSession(code: string): LiveSessionState {
  const [session, setSession] = useState<Session | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [groups, setGroups] = useState<QuestionGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const sessionIdRef = useRef<string | null>(null)

  const loadAll = useCallback(async () => {
    const { data: s, error: sessionError } = await supabase
      .from('sessions')
      .select('id, code, status, created_at, ended_at')
      .eq('code', code)
      .maybeSingle()
    if (sessionError) throw sessionError
    if (!s) throw new Error(`No session found with code ${code}.`)
    sessionIdRef.current = s.id

    const [p, q, g] = await Promise.all([
      supabase.from('participants').select('*').eq('session_id', s.id),
      supabase.from('questions').select('*').eq('session_id', s.id).order('created_at', { ascending: true }),
      supabase.from('question_groups').select('*').eq('session_id', s.id),
    ])
    if (p.error) throw p.error
    if (q.error) throw q.error
    if (g.error) throw g.error

    setSession(s as Session)
    setParticipants(p.data as Participant[])
    setQuestions(q.data as Question[])
    setGroups(g.data as QuestionGroup[])
    return s as Session
  }, [code])

  const reload = useCallback(async () => {
    try {
      await loadAll()
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the session.')
    }
  }, [loadAll])

  useEffect(() => {
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    ;(async () => {
      setLoading(true)
      let s: Session
      try {
        s = await loadAll()
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the session.')
          setLoading(false)
        }
        return
      }
      if (cancelled) return
      setLoading(false)

      const filter = `session_id=eq.${s.id}`
      let hasConnected = false
      channel = supabase
        .channel(`session:${s.id}`)
        .on<Question>('postgres_changes', { event: '*', schema: 'public', table: 'questions', filter }, (payload) =>
          setQuestions((list) => applyChange(list, payload)),
        )
        .on<QuestionGroup>(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'question_groups', filter },
          (payload) => setGroups((list) => applyChange(list, payload)),
        )
        .on<Participant>(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'participants', filter },
          (payload) => setParticipants((list) => applyChange(list, payload)),
        )
        .on<Session>(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${s.id}` },
          (payload) => setSession(payload.new as Session),
        )
        .subscribe((status) => {
          if (cancelled) return
          if (status === 'SUBSCRIBED') {
            setConnection('live')
            // Catch up on anything that happened while we were disconnected.
            if (hasConnected) void reload()
            hasConnected = true
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setConnection('reconnecting')
          }
        })
    })()

    const onOnline = () => void reload()
    window.addEventListener('online', onOnline)
    const onOffline = () => setConnection('reconnecting')
    window.addEventListener('offline', onOffline)

    return () => {
      cancelled = true
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [loadAll, reload])

  return { session, participants, questions, groups, loading, error, connection, reload }
}
