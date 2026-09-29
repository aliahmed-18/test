package main

import (
	"crypto/rand"
	"fmt"
	"log"
	"net/http"
	"time"
)

// Deliberately mixes paraphrases of the same concept with different concepts.
// The AI decides the groups – nothing here is pre-labelled.
var demoQuestions = []struct{ Student, Text string }{
	{"Maya", "What is a constructor?"},
	{"Omar", "What is an attribute?"},
	{"Lena", "When is a constructor called?"},
	{"Jonas", "What is a getter?"},
	{"Priya", "What does new Student() do?"},
	{"Omar", "What properties does an object have?"},
	{"Maya", "Why do we use constructors?"},
	{"Lena", "How can I retrieve a private attribute?"},
	{"Jonas", "What is the difference between a class and an object?"},
	{"Priya", "Can a constructor take parameters?"},
	{"Sam", "Where do we store data inside an object?"},
	{"Sam", "Is a class like a blueprint?"},
}

const demoSpacing = 600 * time.Millisecond

// generateDemo inserts the demo questions one by one in the background. They
// go through exactly the same path as real submissions (store -> live feed ->
// worker -> Claude).
func (a *API) generateDemo(w http.ResponseWriter, r *http.Request) {
	ss, ok := a.sessionFromPath(w, r)
	if !ok {
		return
	}
	if ss.Status != "active" {
		writeError(w, http.StatusConflict, "This session has ended.")
		return
	}
	go a.runDemo(ss)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"count":       len(demoQuestions),
		"duration_ms": (demoSpacing * time.Duration(len(demoQuestions))).Milliseconds(),
	})
}

func (a *API) runDemo(ss Session) {
	ctx := a.ctx
	participants := map[string]string{}
	for _, dq := range demoQuestions {
		if ctx.Err() != nil {
			return
		}
		pid, ok := participants[dq.Student]
		if !ok {
			p, err := a.store.CreateParticipant(ctx, ss.ID, dq.Student+" (demo)")
			if err != nil {
				log.Printf("demo: create participant: %v", err)
				return
			}
			a.hub.Publish(ss.ID, "participant", p)
			pid = p.ID
			participants[dq.Student] = pid
		}
		q, created, err := a.store.InsertQuestion(ctx, ss.ID, pid, dq.Text, newUUID())
		if err != nil {
			log.Printf("demo: insert question: %v", err)
			return
		}
		if created {
			a.hub.Publish(ss.ID, "question", q)
			a.worker.Kick(ctx, ss.ID)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(demoSpacing):
		}
	}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
