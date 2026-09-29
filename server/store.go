package main

import (
	"context"
	"crypto/rand"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

var (
	ErrNotFound       = errors.New("not found")
	ErrForbidden      = errors.New("forbidden")
	ErrSessionEnded   = errors.New("session ended")
	ErrBadParticipant = errors.New("participant does not belong to this session")
)

// JSON uses snake_case to mirror the database columns.

type Session struct {
	ID        string     `json:"id"`
	Code      string     `json:"code"`
	Status    string     `json:"status"`
	CreatedAt time.Time  `json:"created_at"`
	EndedAt   *time.Time `json:"ended_at"`
}

type Participant struct {
	ID          string    `json:"id"`
	SessionID   string    `json:"session_id"`
	DisplayName string    `json:"display_name"`
	CreatedAt   time.Time `json:"created_at"`
}

type Question struct {
	ID                      string    `json:"id"`
	SessionID               string    `json:"session_id"`
	ParticipantID           string    `json:"participant_id"`
	Text                    string    `json:"text"`
	CreatedAt               time.Time `json:"created_at"`
	GroupID                 *string   `json:"group_id"`
	ClassificationStatus    string    `json:"classification_status"`
	ClassificationAttempts  int       `json:"classification_attempts"`
	ClassificationError     *string   `json:"classification_error"`
	ClassificationUpdatedAt time.Time `json:"classification_updated_at"`
}

type Group struct {
	ID                     string    `json:"id"`
	SessionID              string    `json:"session_id"`
	Title                  string    `json:"title"`
	RepresentativeQuestion string    `json:"representative_question"`
	CreatedAt              time.Time `json:"created_at"`
	UpdatedAt              time.Time `json:"updated_at"`
}

type Snapshot struct {
	Session      Session       `json:"session"`
	Participants []Participant `json:"participants"`
	Questions    []Question    `json:"questions"`
	Groups       []Group       `json:"groups"`
}

type Store struct {
	db *pgxpool.Pool
}

func NewStore(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	return &Store{db: pool}, nil
}

func (s *Store) Close() { s.db.Close() }

// Migrate applies embedded migrations in filename order, once each.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, `create table if not exists schema_migrations (
		name text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}
	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		var exists bool
		if err := s.db.QueryRow(ctx, `select exists(select 1 from schema_migrations where name = $1)`, name).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		sql, err := migrationFiles.ReadFile(name)
		if err != nil {
			return err
		}
		err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `insert into schema_migrations (name) values ($1)`, name)
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sessionCols = `id, code, status, created_at, ended_at`

func scanSession(row pgx.Row) (Session, error) {
	var ss Session
	err := row.Scan(&ss.ID, &ss.Code, &ss.Status, &ss.CreatedAt, &ss.EndedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ss, ErrNotFound
	}
	return ss, err
}

// Ambiguous characters (0/O, 1/I) are left out so codes are easy to read aloud.
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func randomCode() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b)
}

func (s *Store) CreateSession(ctx context.Context) (Session, string, error) {
	for attempt := 0; attempt < 10; attempt++ {
		var ss Session
		var hostKey string
		err := s.db.QueryRow(ctx,
			`insert into sessions (code) values ($1) returning `+sessionCols+`, host_key`, randomCode()).
			Scan(&ss.ID, &ss.Code, &ss.Status, &ss.CreatedAt, &ss.EndedAt, &hostKey)
		if isUniqueViolation(err) {
			continue // code collision: try another
		}
		return ss, hostKey, err
	}
	return Session{}, "", errors.New("could not generate a unique session code")
}

func (s *Store) SessionByCode(ctx context.Context, code string) (Session, error) {
	return scanSession(s.db.QueryRow(ctx, `select `+sessionCols+` from sessions where code = $1`, code))
}

func (s *Store) EndSession(ctx context.Context, sessionID, hostKey string) (Session, error) {
	ss, err := scanSession(s.db.QueryRow(ctx,
		`update sessions set status = 'ended', ended_at = coalesce(ended_at, now())
		  where id = $1 and host_key::text = $2 returning `+sessionCols, sessionID, hostKey))
	if errors.Is(err, ErrNotFound) {
		return ss, ErrForbidden
	}
	return ss, err
}

// ---------------------------------------------------------------------------
// Participants & questions
// ---------------------------------------------------------------------------

func (s *Store) CreateParticipant(ctx context.Context, sessionID, name string) (Participant, error) {
	var p Participant
	err := s.db.QueryRow(ctx,
		`insert into participants (session_id, display_name)
		 select id, $2 from sessions where id = $1 and status = 'active'
		 returning id, session_id, display_name, created_at`, sessionID, name).
		Scan(&p.ID, &p.SessionID, &p.DisplayName, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrSessionEnded
	}
	return p, err
}

const questionCols = `id, session_id, participant_id, text, created_at, group_id, classification_status,
	classification_attempts, classification_error, classification_updated_at`

func scanQuestion(row pgx.Row) (Question, error) {
	var q Question
	err := row.Scan(&q.ID, &q.SessionID, &q.ParticipantID, &q.Text, &q.CreatedAt, &q.GroupID,
		&q.ClassificationStatus, &q.ClassificationAttempts, &q.ClassificationError, &q.ClassificationUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return q, ErrNotFound
	}
	return q, err
}

func collectQuestions(rows pgx.Rows, err error) ([]Question, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Question{}
	for rows.Next() {
		q, err := scanQuestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// InsertQuestion stores a question. If the same clientRequestID was already
// stored (a retried submit), the existing question is returned with created=false.
func (s *Store) InsertQuestion(ctx context.Context, sessionID, participantID, text, clientRequestID string) (Question, bool, error) {
	var status string
	var belongs bool
	err := s.db.QueryRow(ctx,
		`select s.status, exists(select 1 from participants p where p.id = $2 and p.session_id = s.id)
		   from sessions s where s.id = $1`, sessionID, participantID).Scan(&status, &belongs)
	if errors.Is(err, pgx.ErrNoRows) {
		return Question{}, false, ErrNotFound
	}
	if err != nil {
		return Question{}, false, err
	}
	if status != "active" {
		return Question{}, false, ErrSessionEnded
	}
	if !belongs {
		return Question{}, false, ErrBadParticipant
	}

	q, err := scanQuestion(s.db.QueryRow(ctx,
		`insert into questions (session_id, participant_id, text, client_request_id)
		 values ($1, $2, $3, $4)
		 on conflict (client_request_id) do nothing
		 returning `+questionCols, sessionID, participantID, text, clientRequestID))
	if err == nil {
		return q, true, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return q, false, err
	}
	// Conflict: this exact submission already reached us.
	q, err = scanQuestion(s.db.QueryRow(ctx,
		`select `+questionCols+` from questions where client_request_id = $1 and session_id = $2`,
		clientRequestID, sessionID))
	return q, false, err
}

func (s *Store) Snapshot(ctx context.Context, ss Session) (Snapshot, error) {
	snap := Snapshot{Session: ss, Participants: []Participant{}, Groups: []Group{}}

	rows, err := s.db.Query(ctx,
		`select id, session_id, display_name, created_at from participants where session_id = $1 order by created_at`, ss.ID)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var p Participant
		if err := rows.Scan(&p.ID, &p.SessionID, &p.DisplayName, &p.CreatedAt); err != nil {
			rows.Close()
			return snap, err
		}
		snap.Participants = append(snap.Participants, p)
	}
	rows.Close()

	if snap.Questions, err = collectQuestions(s.db.Query(ctx,
		`select `+questionCols+` from questions where session_id = $1 order by created_at`, ss.ID)); err != nil {
		return snap, err
	}
	if snap.Groups, err = s.groups(ctx, ss.ID); err != nil {
		return snap, err
	}
	return snap, nil
}

// ---------------------------------------------------------------------------
// Groups & classification bookkeeping (used by the worker)
// ---------------------------------------------------------------------------

const groupCols = `id, session_id, title, representative_question, created_at, updated_at`

func scanGroup(row pgx.Row) (Group, error) {
	var g Group
	err := row.Scan(&g.ID, &g.SessionID, &g.Title, &g.RepresentativeQuestion, &g.CreatedAt, &g.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return g, ErrNotFound
	}
	return g, err
}

func (s *Store) groups(ctx context.Context, sessionID string) ([]Group, error) {
	rows, err := s.db.Query(ctx, `select `+groupCols+` from question_groups where session_id = $1 order by created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GroupContexts returns each group with its most recent member questions, for the classifier prompt.
func (s *Store) GroupContexts(ctx context.Context, sessionID string, examples int) ([]GroupContext, error) {
	groups, err := s.groups(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	members, err := collectQuestions(s.db.Query(ctx,
		`select `+questionCols+` from questions
		  where session_id = $1 and group_id is not null order by created_at desc`, sessionID))
	if err != nil {
		return nil, err
	}
	byGroup := map[string][]string{}
	for _, m := range members {
		byGroup[*m.GroupID] = append(byGroup[*m.GroupID], m.Text)
	}
	out := make([]GroupContext, 0, len(groups))
	for _, g := range groups {
		texts := byGroup[g.ID]
		out = append(out, GroupContext{
			ID:                     g.ID,
			Title:                  g.Title,
			RepresentativeQuestion: g.RepresentativeQuestion,
			ExampleQuestions:       texts[:min(len(texts), examples)],
			QuestionCount:          len(texts),
		})
	}
	return out, nil
}

// ClaimNextQuestion marks the oldest classifiable question of a session as processing.
func (s *Store) ClaimNextQuestion(ctx context.Context, sessionID string, maxAttempts int) (Question, error) {
	return scanQuestion(s.db.QueryRow(ctx,
		`update questions set classification_status = 'processing',
		        classification_attempts = classification_attempts + 1,
		        classification_updated_at = now()
		  where id = (select id from questions
		               where session_id = $1 and classification_status = 'pending'
		                 and classification_attempts < $2
		               order by created_at limit 1
		               for update skip locked)
		  returning `+questionCols, sessionID, maxAttempts))
}

// AssignToGroup puts a question into an existing group and refreshes the group's representative question.
func (s *Store) AssignToGroup(ctx context.Context, questionID, groupID, representative string) (Question, Group, error) {
	var q Question
	var g Group
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var err error
		if g, err = scanGroup(tx.QueryRow(ctx,
			`update question_groups set representative_question = $2, updated_at = now()
			  where id = $1 returning `+groupCols, groupID, representative)); err != nil {
			return err
		}
		q, err = s.markClassified(ctx, tx, questionID, g.ID)
		return err
	})
	return q, g, err
}

// AssignToNewGroup creates a group and puts the question in it.
func (s *Store) AssignToNewGroup(ctx context.Context, questionID, sessionID, title, representative string) (Question, Group, error) {
	var q Question
	var g Group
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var err error
		if g, err = scanGroup(tx.QueryRow(ctx,
			`insert into question_groups (session_id, title, representative_question)
			 values ($1, $2, $3) returning `+groupCols, sessionID, title, representative)); err != nil {
			return err
		}
		q, err = s.markClassified(ctx, tx, questionID, g.ID)
		return err
	})
	return q, g, err
}

func (s *Store) markClassified(ctx context.Context, tx pgx.Tx, questionID, groupID string) (Question, error) {
	return scanQuestion(tx.QueryRow(ctx,
		`update questions set group_id = $2, classification_status = 'classified',
		        classification_error = null, classification_updated_at = now()
		  where id = $1 returning `+questionCols, questionID, groupID))
}

// MarkFailed puts a question back to pending with the error recorded – it never disappears.
func (s *Store) MarkFailed(ctx context.Context, questionID, message string) (Question, error) {
	if len(message) > 500 {
		message = message[:500]
	}
	return scanQuestion(s.db.QueryRow(ctx,
		`update questions set classification_status = 'pending', classification_error = $2,
		        classification_updated_at = now()
		  where id = $1 returning `+questionCols, questionID, message))
}

// ResetAttempts gives questions that exhausted their automatic attempts another chance.
func (s *Store) ResetAttempts(ctx context.Context, sessionID string) ([]Question, error) {
	return collectQuestions(s.db.Query(ctx,
		`update questions set classification_attempts = 0, classification_error = null,
		        classification_status = 'pending', classification_updated_at = now()
		  where session_id = $1 and classification_status <> 'classified'
		  returning `+questionCols, sessionID))
}

// RecoverAbandoned resets questions left "processing" by a previous server process.
func (s *Store) RecoverAbandoned(ctx context.Context) error {
	_, err := s.db.Exec(ctx,
		`update questions set classification_status = 'pending', classification_updated_at = now()
		  where classification_status = 'processing'`)
	return err
}

// SessionsWithPendingWork lists sessions that have questions still waiting for the AI.
func (s *Store) SessionsWithPendingWork(ctx context.Context, maxAttempts int) ([]string, error) {
	rows, err := s.db.Query(ctx,
		`select distinct session_id from questions
		  where classification_status = 'pending' and classification_attempts < $1`, maxAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
