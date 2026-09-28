import { useEffect, useState } from 'react'
import type { Question, QuestionGroup } from './types'

/** After this long without a result, show "Classification pending" instead of "Analyzing…". */
export const ANALYZING_GRACE_MS = 45_000

export type QuestionState =
  | { kind: 'grouped'; group: QuestionGroup }
  | { kind: 'analyzing' }
  | { kind: 'pending'; reason: string | null }

export function questionState(question: Question, groupsById: Map<string, QuestionGroup>, now: number): QuestionState {
  if (question.classification_status === 'classified') {
    const group = question.group_id ? groupsById.get(question.group_id) : undefined
    if (group) return { kind: 'grouped', group }
    return { kind: 'pending', reason: 'Group no longer exists' }
  }
  if (question.classification_status === 'processing') return { kind: 'analyzing' }
  const age = now - new Date(question.created_at).getTime()
  if (question.classification_error || age > ANALYZING_GRACE_MS) {
    return { kind: 'pending', reason: question.classification_error }
  }
  return { kind: 'analyzing' }
}

/** Re-render periodically so relative times and "analyzing" timeouts stay current. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function formatTime(iso: string, now: number): string {
  const date = new Date(iso)
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

