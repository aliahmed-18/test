export type SessionStatus = 'active' | 'ended'
export type ClassificationStatus = 'pending' | 'processing' | 'classified'

export interface Session {
  id: string
  code: string
  status: SessionStatus
  created_at: string
  ended_at: string | null
}

export interface Participant {
  id: string
  session_id: string
  display_name: string
  created_at: string
}

export interface Question {
  id: string
  session_id: string
  participant_id: string
  text: string
  created_at: string
  group_id: string | null
  classification_status: ClassificationStatus
  classification_attempts: number
  classification_error: string | null
  classification_updated_at: string
}

export interface QuestionGroup {
  id: string
  session_id: string
  title: string
  representative_question: string
  created_at: string
  updated_at: string
}
