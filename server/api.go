package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type API struct {
	store  *Store
	hub    *Hub
	worker *Worker
	ctx    context.Context // server lifetime, for background work
}

func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/sessions", a.createSession)
	mux.HandleFunc("GET /api/sessions/{code}", a.getSession)
	mux.HandleFunc("GET /api/sessions/{code}/snapshot", a.getSnapshot)
	mux.HandleFunc("GET /api/sessions/{code}/events", a.streamEvents)
	mux.HandleFunc("POST /api/sessions/{code}/end", a.endSession)
	mux.HandleFunc("POST /api/sessions/{code}/participants", a.createParticipant)
	mux.HandleFunc("POST /api/sessions/{code}/questions", a.createQuestion)
	mux.HandleFunc("POST /api/sessions/{code}/retry-classification", a.retryClassification)
	mux.HandleFunc("POST /api/sessions/{code}/demo", a.generateDemo)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

var (
	uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	codeRE = regexp.MustCompile(`^[A-Z0-9]{6}$`)
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body.")
		return false
	}
	return true
}

func (a *API) internalError(w http.ResponseWriter, what string, err error) {
	log.Printf("%s: %v", what, err)
	writeError(w, http.StatusInternalServerError, "Something went wrong. Please try again.")
}

// sessionFromPath loads the session named by {code}, writing a 404 if missing.
func (a *API) sessionFromPath(w http.ResponseWriter, r *http.Request) (Session, bool) {
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if !codeRE.MatchString(code) {
		writeError(w, http.StatusBadRequest, "Session codes are 6 letters or numbers.")
		return Session{}, false
	}
	ss, err := a.store.SessionByCode(r.Context(), code)
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusNotFound, fmt.Sprintf("No session found with code %s. Check the code and try again.", code))
		return ss, false
	}
	if err != nil {
		a.internalError(w, "load session", err)
		return ss, false
	}
	return ss, true
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

func (a *API) createSession(w http.ResponseWriter, r *http.Request) {
	ss, hostKey, err := a.store.CreateSession(r.Context())
	if err != nil {
		a.internalError(w, "create session", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session": ss, "host_key": hostKey})
}

func (a *API) getSession(w http.ResponseWriter, r *http.Request) {
	if ss, ok := a.sessionFromPath(w, r); ok {
		writeJSON(w, http.StatusOK, ss)
	}
}

func (a *API) getSnapshot(w http.ResponseWriter, r *http.Request) {
	ss, ok := a.sessionFromPath(w, r)
	if !ok {
		return
	}
	snap, err := a.store.Snapshot(r.Context(), ss)
	if err != nil {
		a.internalError(w, "snapshot", err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (a *API) endSession(w http.ResponseWriter, r *http.Request) {
	ss, ok := a.sessionFromPath(w, r)
	if !ok {
		return
	}
	hostKey := r.Header.Get("X-Host-Key")
	if !uuidRE.MatchString(hostKey) {
		writeError(w, http.StatusForbidden, "Only the browser that created this session can end it.")
		return
	}
	ended, err := a.store.EndSession(r.Context(), ss.ID, hostKey)
	if errors.Is(err, ErrForbidden) {
		writeError(w, http.StatusForbidden, "Only the browser that created this session can end it.")
		return
	}
	if err != nil {
		a.internalError(w, "end session", err)
		return
	}
	a.hub.Publish(ss.ID, "session", ended)
	writeJSON(w, http.StatusOK, ended)
}

// streamEvents is the live feed (Server-Sent Events). The first event is a full
// snapshot; after that every change is pushed as {type, data}. Browsers
// reconnect automatically and receive a fresh snapshot, so nothing is missed.
func (a *API) streamEvents(w http.ResponseWriter, r *http.Request) {
	ss, ok := a.sessionFromPath(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming unsupported.")
		return
	}

	// Subscribe before loading the snapshot so no change can fall in between.
	events, cancel := a.hub.Subscribe(ss.ID)
	defer cancel()

	// Students only need to know whether the session is still open (scope=session);
	// they never receive other students' questions.
	sessionOnly := r.URL.Query().Get("scope") == "session"
	var first Event
	if sessionOnly {
		first = Event{Type: "session", Data: ss}
	} else {
		snap, err := a.store.Snapshot(r.Context(), ss)
		if err != nil {
			a.internalError(w, "snapshot", err)
			return
		}
		first = Event{Type: "snapshot", Data: snap}
	}
	payload, _ := json.Marshal(first)

	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{}) // long-lived response
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	fmt.Fprintf(w, "retry: 2000\ndata: %s\n\n", payload)
	flusher.Flush()

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, open := <-events:
			if !open {
				return // dropped as a slow consumer; the browser will reconnect
			}
			if sessionOnly && !bytes.HasPrefix(msg, []byte(`{"type":"session"`)) {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

// ---------------------------------------------------------------------------
// participants & questions
// ---------------------------------------------------------------------------

func (a *API) createParticipant(w http.ResponseWriter, r *http.Request) {
	ss, ok := a.sessionFromPath(w, r)
	if !ok {
		return
	}
	var body struct {
		DisplayName string `json:"display_name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.DisplayName)
	if name == "" || utf8.RuneCountInString(name) > 60 {
		writeError(w, http.StatusBadRequest, "Please enter a name (up to 60 characters).")
		return
	}
	p, err := a.store.CreateParticipant(r.Context(), ss.ID, name)
	if errors.Is(err, ErrSessionEnded) {
		writeError(w, http.StatusConflict, "This session has ended. Questions are closed.")
		return
	}
	if err != nil {
		a.internalError(w, "create participant", err)
		return
	}
	a.hub.Publish(ss.ID, "participant", p)
	writeJSON(w, http.StatusCreated, p)
}

func (a *API) createQuestion(w http.ResponseWriter, r *http.Request) {
	ss, ok := a.sessionFromPath(w, r)
	if !ok {
		return
	}
	var body struct {
		ParticipantID   string `json:"participant_id"`
		Text            string `json:"text"`
		ClientRequestID string `json:"client_request_id"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	text := strings.TrimSpace(body.Text)
	switch {
	case text == "":
		writeError(w, http.StatusBadRequest, "Please type a question first.")
		return
	case utf8.RuneCountInString(text) > 1000:
		writeError(w, http.StatusBadRequest, "Questions are limited to 1000 characters.")
		return
	case !uuidRE.MatchString(body.ParticipantID) || !uuidRE.MatchString(body.ClientRequestID):
		writeError(w, http.StatusBadRequest, "Invalid participant or request id.")
		return
	}

	q, created, err := a.store.InsertQuestion(r.Context(), ss.ID, body.ParticipantID, text, body.ClientRequestID)
	switch {
	case errors.Is(err, ErrSessionEnded):
		writeError(w, http.StatusConflict, "This session has ended. Questions are closed.")
		return
	case errors.Is(err, ErrBadParticipant):
		writeError(w, http.StatusUnprocessableEntity, "Please rejoin the session and try again.")
		return
	case err != nil:
		a.internalError(w, "insert question", err)
		return
	}

	status := http.StatusOK // an identical retry of a submission we already stored
	if created {
		status = http.StatusCreated
		a.hub.Publish(ss.ID, "question", q)
		// Classification happens in the background; the student gets an answer now.
		a.worker.Kick(a.ctx, ss.ID)
	}
	writeJSON(w, status, q)
}

func (a *API) retryClassification(w http.ResponseWriter, r *http.Request) {
	ss, ok := a.sessionFromPath(w, r)
	if !ok {
		return
	}
	reset, err := a.store.ResetAttempts(r.Context(), ss.ID)
	if err != nil {
		a.internalError(w, "reset attempts", err)
		return
	}
	for _, q := range reset {
		a.hub.Publish(ss.ID, "question", q)
	}
	a.worker.Kick(a.ctx, ss.ID)
	writeJSON(w, http.StatusAccepted, map[string]int{"requeued": len(reset)})
}
